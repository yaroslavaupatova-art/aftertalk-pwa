-- Durable, atomic fixed-window rate limiting for generate-action.
-- The table contains only salted SHA-256 IP fingerprints, never raw IP addresses.
create table if not exists public.generate_action_rate_limits (
  fingerprint text primary key,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count > 0),
  constraint generate_action_rate_limits_fingerprint_format
    check (fingerprint ~ '^[0-9a-f]{64}$')
);

create index if not exists generate_action_rate_limits_window_started_at_idx
  on public.generate_action_rate_limits (window_started_at);

alter table public.generate_action_rate_limits enable row level security;
revoke all on table public.generate_action_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.generate_action_rate_limits to service_role;

comment on table public.generate_action_rate_limits is
  'Fixed-window counters keyed only by salted SHA-256 IP fingerprints.';

create or replace function public.consume_generate_action_rate_limit(
  p_fingerprint text,
  p_limit integer default 30,
  p_window_seconds integer default 3600
)
returns table (
  allowed boolean,
  remaining integer,
  reset_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_count integer;
  v_window_started_at timestamptz;
begin
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid fingerprint' using errcode = '22023';
  end if;

  if p_limit is null or p_limit < 1 or p_limit > 300 then
    raise exception 'limit must be between 1 and 300' using errcode = '22023';
  end if;

  if p_window_seconds is null or p_window_seconds < 60 or p_window_seconds > 86400 then
    raise exception 'window must be between 60 and 86400 seconds' using errcode = '22023';
  end if;

  -- Keep table growth bounded. Forty-eight hours safely exceeds the maximum
  -- permitted one-day window while removing counters that cannot be active.
  delete from public.generate_action_rate_limits
  where window_started_at < statement_timestamp() - interval '48 hours';

  insert into public.generate_action_rate_limits as limits (
    fingerprint,
    window_started_at,
    request_count
  )
  values (p_fingerprint, statement_timestamp(), 1)
  on conflict (fingerprint) do update
  set
    window_started_at = case
      when limits.window_started_at + make_interval(secs => p_window_seconds)
        <= statement_timestamp()
      then statement_timestamp()
      else limits.window_started_at
    end,
    request_count = case
      when limits.window_started_at + make_interval(secs => p_window_seconds)
        <= statement_timestamp()
      then 1
      else limits.request_count + 1
    end
  returning request_count, window_started_at
    into v_count, v_window_started_at;

  return query select
    v_count <= p_limit,
    greatest(p_limit - v_count, 0),
    v_window_started_at + make_interval(secs => p_window_seconds);
end;
$$;

revoke all on function public.consume_generate_action_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_generate_action_rate_limit(text, integer, integer)
  to service_role;

comment on function public.consume_generate_action_rate_limit(text, integer, integer) is
  'Prunes counters older than 48 hours, then atomically consumes one request from a salted IP fingerprint bucket.';
