-- Apply only to an isolated paper-sync test project. This design was applied to
-- project bcvcwrtfxlwqbntnibtk, not the existing shared journal project.
-- The current preview and production server configuration may still share the
-- older project. Verify isolation before any future production migration.
-- Keep public.trades and the browser's existing paper JSON exports untouched.
-- This reference file is not part of the repository's migration history.

-- A row has two parts: the initial, immutable capture and later simulation
-- progress. Application code must split the current paper record accordingly.
-- The server time records when a row reached Supabase; it does not establish
-- that a client-provided signal or imported JSON is historically authentic.
-- Both "new_capture" and "local_import" are client supplied and unverified.
-- Imported local observations need explicit "local_import" provenance and
-- must not be mixed into a newly captured forward-test cohort.
create table public.paper_observations (
  user_id uuid not null references auth.users (id) on delete cascade,
  observation_id text not null,
  capture jsonb not null,
  status text not null default 'PENDING_ENTRY'
    check (status in ('PENDING_ENTRY', 'PENDING_OPEN', 'REJECTED_ENTRY', 'CLOSED', 'NOT_ASSESSED')),
  -- The default must rehydrate as a valid PENDING_ENTRY paperModel record.
  progress jsonb not null default '{"assessmentError":null,"rejectionReason":null,"entryDate":null,"entry":null,"stop":null,"target":null,"initialRisk":null,"holdingBars":null,"exitDate":null,"exit":null,"exitReason":null,"ambiguousBar":null,"grossPnl":null,"totalFees":null,"netPnl":null,"resultR":null,"winner":null}'::jsonb,
  revision bigint not null default 0 check (revision >= 0),
  provenance text not null default 'new_capture'
    check (provenance in ('new_capture', 'local_import')),
  captured_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  primary key (user_id, observation_id),
  check (length(observation_id) > 0),
  check (jsonb_typeof(capture) = 'object' and capture ? 'id' and (capture ->> 'id') = observation_id),
  check (jsonb_typeof(progress) = 'object')
);

create index paper_observations_owner_captured_idx
  on public.paper_observations (user_id, captured_at desc);

-- Column grants keep the captured signal, identity, provenance and timestamps
-- out of normal client UPDATE requests. Existing project-wide default grants
-- may be broad, so revoke them for this table before granting only what is used.
alter table public.paper_observations enable row level security;
revoke all on table public.paper_observations from public, anon, authenticated;
grant select on table public.paper_observations to authenticated;
grant insert (user_id, observation_id, capture, provenance)
  on table public.paper_observations to authenticated;
grant update (status, progress, revision)
  on table public.paper_observations to authenticated;
-- Deliberately no DELETE grant or policy, and no anon grant or policy.
-- A historical local import inserts with provenance = 'local_import' and the
-- default PENDING_ENTRY status with null outcome fields, then sets its saved
-- status/progress by a CAS
-- UPDATE from revision 0 to 1. This is not atomic: a failed second step must
-- be retried or flagged, never counted as a fresh forward observation.

create policy paper_observations_select_own
  on public.paper_observations for select to authenticated
  using ((select auth.uid()) = user_id
    and (select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)) = false);

create policy paper_observations_insert_own
  on public.paper_observations for insert to authenticated
  with check ((select auth.uid()) = user_id
    and (select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)) = false);

create policy paper_observations_update_own
  on public.paper_observations for update to authenticated
  using ((select auth.uid()) = user_id
    and (select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)) = false)
  with check ((select auth.uid()) = user_id
    and (select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)) = false);

-- A client updates with revision = previously-read revision + 1 and filters its
-- PATCH by both observation_id and the previously-read revision. The trigger
-- independently rejects stale or skipped revisions and freezes all capture
-- fields, including if someone later broadens column grants by mistake.
-- INSERT always receives the database clock, including trusted legacy imports.
create function public.paper_observations_guard_write()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog
as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 0;
    new.captured_at := statement_timestamp();
    new.updated_at := new.captured_at;
    return new;
  end if;

  if new.user_id is distinct from old.user_id
     or new.observation_id is distinct from old.observation_id
     or new.capture is distinct from old.capture
     or new.provenance is distinct from old.provenance
     or new.captured_at is distinct from old.captured_at then
    raise exception 'Paper observation capture is immutable';
  end if;

  if old.status in ('CLOSED', 'REJECTED_ENTRY') then
    raise exception 'A terminal paper observation cannot be changed';
  end if;

  if new.revision is distinct from old.revision + 1 then
    raise exception 'Stale paper observation revision';
  end if;

  if old.status = 'PENDING_OPEN' and new.status = 'PENDING_ENTRY' then
    raise exception 'Paper observation status cannot move backwards';
  end if;

  new.updated_at := statement_timestamp();
  return new;
end;
$$;

create trigger paper_observations_guard_write_trigger
  before insert or update on public.paper_observations
  for each row execute function public.paper_observations_guard_write();

-- Trigger functions need not be directly callable through the Data API.
revoke execute on function public.paper_observations_guard_write()
  from public, anon, authenticated;

-- The dashboard's optional automatic-RLS setting creates this SECURITY DEFINER
-- event-trigger function in the exposed public schema. Revoke direct API access
-- when present; the event trigger still runs on future CREATE TABLE commands.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;

-- Before treating synced data as verified outcomes or releasing beyond an
-- isolated test project, add a trusted server path that validates the selected
-- closed candle, session timing and paper arithmetic.
-- RLS protects ownership; it cannot prove a browser-supplied price history or
-- outcome. Never expose a service-role/secret key to the browser.
