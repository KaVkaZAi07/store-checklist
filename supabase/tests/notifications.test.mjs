import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationHandler } from '../functions/checklist-notify/handler.mjs';

const env = {
  SUPABASE_URL: 'https://example.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
  TELEGRAM_BOT_TOKEN: 'test-bot', TELEGRAM_OWNER_CHAT_ID: 'test-chat', CHECKLIST_CRON_SECRET: 'test-secret-for-scheduler-32-characters'
};
const request = (secret = env.CHECKLIST_CRON_SECRET) => new Request('https://worker.invalid', {
  method: 'POST', headers: { 'x-checklist-cron-secret': secret }
});

test('notification worker refuses missing secrets and unauthorized clients before any network I/O', async () => {
  const noFetch = async () => assert.fail('Unexpected network request');
  assert.equal((await createNotificationHandler({}, noFetch)(request())).status, 503);
  const handler = createNotificationHandler(env, noFetch);
  assert.equal((await handler(request('wrong'))).status, 401);
  assert.equal((await handler(new Request('https://worker.invalid'))).status, 405);
});

test('notification worker sends plaintext and acknowledges successful delivery', async () => {
  const calls = [];
  const handler = createNotificationHandler(env, async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    if (url.endsWith('checklist_claim_notifications')) return Response.json([{ id: 'id', claimToken: 'lease', message: '<b>Причина</b>' }]);
    if (url.includes('telegram.org')) return Response.json({ ok: true });
    if (url.endsWith('checklist_finish_notification')) return Response.json(true);
    assert.fail('Unexpected URL');
  });
  assert.deepEqual(await (await handler(request())).json(), { delivered: 1, failed: 0 });
  assert.equal(calls[1][1].text, '<b>Причина</b>'); assert.equal(calls[1][1].parse_mode, undefined);
  assert.deepEqual(calls[2][1], { p_id: 'id', p_claim_token: 'lease', p_sent: true });
});

test('Telegram failure remains retryable, and long reports are bounded', async () => {
  let ack;
  const handler = createNotificationHandler(env, async (url, options) => {
    if (url.endsWith('checklist_claim_notifications')) return Response.json([{ id: 'id', claimToken: 'lease', message: 'X'.repeat(6000) }]);
    if (url.includes('telegram.org')) {
      assert.ok(JSON.parse(options.body).text.length <= 4096);
      return Response.json({ ok: false }, { status: 429 });
    }
    ack = JSON.parse(options.body); return Response.json(true);
  });
  assert.deepEqual(await (await handler(request())).json(), { delivered: 0, failed: 1 });
  assert.equal(ack.p_sent, false);
});
