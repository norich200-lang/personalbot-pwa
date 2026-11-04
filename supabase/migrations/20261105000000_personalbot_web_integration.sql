-- Link Supabase Auth users to existing Telegram-owned PersonalBot accounts.
-- Existing tasks and app_users rows are deliberately left untouched.

create table if not exists personal_bot.web_accounts (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  owner_id uuid not null unique references personal_bot.app_users(id) on delete cascade,
  linked_at timestamptz not null default now()
);

create table if not exists personal_bot.web_link_codes (
  code_hash text primary key,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists web_link_codes_user_expiry_idx
  on personal_bot.web_link_codes (auth_user_id, expires_at desc);

create table if not exists personal_bot.webhook_receipts (
  telegram_update_id bigint primary key,
  telegram_user_id bigint,
  created_at timestamptz not null default now()
);

alter table personal_bot.web_accounts enable row level security;
alter table personal_bot.web_link_codes enable row level security;
alter table personal_bot.webhook_receipts enable row level security;

revoke all on personal_bot.web_accounts from public, anon, authenticated;
revoke all on personal_bot.web_link_codes from public, anon, authenticated;
revoke all on personal_bot.webhook_receipts from public, anon, authenticated;
grant select, insert, update, delete on personal_bot.web_accounts to service_role;
grant select, insert, update, delete on personal_bot.web_link_codes to service_role;
grant select, insert, update, delete on personal_bot.webhook_receipts to service_role;

create or replace function public.personalbot_api(
  p_action text,
  p_auth_user_id uuid default null,
  p_telegram_user_id bigint default null,
  p_code_hash text default null,
  p_task jsonb default null,
  p_tasks jsonb default null,
  p_task_id uuid default null,
  p_task_number integer default null,
  p_update_id bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, personal_bot, public
as $function$
declare
  v_owner_id uuid;
  v_auth_user_id uuid;
  v_task_id uuid;
  v_new_id uuid;
  v_title text;
  v_status text;
  v_created_at timestamptz;
  v_task jsonb;
  v_tasks jsonb;
  v_mapping jsonb := '[]'::jsonb;
  v_imported integer := 0;
  v_rows integer := 0;
  v_item jsonb;
begin
  if p_action = 'claim_telegram_update' then
    if p_update_id is null then
      return jsonb_build_object('ok', false, 'error', 'missing_update_id');
    end if;
    insert into personal_bot.webhook_receipts (telegram_update_id, telegram_user_id)
    values (p_update_id, p_telegram_user_id)
    on conflict (telegram_update_id) do nothing;
    get diagnostics v_rows = row_count;
    return jsonb_build_object('claimed', v_rows = 1);
  end if;

  if p_action = 'claim_link_code' then
    if p_code_hash is null or p_telegram_user_id is null then
      return jsonb_build_object('ok', false, 'error', 'invalid_code');
    end if;
    select auth_user_id into v_auth_user_id
    from personal_bot.web_link_codes
    where code_hash = p_code_hash and used_at is null and expires_at > now()
    for update;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'invalid_or_expired');
    end if;
    select id into v_owner_id
    from personal_bot.app_users
    where telegram_user_id = p_telegram_user_id and is_active = true;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'telegram_account_not_allowed');
    end if;
    begin
      insert into personal_bot.web_accounts (auth_user_id, owner_id)
      values (v_auth_user_id, v_owner_id);
    exception when unique_violation then
      return jsonb_build_object('ok', false, 'error', 'already_linked');
    end;
    update personal_bot.web_link_codes set used_at = now() where code_hash = p_code_hash;
    return jsonb_build_object('ok', true, 'error', null);
  end if;

  if p_action in ('telegram_tasks', 'telegram_add', 'telegram_done', 'telegram_archive') then
    if p_telegram_user_id is null then
      return jsonb_build_object('ok', false, 'error', 'unauthorized');
    end if;
    select id into v_owner_id
    from personal_bot.app_users
    where telegram_user_id = p_telegram_user_id and is_active = true;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'unauthorized');
    end if;
  else
    if p_auth_user_id is null then
      return jsonb_build_object('ok', false, 'error', 'unauthorized');
    end if;
    select owner_id into v_owner_id
    from personal_bot.web_accounts where auth_user_id = p_auth_user_id;
    if p_action not in ('create_link_code', 'linked') and not found then
      return jsonb_build_object('ok', false, 'error', 'not_linked');
    end if;
  end if;

  case p_action
    when 'linked' then
      return jsonb_build_object('linked', v_owner_id is not null);

    when 'create_link_code' then
      if v_owner_id is not null then
        return jsonb_build_object('ok', false, 'error', 'already_linked');
      end if;
      if p_code_hash is null then
        return jsonb_build_object('ok', false, 'error', 'invalid_code');
      end if;
      delete from personal_bot.web_link_codes where auth_user_id = p_auth_user_id;
      insert into personal_bot.web_link_codes (code_hash, auth_user_id, expires_at)
      values (p_code_hash, p_auth_user_id, now() + interval '10 minutes');
      return jsonb_build_object('ok', true, 'expires_in_seconds', 600);

    when 'list_tasks', 'telegram_tasks' then
      select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb)
        into v_tasks
      from (
        select id, title, description, status, importance, urgency,
               created_at, updated_at, completed_at, archived_at, due_at
        from personal_bot.tasks
        where owner_id = v_owner_id and archived_at is null
          and (p_action <> 'telegram_tasks' or status = 'open')
        order by created_at desc
        limit 200
      ) t;
      return jsonb_build_object('tasks', v_tasks);

    when 'create_task', 'telegram_add' then
      v_title := trim(coalesce(p_task->>'title', ''));
      if v_title = '' or length(v_title) > 200 then
        return jsonb_build_object('ok', false, 'error', 'invalid_title');
      end if;
      if p_task ? 'id' and (p_task->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_task_id := (p_task->>'id')::uuid;
      else
        v_task_id := gen_random_uuid();
      end if;
      v_status := case when p_task->>'status' = 'completed' then 'completed' else 'open' end;
      begin
        if p_task ? 'created_at' then
          begin
            v_created_at := (p_task->>'created_at')::timestamptz;
          exception when others then
            v_created_at := now();
          end;
        else
          v_created_at := now();
        end if;
        insert into personal_bot.tasks as inserted_task (id, owner_id, title, description, status, created_at, completed_at)
        values (v_task_id, v_owner_id, v_title, nullif(p_task->>'description', ''), v_status,
                coalesce(v_created_at, now()), case when v_status = 'completed' then coalesce(v_created_at, now()) else null end)
        returning to_jsonb(inserted_task) into v_task;
      exception when unique_violation then
        if p_action = 'telegram_add' then
          return jsonb_build_object('ok', false, 'error', 'task_conflict');
        end if;
        select to_jsonb(t) into v_task from personal_bot.tasks t where t.id = v_task_id and t.owner_id = v_owner_id;
        if not found then
          return jsonb_build_object('ok', false, 'error', 'task_conflict');
        end if;
      end;
      return jsonb_build_object('ok', true, 'task', v_task);

    when 'update_task' then
      if p_task_id is null or coalesce(p_task->>'status', '') not in ('open', 'completed') then
        return jsonb_build_object('ok', false, 'error', 'invalid_task');
      end if;
      update personal_bot.tasks as updated_task
        set status = p_task->>'status',
            completed_at = case when p_task->>'status' = 'completed' then coalesce(completed_at, now()) else null end,
            updated_at = now()
      where id = p_task_id and owner_id = v_owner_id and archived_at is null
      returning to_jsonb(updated_task) into v_task;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'not_found');
      end if;
      return jsonb_build_object('ok', true, 'task', v_task);

    when 'archive_task' then
      if p_task_id is null then
        return jsonb_build_object('ok', false, 'error', 'invalid_task');
      end if;
      update personal_bot.tasks as updated_task
        set archived_at = now(), updated_at = now()
      where id = p_task_id and owner_id = v_owner_id and archived_at is null
      returning to_jsonb(updated_task) into v_task;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'not_found');
      end if;
      return jsonb_build_object('ok', true, 'task', v_task);

    when 'import_tasks' then
      if jsonb_typeof(coalesce(p_tasks, '[]'::jsonb)) <> 'array'
         or jsonb_array_length(coalesce(p_tasks, '[]'::jsonb)) > 500 then
        return jsonb_build_object('ok', false, 'error', 'invalid_import');
      end if;
      for v_item in select value from jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb)) as items(value) loop
        v_title := trim(coalesce(v_item->>'title', v_item->>'name', ''));
        if v_title = '' or length(v_title) > 200 then continue; end if;
        if (v_item->>'id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          v_task_id := (v_item->>'id')::uuid;
        else
          v_task_id := gen_random_uuid();
        end if;
        if exists (select 1 from personal_bot.tasks where id = v_task_id and owner_id = v_owner_id) then
          continue;
        end if;
        v_status := case when coalesce(v_item->>'status', '') = 'completed' or v_item->>'done' = 'true' then 'completed' else 'open' end;
        begin
          begin
            v_created_at := (v_item->>'created_at')::timestamptz;
          exception when others then
            v_created_at := now();
          end;
          insert into personal_bot.tasks (id, owner_id, title, description, status, created_at, completed_at)
          values (v_task_id, v_owner_id, v_title, nullif(v_item->>'description', ''), v_status,
                  coalesce(v_created_at, now()), case when v_status = 'completed' then coalesce(v_created_at, now()) else null end);
          v_imported := v_imported + 1;
        exception when unique_violation then
          v_new_id := gen_random_uuid();
          insert into personal_bot.tasks (id, owner_id, title, description, status, created_at, completed_at)
          values (v_new_id, v_owner_id, v_title, nullif(v_item->>'description', ''), v_status,
                  coalesce(v_created_at, now()), case when v_status = 'completed' then coalesce(v_created_at, now()) else null end);
          v_mapping := v_mapping || jsonb_build_array(jsonb_build_object('old_id', v_task_id, 'new_id', v_new_id));
          v_imported := v_imported + 1;
        end;
      end loop;
      return jsonb_build_object('ok', true, 'imported', v_imported, 'id_mapping', v_mapping);

    when 'telegram_done', 'telegram_archive' then
      if p_task_number is null or p_task_number < 1 or p_task_number > 200 then
        return jsonb_build_object('ok', false, 'error', 'invalid_task_number');
      end if;
      select id into v_task_id from (
        select id, row_number() over (order by created_at desc, id) as n
        from personal_bot.tasks where owner_id = v_owner_id and archived_at is null
          and status = 'open'
      ) numbered where n = p_task_number;
      if not found then
        return jsonb_build_object('ok', false, 'error', 'not_found');
      end if;
      if p_action = 'telegram_done' then
        update personal_bot.tasks set status = 'completed', completed_at = now(), updated_at = now()
        where id = v_task_id and owner_id = v_owner_id;
      else
        update personal_bot.tasks set archived_at = now(), updated_at = now()
        where id = v_task_id and owner_id = v_owner_id;
      end if;
      return jsonb_build_object('ok', true, 'task_id', v_task_id);

    else
      return jsonb_build_object('ok', false, 'error', 'unknown_action');
  end case;
end;
$function$;

revoke all on function public.personalbot_api(text, uuid, bigint, text, jsonb, jsonb, uuid, integer, bigint)
  from public, anon, authenticated;
grant execute on function public.personalbot_api(text, uuid, bigint, text, jsonb, jsonb, uuid, integer, bigint)
  to service_role;

