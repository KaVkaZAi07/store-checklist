import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../js/api.js', import.meta.url), 'utf8');
function setup(fetch) {
  const data = new Map();
  const localStorage = {
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: k => data.delete(k)
  };
  localStorage.setItem('checklist_session_v2', JSON.stringify({ token: 'test-token', expiresAt: '2099-01-01T00:00:00Z', user: { key: 'agnesa' } }));
  const context = vm.createContext({ CONFIG: { TIMEZONE: 'Europe/Moscow', SUPABASE_URL: 'https://test.invalid', SUPABASE_ANON_KEY: 'public' }, fetch, localStorage, navigator: { onLine: true }, crypto: webcrypto, AbortController, setTimeout, clearTimeout, Date, TypeError });
  vm.runInContext(source + '\nthis.api = API;', context);
  return { api: context.api, data, context };
}
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('failed HTTP or RPC mutation never claims success or changes cache', async () => {
  for (const result of [response({ message: 'DB unavailable' }, 503), response({ success: false, code: 'DENIED', error: 'Нет доступа' })]) {
    const { api, data } = setup(async () => result);
    const snapshot = JSON.stringify({ date: '2026-10-04', tasks: {}, customersLog: [] });
    data.set('checklist_v2_cache_agnesa_2026-10-04', snapshot);
    await assert.rejects(api.completeTask('forged name', 'm1', 'title', 'morning', '2026-10-04'));
    assert.equal(data.get('checklist_v2_cache_agnesa_2026-10-04'), snapshot);
  }
});

test('RPC carries session, action and expected date; never trusts employee or role', async () => {
  let captured;
  const { api } = setup(async (url, options) => { captured = { url, options, body: JSON.parse(options.body) }; return response({ success: true, date: '2026-10-04' }); });
  await api.completeTask('Владелец', 'm1', 'injected', 'evening', '2026-10-04');
  assert.equal(captured.body.p_action, 'complete_task');
  assert.equal(captured.body.p_payload.taskId, 'm1');
  assert.equal(captured.body.p_payload.date, '2026-10-04');
  assert.equal('employee' in captured.body.p_payload, false);
  assert.equal('Authorization' in captured.options.headers, false);
});

test('read fallback is explicitly stale and scoped to user/date', async () => {
  const { api, data } = setup(async () => { throw new TypeError('network'); });
  data.set('checklist_v2_cache_agnesa_2026-10-04', JSON.stringify({ date: '2026-10-04', tasks: {}, customersLog: [], lastSyncedAt: '2026-10-04T07:00:00Z' }));
  const result = await api.getDayData('2026-10-04');
  assert.equal(result.stale, true);
  assert.equal(result.source, 'cache');
  await assert.rejects(api.getDayData('2026-10-03'));
});

test('offline mutations are rejected without fetch', async () => {
  let called = false;
  const { api, context } = setup(async () => { called = true; });
  context.navigator.onLine = false;
  await assert.rejects(api.logWorkStatus('Агнесса', 'arrive'));
  assert.equal(called, false);
});

test('customer retry reuses operation UUID after a lost response', async () => {
  const ids = [];
  const { api } = setup(async (url, options) => {
    ids.push(JSON.parse(options.body).p_payload.eventId);
    if (ids.length === 1) throw new TypeError('lost response');
    return response({ success: true, date: '2026-10-04' });
  });
  await assert.rejects(api.logCustomersEvent('Агнесса', '2026-10-04'));
  await api.logCustomersEvent('Агнесса', '2026-10-04');
  await api.logCustomersEvent('Агнесса', '2026-10-04');
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[1], ids[2]);
});

test('expired or malformed session cannot read even a cached day', async () => {
  const { api, data } = setup(async () => assert.fail('must not fetch'));
  const session = JSON.parse(data.get('checklist_session_v2'));
  session.expiresAt = 'not-a-date';
  data.set('checklist_session_v2', JSON.stringify(session));
  data.set('checklist_v2_cache_agnesa_2026-10-04', JSON.stringify({ date: '2026-10-04', tasks: {}, customersLog: [] }));
  await assert.rejects(api.getDayData('2026-10-04'), { code: 'UNAUTHORIZED' });
});

test('late unauthorized response from an old login cannot delete a new session', async () => {
  let respond;
  const { api, data } = setup(() => new Promise(resolve => { respond = resolve; }));
  const request = api.getDayData('2026-10-04');
  const replacement = JSON.stringify({ token: 'new-token', expiresAt: '2099-01-01T00:00:00Z', user: { key: 'oksana' } });
  data.set('checklist_session_v2', replacement);
  respond(response({ success: false, code: 'UNAUTHORIZED', error: 'Expired' }));
  await assert.rejects(request, { code: 'SESSION_CHANGED' });
  assert.equal(data.get('checklist_session_v2'), replacement);
});

test('a page bound to the previous profile cannot submit using another session', async () => {
  const { api, data } = setup(async () => assert.fail('must not fetch'));
  api._boundToken = 'previous-token';
  await assert.rejects(api.completeTask('Агнесса', 'm1', '', '', '2026-10-04'), { code: 'SESSION_CHANGED' });
  assert.equal(JSON.parse(data.get('checklist_session_v2')).token, 'test-token');
});

test('a refreshed confirmed visit retires its retry ID before the next real visit', async () => {
  let pendingId;
  const ids = [];
  const { api } = setup(async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.p_action === 'get_day') return response({ success: true, date: '2026-10-04', tasks: {}, customersLog: [{ id: pendingId }] });
    const id = body.p_payload.eventId;
    ids.push(id);
    if (!pendingId) { pendingId = id; throw new TypeError('lost response'); }
    return response({ success: true, date: '2026-10-04', entry: { id } });
  });
  await assert.rejects(api.logCustomersEvent('Агнесса', '2026-10-04'));
  await api.getDayData('2026-10-04');
  await api.logCustomersEvent('Агнесса', '2026-10-04');
  assert.notEqual(ids[0], ids[1]);
});
