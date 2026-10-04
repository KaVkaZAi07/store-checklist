// Shared Fetch handler; the Edge entrypoint supplies secrets through Deno.env.
// Unit tests inject fetch. No browser has access to this worker's service key.
const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_OWNER_CHAT_ID', 'CHECKLIST_CRON_SECRET'];

async function matchesSecret(actual, expected) {
  if (!actual || actual.length > 256) return false;
  const encode = (value) => new TextEncoder().encode(value);
  const [a, b] = await Promise.all([actual, expected].map((value) => crypto.subtle.digest('SHA-256', encode(value))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}

export function createNotificationHandler(env, fetchImpl = fetch) {
  return async function handle(request) {
    if (request.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    if (required.some((name) => !env[name]) || env.CHECKLIST_CRON_SECRET.length < 32) {
      return Response.json({ error: 'Notification worker is not configured' }, { status: 503 });
    }
    if (!await matchesSecret(request.headers.get('x-checklist-cron-secret'), env.CHECKLIST_CRON_SECRET)) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const rpc = async (name, body = {}) => {
      const response = await fetchImpl(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${name}`, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error('Notification database request failed');
      return response.json();
    };
    let jobs;
    try { jobs = await rpc('checklist_claim_notifications'); }
    catch { return Response.json({ error: 'Notification queue is unavailable' }, { status: 502 }); }
    if (!Array.isArray(jobs)) return Response.json({ error: 'Invalid notification queue response' }, { status: 502 });
    let delivered = 0, failed = 0;
    // Four concurrent sends keep 20 leased jobs within the three-minute lease.
    for (let offset = 0; offset < jobs.length; offset += 4) {
      await Promise.all(jobs.slice(offset, offset + 4).map(async (job) => {
        let sent = false;
        try {
          const message = String(job.message);
          const text = message.length > 4000 ? `${message.slice(0, 3950)}\n… Полный отчёт в приложении.` : message;
          const response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: env.TELEGRAM_OWNER_CHAT_ID, text })
          });
          const body = await response.json();
          sent = response.ok && body.ok === true;
        } catch { sent = false; }
        try {
          const acknowledged = await rpc('checklist_finish_notification', {
            p_id: job.id, p_claim_token: job.claimToken, p_sent: sent
          });
          if (sent && acknowledged) delivered++; else failed++;
        } catch { failed++; } // Lease expiry makes it available for retry.
      }));
    }
    return Response.json({ delivered, failed });
  };
}
