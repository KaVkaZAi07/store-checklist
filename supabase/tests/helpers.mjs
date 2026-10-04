import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile } from 'node:fs/promises';

export const migration = await readFile(new URL('../migration.sql', import.meta.url), 'utf8');

// Real PostgreSQL + pgcrypto. Nothing is sent to the production project.
export async function createTestDb({ legacy = false } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;');
  if (legacy) {
    await db.exec(`CREATE TABLE public.checklist_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), date date NOT NULL, employee text NOT NULL,
      task_id text NOT NULL, task_name text NOT NULL,
      section text NOT NULL CHECK(section IN ('morning','daytime','evening')),
      status text NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','failed')),
      is_late boolean NOT NULL DEFAULT false, reason text, time_str text NOT NULL,
      completed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(date,employee,task_id));
      INSERT INTO public.checklist_entries(date,employee,task_id,task_name,section,time_str)
      VALUES('2025-01-01','Агнесса','m1','Историческая задача','morning','09:00:00');
      ALTER TABLE public.checklist_entries ENABLE ROW LEVEL SECURITY;
      CREATE POLICY old_public_access ON public.checklist_entries TO anon USING(true) WITH CHECK(true);
      GRANT ALL ON public.checklist_entries TO anon,authenticated;`);
  }
  await db.exec(migration);
  const pins = {};
  for (const key of ['agnesa', 'oksana', 'owner']) {
    const { rows } = await db.query('SELECT checklist_private.provision_user($1) AS result', [key]);
    pins[key] = rows[0].result.pin;
  }
  const { rows } = await db.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS date");
  const today = rows[0].date;
  // Execute under exactly the API role, then restore privileged fixture connection.
  const rpc = async (name, parameters, role = 'anon') => db.transaction(async (tx) => {
    if (!['anon', 'authenticated', 'service_role'].includes(role)) throw new Error('Invalid test role');
    await tx.exec(`SET LOCAL ROLE ${role}`);
    const placeholders = parameters.map((_, i) => `$${i + 1}`).join(',');
    const { rows: results } = await tx.query(`SELECT public.${name}(${placeholders}) AS result`, parameters);
    return results[0].result;
  });
  const login = (key, pin = pins[key]) => rpc('checklist_login', [key, pin]);
  const request = (token, action, payload = {}) => rpc('checklist_request', [token, action, JSON.stringify({ date: today, ...payload })]);
  return { db, pins, today, rpc, login, request };
}
