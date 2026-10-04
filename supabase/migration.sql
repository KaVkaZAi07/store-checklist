-- Установка ИЛИ обновление старой схемы без потери записей. Выполнить целиком от postgres.
-- После установки provision_user создаёт новые PIN: см. README.md. Старых PIN здесь нет.
BEGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA IF NOT EXISTS checklist_private;
REVOKE ALL ON SCHEMA checklist_private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.checklist_entries (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), date date NOT NULL, employee text NOT NULL,
 task_id text NOT NULL, task_name text NOT NULL,
 section text NOT NULL CHECK (section IN ('morning','daytime','evening','status')),
 status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','failed')),
 is_late boolean NOT NULL DEFAULT false, reason text, time_str text NOT NULL,
 completed_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(date,employee,task_id)
);
-- Старый CHECK запрещал сохранение прихода/ухода. Заменяется только этот CHECK.
ALTER TABLE public.checklist_entries DROP CONSTRAINT IF EXISTS checklist_entries_section_check;
ALTER TABLE public.checklist_entries ADD CONSTRAINT checklist_entries_section_check
 CHECK (section IN ('morning','daytime','evening','status'));
CREATE TABLE IF NOT EXISTS public.checklist_customers_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), date date NOT NULL, employee text NOT NULL,
 event_time timestamptz NOT NULL DEFAULT now(), time_str text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checklist_entries_date ON public.checklist_entries(date);
CREATE INDEX IF NOT EXISTS idx_checklist_entries_date_employee ON public.checklist_entries(date,employee);
CREATE INDEX IF NOT EXISTS idx_checklist_customers_log_date ON public.checklist_customers_log(date);
ALTER TABLE public.checklist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.checklist_customers_log ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE p record; BEGIN
 FOR p IN SELECT schemaname,tablename,policyname FROM pg_policies
  WHERE schemaname='public' AND tablename IN ('checklist_entries','checklist_customers_log')
 LOOP EXECUTE format('DROP POLICY %I ON %I.%I',p.policyname,p.schemaname,p.tablename); END LOOP;
END $$;
REVOKE ALL ON public.checklist_entries,public.checklist_customers_log FROM PUBLIC,anon,authenticated;

CREATE TABLE IF NOT EXISTS checklist_private.users (
 user_key text PRIMARY KEY, name text UNIQUE NOT NULL, role text NOT NULL CHECK(role IN ('employee','admin')),
 pin_hash text, enabled boolean NOT NULL DEFAULT true, failed_attempts integer NOT NULL DEFAULT 0, locked_until timestamptz
);
INSERT INTO checklist_private.users(user_key,name,role) VALUES
 ('agnesa','Агнесса','employee'),('oksana','Оксана','employee'),('owner','Владелец','admin')
ON CONFLICT(user_key) DO NOTHING;
CREATE TABLE IF NOT EXISTS checklist_private.sessions (
 token_hash text PRIMARY KEY, user_key text NOT NULL REFERENCES checklist_private.users(user_key) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checklist_sessions_user ON checklist_private.sessions(user_key);
CREATE INDEX IF NOT EXISTS checklist_sessions_expiry ON checklist_private.sessions(expires_at);
CREATE TABLE IF NOT EXISTS checklist_private.catalog (
 task_id text PRIMARY KEY, task_name text NOT NULL, section text NOT NULL, deadline time,
 confirmation boolean NOT NULL DEFAULT false
);
INSERT INTO checklist_private.catalog(task_id,task_name,section,deadline,confirmation) VALUES
 ('m1','Открыть переднюю дверь магазина','morning','10:00',false),
 ('m2','Открыть заднюю дверь магазина','morning','10:00',false),
 ('m3','Конфетница наполнена минимум на половину','morning','10:00',false),
 ('m4','Убрать зарядку, блок питания и провод от колонки','morning','10:00',false),
 ('m5','Проверить, чтобы возле телевизора не было лишних проводов','morning','10:00',false),
 ('m6','Включить телевизор','morning','10:00',false),
 ('m7','Подключить колонку по Bluetooth','morning','10:00',false),
 ('m8','Включить музыку','morning','10:00',false),
 ('m9','Отправить / подтвердить утренний чек-лист до 10:00','morning','10:00',true),
 ('d1','При входе покупателей убрать телефоны','daytime',null,false),
 ('d2','При входе покупателей быть внимательными к людям в магазине','daytime',null,false),
 ('e1','Поставить реакции на посты в Instagram','evening','20:00',false),
 ('e2','Поставить реакции на посты в Telegram','evening','20:00',false),
 ('e3','Поставить реакции на посты в WhatsApp','evening','20:00',false),
 ('e4','Выключить телевизор','evening','20:00',false),
 ('e5','Выключить весь свет','evening','20:00',false),
 ('e6','Проверить санузел','evening','20:00',false),
 ('e7','Проверить магазин перед уходом','evening','20:00',false),
 ('e8','Отправить / подтвердить вечерний чек-лист до 20:00','evening','20:00',true),
 ('_arrive','Я на работе','status',null,false),('_leave','Ушла с работы','status',null,false)
ON CONFLICT(task_id) DO UPDATE SET task_name=excluded.task_name,section=excluded.section,
 deadline=excluded.deadline,confirmation=excluded.confirmation;

-- Очередь фиксируется в одной транзакции с записью. Отправка отдельным worker после окна отмены.
CREATE TABLE IF NOT EXISTS checklist_private.notification_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entry_id uuid UNIQUE NOT NULL, message text NOT NULL,
 available_at timestamptz NOT NULL DEFAULT(now()+interval '65 seconds'), claimed_until timestamptz,
 claim_token uuid, attempts integer NOT NULL DEFAULT 0, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS checklist_outbox_pending ON checklist_private.notification_outbox(available_at) WHERE sent_at IS NULL;
ALTER TABLE checklist_private.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_private.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_private.catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE checklist_private.notification_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA checklist_private FROM PUBLIC,anon,authenticated;

-- У существующего проекта pgcrypto может находиться в другой схеме: не переносим расширение.
DO $migration$ DECLARE crypto_schema text; BEGIN
 SELECT n.nspname INTO crypto_schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pgcrypto';
 EXECUTE format($sql$ CREATE OR REPLACE FUNCTION checklist_private.hash_pin(pin text) RETURNS text
  LANGUAGE sql VOLATILE SET search_path='' AS 'SELECT %I.crypt(pin, %I.gen_salt(''bf'',10))'; $sql$,crypto_schema,crypto_schema);
 EXECUTE format($sql$ CREATE OR REPLACE FUNCTION checklist_private.check_pin(pin text,hash text) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path='' AS 'SELECT %I.crypt(pin,hash)=hash'; $sql$,crypto_schema);
 EXECUTE format($sql$ CREATE OR REPLACE FUNCTION checklist_private.random_bytes(n integer) RETURNS bytea
  LANGUAGE sql VOLATILE SET search_path='' AS 'SELECT %I.gen_random_bytes(n)'; $sql$,crypto_schema);
END $migration$;
CREATE OR REPLACE FUNCTION checklist_private.entry_json(e public.checklist_entries) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path='' AS $$
 SELECT jsonb_build_object('employee',e.employee,'completedAt',e.completed_at,'isLate',e.is_late,
  'isFailed',e.status='failed','reason',e.reason,'timeStr',e.time_str,'section',e.section,'taskName',e.task_name)
$$;
-- Только оператор SQL Editor. Новый случайный PIN возвращается один раз, в БД хранится bcrypt.
CREATE OR REPLACE FUNCTION checklist_private.provision_user(p_user_key text) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v_pin text:=''; b bytea; digit integer; u checklist_private.users;
BEGIN
 SELECT * INTO u FROM checklist_private.users WHERE user_key=p_user_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown checklist user'; END IF;
 WHILE length(v_pin)<8 LOOP
  b:=checklist_private.random_bytes(1); digit:=get_byte(b,0);
  IF digit<250 THEN v_pin:=v_pin||(digit%10)::text; END IF;
 END LOOP;
 UPDATE checklist_private.users SET pin_hash=checklist_private.hash_pin(v_pin),failed_attempts=0,locked_until=null,enabled=true WHERE user_key=p_user_key;
 DELETE FROM checklist_private.sessions WHERE user_key=p_user_key;
 RETURN jsonb_build_object('key',u.user_key,'name',u.name,'pin',v_pin);
END $$;
CREATE OR REPLACE FUNCTION checklist_private.login(p_user_key text,p_pin text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u checklist_private.users; v_now timestamptz; v_token text; v_expires timestamptz; v_attempts integer;
BEGIN
 IF p_user_key IS NULL OR length(p_user_key)>40 OR p_pin IS NULL OR length(p_pin)>12 THEN
  RETURN jsonb_build_object('success',false,'code','INVALID_CREDENTIALS','error','Неверный пользователь или PIN');
 END IF;
 SELECT * INTO u FROM checklist_private.users WHERE user_key=p_user_key FOR UPDATE;
 v_now:=clock_timestamp();
 IF NOT FOUND OR NOT u.enabled OR u.pin_hash IS NULL THEN
  RETURN jsonb_build_object('success',false,'code','INVALID_CREDENTIALS','error','Неверный пользователь или PIN');
 END IF;
 IF u.locked_until>v_now THEN
  RETURN jsonb_build_object('success',false,'code','RATE_LIMITED','error','Слишком много попыток. Повторите позже.',
   'retryAfter',ceil(extract(epoch FROM(u.locked_until-v_now)))::integer);
 END IF;
 IF p_pin !~ '^[0-9]{6,12}$' OR NOT checklist_private.check_pin(p_pin,u.pin_hash) THEN
  v_attempts:=CASE WHEN u.locked_until IS NOT NULL THEN 1 ELSE u.failed_attempts+1 END;
  UPDATE checklist_private.users SET failed_attempts=v_attempts,
   locked_until=CASE WHEN v_attempts>=5 THEN v_now+interval '15 minutes' ELSE null END WHERE user_key=u.user_key;
  RETURN jsonb_build_object('success',false,'code',CASE WHEN v_attempts>=5 THEN 'RATE_LIMITED' ELSE 'INVALID_CREDENTIALS' END,
   'error',CASE WHEN v_attempts>=5 THEN 'Слишком много попыток. Повторите через 15 минут.' ELSE 'Неверный пользователь или PIN' END,
   'retryAfter',CASE WHEN v_attempts>=5 THEN 900 ELSE 0 END);
 END IF;
 UPDATE checklist_private.users SET failed_attempts=0,locked_until=null WHERE user_key=u.user_key;
 DELETE FROM checklist_private.sessions WHERE expires_at<v_now;
 v_token:=encode(checklist_private.random_bytes(32),'hex'); v_expires:=v_now+interval '12 hours';
 INSERT INTO checklist_private.sessions(token_hash,user_key,expires_at)
  VALUES(encode(sha256(convert_to(v_token,'UTF8')),'hex'),u.user_key,v_expires);
 RETURN jsonb_build_object('success',true,'token',v_token,'expiresAt',v_expires,
  'user',jsonb_build_object('key',u.user_key,'name',u.name,'role',u.role));
END $$;
CREATE OR REPLACE FUNCTION checklist_private.logout(p_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF p_token IS NOT NULL AND length(p_token)=64 THEN
  DELETE FROM checklist_private.sessions WHERE token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex');
 END IF;
 RETURN jsonb_build_object('success',true);
END $$;
CREATE OR REPLACE FUNCTION checklist_private.request(p_token text,p_action text,p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 u checklist_private.users; v_now timestamptz; v_local timestamp; v_date date; v_read_date date;
 v_task_id text; c checklist_private.catalog; e public.checklist_entries; customer public.checklist_customers_log;
 v_tasks jsonb; v_customers jsonb; v_reason text; v_status text; v_event uuid;
 v_message text; v_failed integer; v_total integer;
BEGIN
 IF p_token IS NULL OR p_token !~ '^[a-f0-9]{64}$' THEN
  RETURN jsonb_build_object('success',false,'code','UNAUTHORIZED','error','Войдите заново');
 END IF;
 -- Сериализуем запросы одного сотрудника: параллельные клики не обходят проверки.
 SELECT us.* INTO u FROM checklist_private.users us JOIN checklist_private.sessions s USING(user_key)
  WHERE s.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')
   AND s.expires_at>clock_timestamp() AND us.enabled FOR UPDATE OF us;
 IF NOT FOUND THEN RETURN jsonb_build_object('success',false,'code','UNAUTHORIZED','error','Сессия истекла. Войдите заново'); END IF;
 -- Повторная проверка после ожидания блокировки: сессию могли отозвать/она могла истечь.
 IF NOT EXISTS(SELECT 1 FROM checklist_private.sessions WHERE
  token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') AND expires_at>clock_timestamp()) THEN
  RETURN jsonb_build_object('success',false,'code','UNAUTHORIZED','error','Сессия истекла. Войдите заново');
 END IF;
 v_now:=clock_timestamp(); v_local:=v_now AT TIME ZONE 'Europe/Moscow'; v_date:=v_local::date;
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>8192 THEN
  RETURN jsonb_build_object('success',false,'code','INVALID_PAYLOAD','error','Некорректные данные запроса');
 END IF;
 IF p_action='get_day' THEN
  IF coalesce(p_payload->>'date','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
   RETURN jsonb_build_object('success',false,'code','INVALID_DATE','error','Некорректная дата');
  END IF;
  BEGIN v_read_date:=(p_payload->>'date')::date;
  EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
   RETURN jsonb_build_object('success',false,'code','INVALID_DATE','error','Некорректная дата');
  END;
  SELECT coalesce(jsonb_object_agg(e1.employee||'_'||e1.task_id,checklist_private.entry_json(e1)),'{}'::jsonb)
   INTO v_tasks FROM public.checklist_entries e1 WHERE e1.date=v_read_date AND(u.role='admin' OR e1.employee=u.name);
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',l.id,'employee',l.employee,'timestamp',l.event_time,'timeStr',l.time_str)
   ORDER BY l.event_time,l.id),'[]'::jsonb) INTO v_customers FROM public.checklist_customers_log l
   WHERE l.date=v_read_date AND(u.role='admin' OR l.employee=u.name);
  RETURN jsonb_build_object('success',true,'date',v_read_date,'tasks',v_tasks,'customersLog',v_customers,'serverTime',v_now);
 END IF;
 IF u.role<>'employee' THEN RETURN jsonb_build_object('success',false,'code','FORBIDDEN','error','Владелец просматривает отчёты; отметки делает сотрудник'); END IF;
 IF p_action IS NULL OR p_action NOT IN ('complete_task','fail_task','undo_task','work_status','undo_work_status','log_customers') THEN
  RETURN jsonb_build_object('success',false,'code','INVALID_ACTION','error','Неизвестное действие');
 END IF;
 IF(p_payload->>'date') IS DISTINCT FROM to_char(v_date,'YYYY-MM-DD') THEN
  RETURN jsonb_build_object('success',false,'code','DATE_CHANGED','error','Дата изменилась. Обновите данные за сегодня.','date',v_date);
 END IF;
 IF p_action='log_customers' THEN
  IF coalesce(p_payload->>'eventId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   RETURN jsonb_build_object('success',false,'code','INVALID_EVENT','error','Некорректный идентификатор посещения');
  END IF;
  v_event:=(p_payload->>'eventId')::uuid;
  INSERT INTO public.checklist_customers_log(id,date,employee,event_time,time_str)
   VALUES(v_event,v_date,u.name,v_now,to_char(v_local,'HH24:MI:SS')) ON CONFLICT(id) DO NOTHING;
  SELECT * INTO customer FROM public.checklist_customers_log WHERE id=v_event;
  IF customer.employee<>u.name OR customer.date<>v_date THEN
   RETURN jsonb_build_object('success',false,'code','EVENT_CONFLICT','error','Идентификатор посещения уже использован');
  END IF;
  RETURN jsonb_build_object('success',true,'date',customer.date,'timeStr',customer.time_str,
   'entry',jsonb_build_object('id',customer.id,'employee',customer.employee,'timestamp',customer.event_time,'timeStr',customer.time_str));
 END IF;
 IF p_action IN ('work_status','undo_work_status') THEN
  IF coalesce(p_payload->>'status','') NOT IN ('arrive','leave') THEN
   RETURN jsonb_build_object('success',false,'code','INVALID_STATUS','error','Неизвестная отметка смены');
  END IF;
  v_task_id:=CASE WHEN p_payload->>'status'='arrive' THEN '_arrive' ELSE '_leave' END;
 ELSE v_task_id:=p_payload->>'taskId'; END IF;
 SELECT * INTO c FROM checklist_private.catalog WHERE task_id=v_task_id;
 IF NOT FOUND OR(c.section='status' AND p_action NOT IN ('work_status','undo_work_status')) THEN
  RETURN jsonb_build_object('success',false,'code','INVALID_TASK','error','Неизвестная задача');
 END IF;
 SELECT * INTO e FROM public.checklist_entries WHERE date=v_date AND employee=u.name AND task_id=v_task_id;
 IF p_action IN ('undo_task','undo_work_status') THEN
  IF e.id IS NULL THEN RETURN jsonb_build_object('success',true,'date',v_date,'entry',null); END IF;
  IF v_now-e.completed_at>interval '60 seconds' OR e.completed_at>v_now THEN
   RETURN jsonb_build_object('success',false,'code','UNDO_EXPIRED','error','Отмена доступна в течение 60 секунд после отметки');
  END IF;
  IF v_task_id='_arrive' AND EXISTS(SELECT 1 FROM public.checklist_entries WHERE date=v_date AND employee=u.name AND task_id='_leave') THEN
   RETURN jsonb_build_object('success',false,'code','LEAVE_EXISTS','error','Сначала отмените отметку ухода');
  END IF;
  IF c.section IN ('morning','evening') AND NOT c.confirmation AND EXISTS(
   SELECT 1 FROM public.checklist_entries x JOIN checklist_private.catalog ct USING(task_id)
   WHERE x.date=v_date AND x.employee=u.name AND ct.section=c.section AND ct.confirmation) THEN
   RETURN jsonb_build_object('success',false,'code','SECTION_CONFIRMED','error','Сначала отмените подтверждение чек-листа');
  END IF;
  DELETE FROM public.checklist_entries WHERE id=e.id;
  DELETE FROM checklist_private.notification_outbox WHERE entry_id=e.id AND sent_at IS NULL;
  RETURN jsonb_build_object('success',true,'date',v_date,'entry',null);
 END IF;
 v_status:=CASE WHEN p_action='fail_task' THEN 'failed' ELSE 'completed' END;
 v_reason:=CASE WHEN p_action='fail_task' THEN btrim(p_payload->>'reason') ELSE null END;
 IF p_action='fail_task' AND(coalesce(length(v_reason),0)<3 OR length(v_reason)>500) THEN
  RETURN jsonb_build_object('success',false,'code','INVALID_REASON','error','Укажите причину длиной от 3 до 500 символов');
 END IF;
 -- Повтор возвращает первоначальную отметку, не меняя время и окно отмены.
 IF e.id IS NOT NULL THEN
  IF e.status<>v_status OR e.reason IS DISTINCT FROM v_reason THEN
   RETURN jsonb_build_object('success',false,'code','ALREADY_RECORDED','error','Отметка уже сохранена. Для изменения сначала отмените её.');
  END IF;
  RETURN jsonb_build_object('success',true,'date',v_date,'entry',checklist_private.entry_json(e),'timeStr',e.time_str,'isLate',e.is_late);
 END IF;
 IF v_task_id='_leave' AND NOT EXISTS(SELECT 1 FROM public.checklist_entries WHERE date=v_date AND employee=u.name AND task_id='_arrive') THEN
  RETURN jsonb_build_object('success',false,'code','ARRIVAL_REQUIRED','error','Сначала отметьте приход на работу');
 END IF;
 IF c.confirmation AND EXISTS(SELECT 1 FROM checklist_private.catalog ct WHERE ct.section=c.section AND NOT ct.confirmation
  AND NOT EXISTS(SELECT 1 FROM public.checklist_entries x WHERE x.date=v_date AND x.employee=u.name AND x.task_id=ct.task_id)) THEN
  RETURN jsonb_build_object('success',false,'code','SECTION_INCOMPLETE','error','Сначала отметьте все предыдущие пункты чек-листа');
 END IF;
 INSERT INTO public.checklist_entries(date,employee,task_id,task_name,section,status,is_late,reason,time_str,completed_at)
  VALUES(v_date,u.name,c.task_id,c.task_name,c.section,v_status,
   coalesce(v_local::time>=c.deadline,false),v_reason,to_char(v_local,'HH24:MI:SS'),v_now)
  ON CONFLICT(date,employee,task_id) DO NOTHING RETURNING * INTO e;
 IF e.id IS NULL THEN SELECT * INTO e FROM public.checklist_entries WHERE date=v_date AND employee=u.name AND task_id=v_task_id; END IF;
 IF c.confirmation THEN
  SELECT count(*),count(*) FILTER(WHERE status='failed') INTO v_total,v_failed FROM public.checklist_entries
   WHERE date=v_date AND employee=u.name AND section=c.section;
  v_message:=CASE WHEN c.section='morning' THEN 'Утренний' ELSE 'Вечерний' END||' чек-лист: '||u.name||E'\n'||
   to_char(v_date,'DD.MM.YYYY')||' '||e.time_str||E'\nВыполнено: '||(v_total-v_failed)||', не выполнено: '||v_failed;
  IF v_failed>0 THEN
   SELECT v_message||E'\n'||string_agg('• '||task_name||': '||coalesce(reason,'—'),E'\n' ORDER BY task_id)
    INTO v_message FROM public.checklist_entries WHERE date=v_date AND employee=u.name AND section=c.section AND status='failed';
  END IF;
 ELSIF c.section IN ('status','daytime') THEN
  v_message:=u.name||': '||c.task_name||E'\n'||to_char(v_date,'DD.MM.YYYY')||' '||e.time_str||
   CASE WHEN v_status='failed' THEN E'\nНе выполнено: '||v_reason ELSE '' END;
 END IF;
 IF v_message IS NOT NULL THEN
  INSERT INTO checklist_private.notification_outbox(entry_id,message,available_at)
   VALUES(e.id,v_message,v_now+interval '65 seconds') ON CONFLICT(entry_id) DO NOTHING;
 END IF;
 RETURN jsonb_build_object('success',true,'date',v_date,'entry',checklist_private.entry_json(e),'timeStr',e.time_str,'isLate',e.is_late);
END $$;

-- Публичные обёртки не повышают привилегии; PIN/сессия проверяются внутри закрытой схемы.
CREATE OR REPLACE FUNCTION public.checklist_login(p_user_key text,p_pin text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT checklist_private.login(p_user_key,p_pin) $$;
CREATE OR REPLACE FUNCTION public.checklist_request(p_token text,p_action text,p_payload jsonb DEFAULT '{}'::jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT checklist_private.request(p_token,p_action,p_payload) $$;
CREATE OR REPLACE FUNCTION public.checklist_logout(p_token text) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT checklist_private.logout(p_token) $$;

CREATE OR REPLACE FUNCTION checklist_private.claim_notifications() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 WITH pending AS (
  SELECT id FROM checklist_private.notification_outbox WHERE sent_at IS NULL AND available_at<=clock_timestamp()
   AND(claimed_until IS NULL OR claimed_until<clock_timestamp()) AND attempts<10
  ORDER BY available_at LIMIT 20 FOR UPDATE SKIP LOCKED
 ),claimed AS (
  UPDATE checklist_private.notification_outbox o SET claimed_until=clock_timestamp()+interval '3 minutes',
   claim_token=gen_random_uuid(),attempts=attempts+1 FROM pending WHERE o.id=pending.id RETURNING o.*
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'message',message,'claimToken',claim_token)),'[]'::jsonb) INTO result FROM claimed;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION checklist_private.finish_notification(p_id uuid,p_claim_token uuid,p_sent boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE checklist_private.notification_outbox SET sent_at=CASE WHEN p_sent THEN clock_timestamp() ELSE null END,
  claimed_until=null,claim_token=null,available_at=clock_timestamp()+interval '5 minutes'
  WHERE id=p_id AND claim_token=p_claim_token AND sent_at IS NULL;
 RETURN FOUND;
END $$;
CREATE OR REPLACE FUNCTION public.checklist_claim_notifications() RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT checklist_private.claim_notifications() $$;
CREATE OR REPLACE FUNCTION public.checklist_finish_notification(p_id uuid,p_claim_token uuid,p_sent boolean) RETURNS boolean
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT checklist_private.finish_notification(p_id,p_claim_token,p_sent) $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA checklist_private FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.checklist_login(text,text),public.checklist_request(text,text,jsonb),public.checklist_logout(text),
 public.checklist_claim_notifications(),public.checklist_finish_notification(uuid,uuid,boolean) FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA checklist_private TO anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION checklist_private.login(text,text),checklist_private.request(text,text,jsonb),checklist_private.logout(text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION public.checklist_login(text,text),public.checklist_request(text,text,jsonb),public.checklist_logout(text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION checklist_private.claim_notifications(),checklist_private.finish_notification(uuid,uuid,boolean),
 public.checklist_claim_notifications(),public.checklist_finish_notification(uuid,uuid,boolean) TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA checklist_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
NOTIFY pgrst,'reload schema';
COMMIT;
