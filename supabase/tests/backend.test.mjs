import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createTestDb, migration } from './helpers.mjs';

test('real SQL security, upgrade and employee workflows', async (t) => {
  const { db, pins, today, rpc, login, request } = await createTestDb({ legacy: true });
  t.after(() => db.close());
  let agnesa, oksana, owner;

  await t.test('upgrade preserves history, removes unsafe policies and is repeatable', async () => {
    await db.exec(migration);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM public.checklist_entries WHERE date='2025-01-01'")).rows[0].n, 1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename IN ('checklist_entries','checklist_customers_log')")).rows[0].n, 0);
    for (const role of ['anon', 'authenticated']) {
      for (const sql of ['SELECT * FROM public.checklist_entries', 'SELECT * FROM public.checklist_customers_log',
        'SELECT * FROM checklist_private.users', 'SELECT * FROM checklist_private.sessions',
        "SELECT checklist_private.provision_user('owner')", 'SELECT public.checklist_claim_notifications()',
        "INSERT INTO public.checklist_entries(date,employee,task_id,task_name,section,time_str) VALUES(current_date,'x','x','x','status','x')",
        'DELETE FROM public.checklist_entries']) {
        await assert.rejects(db.transaction(async (tx) => { await tx.exec(`SET LOCAL ROLE ${role}`); await tx.exec(sql); }), /permission denied/);
      }
    }
  });
  await t.test('server verifies PIN, hashes session token and returns authoritative role', async () => {
    assert.equal((await login('owner', '0000')).success, false);
    assert.equal((await login('nobody', '123456')).success, false);
    agnesa = await login('agnesa'); oksana = await login('oksana'); owner = await login('owner');
    assert.equal(agnesa.success, true); assert.equal(owner.user.role, 'admin'); assert.match(agnesa.token, /^[a-f0-9]{64}$/);
    const hashes = (await db.query('SELECT token_hash FROM checklist_private.sessions')).rows.map((r) => r.token_hash);
    assert.equal(hashes.includes(agnesa.token), false);
    assert.equal(hashes.includes(createHash('sha256').update(agnesa.token).digest('hex')), true);
    assert.equal((await request('0'.repeat(64), 'get_day')).code, 'UNAUTHORIZED');
    const stored = (await db.query("SELECT pin_hash FROM checklist_private.users WHERE user_key='agnesa'")).rows[0].pin_hash;
    assert.notEqual(stored, pins.agnesa); assert.match(stored, /^\$2[aby]\$10\$/);
  });
  await t.test('rate limit survives failed RPC transactions and blocks a valid PIN', async () => {
    for (let i = 0; i < 5; i++) await login('owner', 'wrong');
    assert.equal((await login('owner')).code, 'RATE_LIMITED');
    await db.exec("UPDATE checklist_private.users SET locked_until=now()-interval '1 second' WHERE user_key='owner'");
    assert.equal((await login('owner')).success, true);
  });
  await t.test('server ignores forged identity/time/task metadata, repeats safely and isolates employees', async () => {
    const payload = { taskId: 'm1', employee: 'Оксана', role: 'admin', taskName: 'forged', section: 'status', completedAt: '2000-01-01', isLate: false };
    const a = await request(agnesa.token, 'complete_task', payload);
    assert.equal(a.success, true); assert.equal(a.entry.employee, 'Агнесса'); assert.equal(a.entry.section, 'morning');
    assert.equal(a.entry.taskName, 'Открыть переднюю дверь магазина');
    assert.equal(new Date(a.entry.completedAt).getFullYear(), new Date().getFullYear());
    assert.equal((await request(agnesa.token, 'complete_task', payload)).entry.completedAt, a.entry.completedAt);
    assert.equal((await request(agnesa.token, 'complete_task', { taskId: 'unknown' })).code, 'INVALID_TASK');
    assert.equal((await request(agnesa.token, 'complete_task', { taskId: '_arrive' })).code, 'INVALID_TASK');
    assert.equal((await request(agnesa.token, 'complete_task', { taskId: 'm2', date: '2000-01-01' })).code, 'DATE_CHANGED');
    const b = await request(oksana.token, 'complete_task', { taskId: 'm1' }); assert.equal(b.success, true);
    const aDay = await request(agnesa.token, 'get_day', { role: 'admin' });
    assert.deepEqual(Object.keys(aDay.tasks), ['Агнесса_m1']);
    assert.equal(Object.keys((await request(owner.token, 'get_day')).tasks).length, 2);
    assert.equal((await request(owner.token, 'complete_task', { taskId: 'm2' })).code, 'FORBIDDEN');
    assert.equal((await request(agnesa.token, 'get_day', { date: '2026-02-31' })).code, 'INVALID_DATE');
  });
  await t.test('failure reason, undo limit and confirmation dependency are enforced', async () => {
    assert.equal((await request(agnesa.token, 'complete_task', { taskId: 'm9' })).code, 'SECTION_INCOMPLETE');
    assert.equal((await request(agnesa.token, 'fail_task', { taskId: 'm2', reason: ' ' })).code, 'INVALID_REASON');
    assert.equal((await request(agnesa.token, 'fail_task', { taskId: 'm2', reason: 'Не работает замок' })).success, true);
    assert.equal((await request(agnesa.token, 'complete_task', { taskId: 'm2' })).code, 'ALREADY_RECORDED');
    for (let i = 3; i <= 8; i++) assert.equal((await request(agnesa.token, 'complete_task', { taskId: `m${i}` })).success, true);
    assert.equal((await request(agnesa.token, 'complete_task', { taskId: 'm9' })).success, true);
    assert.equal((await request(agnesa.token, 'undo_task', { taskId: 'm3' })).code, 'SECTION_CONFIRMED');
    assert.equal((await request(agnesa.token, 'undo_task', { taskId: 'm9' })).success, true);
    assert.equal((await request(agnesa.token, 'undo_task', { taskId: 'm3' })).success, true);
    assert.equal((await request(agnesa.token, 'undo_task', { taskId: 'm3' })).success, true);
    await db.exec("UPDATE public.checklist_entries SET completed_at=now()-interval '61 seconds' WHERE employee='Агнесса' AND task_id='m1'");
    assert.equal((await request(agnesa.token, 'undo_task', { taskId: 'm1' })).code, 'UNDO_EXPIRED');
    await request(agnesa.token, 'complete_task', { taskId: 'm1' });
    assert.equal((await request(agnesa.token, 'undo_task', { taskId: 'm1' })).code, 'UNDO_EXPIRED');
  });
  await t.test('shift order and undo invariants persist on server', async () => {
    assert.equal((await request(agnesa.token, 'work_status', { status: 'leave' })).code, 'ARRIVAL_REQUIRED');
    const arrive = await request(agnesa.token, 'work_status', { status: 'arrive' });
    assert.equal(arrive.success, true); assert.equal(arrive.entry.section, 'status');
    assert.equal((await request(agnesa.token, 'work_status', { status: 'leave' })).success, true);
    assert.equal((await request(agnesa.token, 'undo_work_status', { status: 'arrive' })).code, 'LEAVE_EXISTS');
    assert.equal((await request(agnesa.token, 'undo_work_status', { status: 'leave' })).success, true);
    assert.equal((await request(agnesa.token, 'undo_work_status', { status: 'arrive' })).success, true);
  });
  await t.test('customer retry is idempotent, UUID cannot claim another employee event', async () => {
    const eventId = randomUUID();
    const a = await request(agnesa.token, 'log_customers', { eventId, employee: 'Оксана' });
    assert.equal(a.success, true); assert.equal(a.entry.employee, 'Агнесса');
    assert.deepEqual(await request(agnesa.token, 'log_customers', { eventId }), a);
    assert.equal((await request(oksana.token, 'log_customers', { eventId })).code, 'EVENT_CONFLICT');
    assert.equal((await request(agnesa.token, 'get_day')).customersLog.length, 1);
    assert.equal((await request(oksana.token, 'get_day')).customersLog.length, 0);
  });
  await t.test('transactional notifications can only be claimed by server; undo cancels queue', async () => {
    await request(agnesa.token, 'complete_task', { taskId: 'd1' });
    assert.deepEqual(await rpc('checklist_claim_notifications', [], 'service_role'), []);
    await request(agnesa.token, 'undo_task', { taskId: 'd1' });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM checklist_private.notification_outbox')).rows[0].n, 0);
    await request(agnesa.token, 'complete_task', { taskId: 'd1' });
    await db.exec("UPDATE checklist_private.notification_outbox SET available_at=now()-interval '1 second'");
    const claimed = await rpc('checklist_claim_notifications', [], 'service_role'); assert.equal(claimed.length, 1);
    assert.deepEqual(await rpc('checklist_claim_notifications', [], 'service_role'), []);
    assert.equal(await rpc('checklist_finish_notification', [claimed[0].id, randomUUID(), true], 'service_role'), false);
    assert.equal(await rpc('checklist_finish_notification', [claimed[0].id, claimed[0].claimToken, true], 'service_role'), true);
  });
  await t.test('expired/revoked sessions and PIN reset cannot be reused', async () => {
    await rpc('checklist_logout', [agnesa.token]);
    assert.equal((await request(agnesa.token, 'get_day')).code, 'UNAUTHORIZED');
    await db.exec("UPDATE checklist_private.sessions SET expires_at=now()-interval '1 second' WHERE user_key='oksana'");
    assert.equal((await request(oksana.token, 'get_day')).code, 'UNAUTHORIZED');
    await db.query("SELECT checklist_private.provision_user('owner')");
    assert.equal((await request(owner.token, 'get_day')).code, 'UNAUTHORIZED');
    assert.equal((await login('owner')).success, false);
  });
});
