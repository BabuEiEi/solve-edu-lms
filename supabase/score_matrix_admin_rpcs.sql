-- Admin/Staff RPCs for Score Matrix management
-- Run this file in Supabase SQL Editor

create or replace function public.admin_get_quiz_result(_result_id uuid)
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

  return query
  select qr.id, qr.user_id, qr.quiz_type, qr.score, qr.total, qr.answers
  from public.quiz_results qr
  where qr.id = _result_id;
end;
$$;

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

  return query
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
  returning qr.id, qr.user_id, qr.quiz_type, qr.score, qr.total, qr.answers;
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

  delete from public.quiz_results qr
  where qr.id = _result_id;

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

  return query
  update public.quiz_results qr
  set
    score = 0,
    total = 0,
    answers = jsonb_build_object(
      '__canceled', true,
      'canceled_at', now()
    )
  where qr.id = _result_id
  returning qr.id, qr.user_id, qr.quiz_type, qr.score, qr.total, qr.answers;
end;
$$;

grant execute on function public.admin_get_quiz_result(uuid) to authenticated;
grant execute on function public.admin_update_quiz_result(uuid, int4, int4) to authenticated;
grant execute on function public.admin_delete_quiz_result(uuid) to authenticated;
grant execute on function public.admin_cancel_quiz_result(uuid) to authenticated;
