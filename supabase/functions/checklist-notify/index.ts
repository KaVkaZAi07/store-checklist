import { createNotificationHandler } from './handler.mjs';

Deno.serve(createNotificationHandler({
  SUPABASE_URL: Deno.env.get('SUPABASE_URL'),
  SUPABASE_SERVICE_ROLE_KEY: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  TELEGRAM_BOT_TOKEN: Deno.env.get('TELEGRAM_BOT_TOKEN'),
  TELEGRAM_OWNER_CHAT_ID: Deno.env.get('TELEGRAM_OWNER_CHAT_ID'),
  CHECKLIST_CRON_SECRET: Deno.env.get('CHECKLIST_CRON_SECRET')
}));
