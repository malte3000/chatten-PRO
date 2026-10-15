-- Run only against the isolated paper-sync test project after applying
-- paper_sync_schema.sql. Every synthetic user and observation is rolled back.
-- A successful run returns one row with result = PASS.
begin;

insert into auth.users (id) values
  ('00000000-0000-4000-8000-000000000101'),
  ('00000000-0000-4000-8000-000000000102');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000101', true),
  set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000101","role":"authenticated","is_anonymous":false}', true);
set local role authenticated;
insert into public.paper_observations (user_id, observation_id, capture)
values ('00000000-0000-4000-8000-000000000101', 'rls-test-a', '{"id":"rls-test-a"}');

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000102', true),
  set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000102","role":"authenticated","is_anonymous":false}', true);
insert into public.paper_observations (user_id, observation_id, capture)
values ('00000000-0000-4000-8000-000000000102', 'rls-test-b', '{"id":"rls-test-b"}');

do $$
declare
  visible_rows integer;
  changed_rows integer;
begin
  select count(*) into visible_rows from public.paper_observations;
  if visible_rows <> 1 then
    raise exception 'User B can see another owner''s observation';
  end if;

  update public.paper_observations set status = 'PENDING_OPEN', revision = 1
  where observation_id = 'rls-test-a';
  get diagnostics changed_rows = row_count;
  if changed_rows <> 0 then
    raise exception 'User B changed another owner''s observation';
  end if;

  begin
    insert into public.paper_observations (user_id, observation_id, capture)
    values ('00000000-0000-4000-8000-000000000101', 'rls-test-intrusion', '{"id":"rls-test-intrusion"}');
    raise exception 'Cross-owner insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  update public.paper_observations set status = 'PENDING_OPEN', revision = 1
  where observation_id = 'rls-test-b' and revision = 0;
  get diagnostics changed_rows = row_count;
  if changed_rows <> 1 then
    raise exception 'Owner cannot update their own observation';
  end if;

  begin
    update public.paper_observations set status = 'CLOSED', revision = 1
    where observation_id = 'rls-test-b';
    raise exception 'Stale revision unexpectedly succeeded';
  exception when raise_exception then
    if sqlerrm <> 'Stale paper observation revision' then raise; end if;
  end;

  begin
    update public.paper_observations set capture = '{"id":"rls-test-b","changed":true}'
    where observation_id = 'rls-test-b';
    raise exception 'Immutable capture unexpectedly changed';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000101', true),
  set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000101","role":"authenticated","is_anonymous":false}', true);
do $$
declare visible_rows integer;
begin
  select count(*) into visible_rows from public.paper_observations;
  if visible_rows <> 1 or not exists (
    select 1 from public.paper_observations where observation_id = 'rls-test-a'
  ) then
    raise exception 'User A cannot see exactly their own observation';
  end if;
end;
$$;

select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000101","role":"authenticated","is_anonymous":true}', true);
do $$
declare visible_rows integer;
begin
  select count(*) into visible_rows from public.paper_observations;
  if visible_rows <> 0 then
    raise exception 'Anonymous Auth account can read paper observations';
  end if;
  begin
    insert into public.paper_observations (user_id, observation_id, capture)
    values ('00000000-0000-4000-8000-000000000101', 'rls-test-anonymous', '{"id":"rls-test-anonymous"}');
    raise exception 'Anonymous Auth account inserted an observation';
  exception when insufficient_privilege then null;
  end;
end;
$$;

select 'PASS' as result;
rollback;
