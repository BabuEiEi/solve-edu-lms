-- Admin/Staff RPCs for Score Matrix management
-- Run this file in Supabase SQL Editor

create table if not exists public.quiz_result_audit_logs (
  id bigint generated always as identity primary key,
  result_id uuid,
  target_user_id uuid,
  quiz_type text,
  action text not null,
  old_score int4,
  old_total int4,
  new_score int4,
  new_total int4,
  old_answers jsonb,
  new_answers jsonb,
  changed_by uuid not null default auth.uid(),
  changed_at timestamptz not null default now(),
  constraint quiz_result_audit_logs_action_check check (action in ('edit', 'delete', 'cancel'))
);

create index if not exists idx_quiz_result_audit_logs_result_id on public.quiz_result_audit_logs (result_id);
create index if not exists idx_quiz_result_audit_logs_changed_at on public.quiz_result_audit_logs (changed_at desc);

alter table public.quiz_result_audit_logs enable row level security;

drop policy if exists "admin staff can read quiz_result_audit_logs" on public.quiz_result_audit_logs;
create policy "admin staff can read quiz_result_audit_logs"
on public.quiz_result_audit_logs
for select
to authenticated
using (
  exists (
    select 1
    from public.users_profile up
    where up.id = auth.uid()
      and up.role in ('admin', 'staff')
  )
);

create or replace function public.admin_update_quiz_result(
  _result_id uuid,
  _score int4,
  _total int4
)
returns table (
  id uuid,
  user_id uuid,
  quiz_type text,
  score int4,
  total int4,
  answers jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  _is_allowed boolean;
  _prev public.quiz_results%rowtype;
  _updated public.quiz_results%rowtype;
begin
  select exists (
    select 1
    from public.users_profile up
    where up.id = auth.uid()
      and up.role in ('admin', 'staff')
  ) into _is_allowed;

  if not _is_allowed then
    raise exception 'permission denied';
  end if;

  select *
  into _prev
  from public.quiz_results qr
  where qr.id = _result_id;

  if _prev.id is null then
    raise exception 'result not found';
  end if;

  update public.quiz_results qr
  set
    score = _score,
    total = _total,
    answers = case
      when jsonb_typeof(coalesce(qr.answers, '{}'::jsonb)) = 'object'
        then coalesce(qr.answers, '{}'::jsonb) - '__canceled' - 'canceled_at'
      else qr.answers
    end
  where qr.id = _result_id
  returning qr.* into _updated;

  if _updated.id is null then
    raise exception 'result not found';
  end if;

  insert into public.quiz_result_audit_logs (
    result_id,
    target_user_id,
    quiz_type,
    action,
    old_score,
    old_total,
    new_score,
    new_total,
    old_answers,
    new_answers,
    changed_by
  ) values (
    _updated.id,
    _updated.user_id,
    _updated.quiz_type,
    'edit',
    _prev.score,
    _prev.total,
    _updated.score,
    _updated.total,
    _prev.answers,
    _updated.answers,
    auth.uid()
  );

  return query
  select _updated.id, _updated.user_id, _updated.quiz_type, _updated.score, _updated.total, _updated.answers;
end;
$$;

create or replace function public.admin_delete_quiz_result(_result_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  _is_allowed boolean;
  _prev public.quiz_results%rowtype;
begin
  select exists (
    select 1
    from public.users_profile up
    where up.id = auth.uid()
      and up.role in ('admin', 'staff')
  ) into _is_allowed;

  if not _is_allowed then
    raise exception 'permission denied';
  end if;

  select *
  into _prev
  from public.quiz_results qr
  where qr.id = _result_id;

  if _prev.id is null then
    raise exception 'result not found';
  end if;

  delete from public.quiz_results qr
  where qr.id = _result_id;

  insert into public.quiz_result_audit_logs (
    result_id,
    target_user_id,
    quiz_type,
    action,
    old_score,
    old_total,
    old_answers,
    changed_by
  ) values (
    _prev.id,
    _prev.user_id,
    _prev.quiz_type,
    'delete',
    _prev.score,
    _prev.total,
    _prev.answers,
    auth.uid()
  );

  return found;
end;
$$;

create or replace function public.admin_cancel_quiz_result(_result_id uuid)
returns table (
  id uuid,
  user_id uuid,
  quiz_type text,
  score int4,
  total int4,
  answers jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  _is_allowed boolean;
  _prev public.quiz_results%rowtype;
  _updated public.quiz_results%rowtype;
begin
  select exists (
    select 1
    from public.users_profile up
    where up.id = auth.uid()
      and up.role in ('admin', 'staff')
  ) into _is_allowed;

  if not _is_allowed then
    raise exception 'permission denied';
  end if;

  select *
  into _prev
  from public.quiz_results qr
  where qr.id = _result_id;

  if _prev.id is null then
    raise exception 'result not found';
  end if;

  update public.quiz_results qr
  set
    score = 0,
    total = 0,
    answers = jsonb_build_object(
      '__canceled', true,
      'canceled_at', now()
    )
  where qr.id = _result_id
  returning qr.* into _updated;

  if _updated.id is null then
    raise exception 'result not found';
  end if;

  insert into public.quiz_result_audit_logs (
    result_id,
    target_user_id,
    quiz_type,
    action,
    old_score,
    old_total,
    new_score,
    new_total,
    old_answers,
    new_answers,
    changed_by
  ) values (
    _updated.id,
    _updated.user_id,
    _updated.quiz_type,
    'cancel',
    _prev.score,
    _prev.total,
    _updated.score,
    _updated.total,
    _prev.answers,
    _updated.answers,
    auth.uid()
  );

  return query
  select _updated.id, _updated.user_id, _updated.quiz_type, _updated.score, _updated.total, _updated.answers;
end;
$$;

grant execute on function public.admin_update_quiz_result(uuid, int4, int4) to authenticated;
grant execute on function public.admin_delete_quiz_result(uuid) to authenticated;
grant execute on function public.admin_cancel_quiz_result(uuid) to authenticated;
