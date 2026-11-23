-- Research storage for Pattern Discovery Engine.
-- This migration is additive and intentionally does not alter public.trades or
-- public.paper_observations. All writes are server-side only until a separate,
-- reviewed API and ownership model exists.

create table public.research_datasets (
  dataset_id uuid primary key default gen_random_uuid(),
  provider text not null,
  universe_name text not null,
  adjustment_policy text not null default 'UNVERIFIED'
    check (adjustment_policy in ('UNVERIFIED', 'RAW', 'SPLIT_ADJUSTED', 'TOTAL_RETURN_ADJUSTED')),
  survivorship_policy text not null default 'UNVERIFIED'
    check (survivorship_policy in ('UNVERIFIED', 'CURRENT_UNIVERSE', 'POINT_IN_TIME')),
  starts_on date,
  ends_on date,
  instrument_count integer not null default 0 check (instrument_count >= 0),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  content_hash text,
  created_at timestamptz not null default statement_timestamp(),
  check (starts_on is null or ends_on is null or starts_on <= ends_on)
);

create table public.research_market_bars (
  dataset_id uuid not null references public.research_datasets(dataset_id) on delete restrict,
  ticker text not null,
  exchange text not null,
  currency text not null,
  session_date date not null,
  open numeric not null check (open > 0),
  high numeric not null check (high > 0),
  low numeric not null check (low > 0),
  close numeric not null check (close > 0),
  volume numeric check (volume is null or volume >= 0),
  adjusted_close numeric check (adjusted_close is null or adjusted_close > 0),
  source_timestamp timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  primary key (dataset_id, ticker, exchange, session_date),
  check (low <= open and low <= close and high >= open and high >= close and low <= high)
);

create table public.research_runs (
  run_id uuid primary key default gen_random_uuid(),
  dataset_id uuid not null references public.research_datasets(dataset_id) on delete restrict,
  engine_version text not null,
  run_type text not null check (run_type in ('PATTERN_DISCOVERY', 'EVENT_BACKTEST', 'CALIBRATION', 'WALK_FORWARD')),
  status text not null default 'PENDING' check (status in ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  configuration jsonb not null check (jsonb_typeof(configuration) = 'object'),
  train_starts_on date,
  train_ends_on date,
  validation_starts_on date,
  validation_ends_on date,
  test_starts_on date,
  test_ends_on date,
  code_revision text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  check (train_starts_on is null or train_ends_on is null or train_starts_on <= train_ends_on),
  check (validation_starts_on is null or validation_ends_on is null or validation_starts_on <= validation_ends_on),
  check (test_starts_on is null or test_ends_on is null or test_starts_on <= test_ends_on),
  check (train_ends_on is null or validation_starts_on is null or train_ends_on < validation_starts_on),
  check (validation_ends_on is null or test_starts_on is null or validation_ends_on < test_starts_on),
  check (train_ends_on is null or test_starts_on is null or train_ends_on < test_starts_on),
  check (completed_at is null or started_at is null or completed_at >= started_at)
);

create table public.research_pattern_events (
  event_id bigint generated always as identity primary key,
  run_id uuid not null references public.research_runs(run_id) on delete restrict,
  ticker text not null,
  exchange text not null,
  event_type text not null check (event_type in ('ONE_DAY_DROP', 'DRAWDOWN_30', 'DRAWDOWN_90', 'CUSTOM')),
  event_date date not null,
  threshold_percent numeric not null check (threshold_percent > 0 and threshold_percent <= 100),
  observed_drop_percent numeric not null check (observed_drop_percent >= threshold_percent and observed_drop_percent <= 100),
  reference_price numeric not null check (reference_price > 0),
  signal_price numeric not null check (signal_price > 0),
  features jsonb not null default '{}'::jsonb check (jsonb_typeof(features) = 'object'),
  outcomes jsonb not null default '{}'::jsonb check (jsonb_typeof(outcomes) = 'object'),
  overlap_group text,
  unique (run_id, ticker, exchange, event_type, event_date, threshold_percent)
);

create table public.research_pattern_results (
  result_id bigint generated always as identity primary key,
  run_id uuid not null references public.research_runs(run_id) on delete restrict,
  pattern_key text not null,
  horizon_sessions integer not null check (horizon_sessions > 0),
  sample_count integer not null check (sample_count >= 0),
  independent_cluster_count integer check (independent_cluster_count is null or independent_cluster_count >= 0),
  estimate numeric,
  confidence_lower numeric,
  confidence_upper numeric,
  confidence_level numeric check (confidence_level is null or confidence_level > 0 and confidence_level < 1),
  metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(metrics) = 'object'),
  validation_split text not null default 'IN_SAMPLE'
    check (validation_split in ('IN_SAMPLE', 'VALIDATION', 'OUT_OF_SAMPLE', 'WALK_FORWARD')),
  created_at timestamptz not null default statement_timestamp(),
  unique (run_id, pattern_key, horizon_sessions, validation_split),
  check (confidence_lower is null or confidence_upper is null or confidence_lower <= confidence_upper),
  check (independent_cluster_count is null or independent_cluster_count <= sample_count),
  check (sample_count > 0 or estimate is null and confidence_lower is null and confidence_upper is null),
  check (estimate is null or confidence_lower is null or estimate >= confidence_lower),
  check (estimate is null or confidence_upper is null or estimate <= confidence_upper)
);

create table public.research_model_versions (
  model_id uuid primary key default gen_random_uuid(),
  model_name text not null,
  model_version text not null,
  algorithm text not null,
  status text not null default 'RESEARCH'
    check (status in ('RESEARCH', 'VALIDATED', 'REJECTED', 'RETIRED')),
  feature_schema jsonb not null default '{}'::jsonb check (jsonb_typeof(feature_schema) = 'object'),
  training_configuration jsonb not null default '{}'::jsonb check (jsonb_typeof(training_configuration) = 'object'),
  validation_metrics jsonb not null default '{}'::jsonb check (jsonb_typeof(validation_metrics) = 'object'),
  trained_run_id uuid references public.research_runs(run_id) on delete restrict,
  trained_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  unique (model_name, model_version)
);

create table public.research_forecasts (
  forecast_id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.research_model_versions(model_id) on delete restrict,
  ticker text not null,
  exchange text not null,
  as_of_date date not null,
  horizon_sessions integer not null check (horizon_sessions > 0),
  outcome_definition jsonb not null check (jsonb_typeof(outcome_definition) = 'object'),
  probability numeric check (probability is null or probability between 0 and 1),
  confidence_lower numeric check (confidence_lower is null or confidence_lower between 0 and 1),
  confidence_upper numeric check (confidence_upper is null or confidence_upper between 0 and 1),
  expected_return numeric,
  historical_sample_count integer check (historical_sample_count is null or historical_sample_count >= 0),
  input_snapshot jsonb not null check (jsonb_typeof(input_snapshot) = 'object'),
  actual_outcome jsonb check (actual_outcome is null or jsonb_typeof(actual_outcome) = 'object'),
  evaluated_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  check (confidence_lower is null or confidence_upper is null or confidence_lower <= confidence_upper),
  check (probability is null or confidence_lower is null or probability >= confidence_lower),
  check (probability is null or confidence_upper is null or probability <= confidence_upper),
  unique (model_id, ticker, exchange, as_of_date, horizon_sessions, outcome_definition)
);

create index research_market_bars_symbol_date_idx
  on public.research_market_bars (ticker, exchange, session_date desc);
create index research_runs_dataset_created_idx
  on public.research_runs (dataset_id, created_at desc);
create index research_pattern_events_lookup_idx
  on public.research_pattern_events (event_type, threshold_percent, event_date desc);
create index research_pattern_results_run_idx
  on public.research_pattern_results (run_id, pattern_key, horizon_sessions);
create index research_forecasts_pending_idx
  on public.research_forecasts (as_of_date, horizon_sessions) where evaluated_at is null;

alter table public.research_datasets enable row level security;
alter table public.research_market_bars enable row level security;
alter table public.research_runs enable row level security;
alter table public.research_pattern_events enable row level security;
alter table public.research_pattern_results enable row level security;
alter table public.research_model_versions enable row level security;
alter table public.research_forecasts enable row level security;

revoke all on table public.research_datasets from public, anon, authenticated;
revoke all on table public.research_market_bars from public, anon, authenticated;
revoke all on table public.research_runs from public, anon, authenticated;
revoke all on table public.research_pattern_events from public, anon, authenticated;
revoke all on table public.research_pattern_results from public, anon, authenticated;
revoke all on table public.research_model_versions from public, anon, authenticated;
revoke all on table public.research_forecasts from public, anon, authenticated;
revoke all on sequence public.research_pattern_events_event_id_seq from public, anon, authenticated;
revoke all on sequence public.research_pattern_results_result_id_seq from public, anon, authenticated;

-- Research history is append/update-only through the server role. Deliberately
-- omit DELETE so application bugs cannot erase model provenance or outcomes.
grant select, insert, update on table public.research_datasets to service_role;
grant select, insert, update on table public.research_market_bars to service_role;
grant select, insert, update on table public.research_runs to service_role;
grant select, insert, update on table public.research_pattern_events to service_role;
grant select, insert, update on table public.research_pattern_results to service_role;
grant select, insert, update on table public.research_model_versions to service_role;
grant select, insert, update on table public.research_forecasts to service_role;
grant usage, select on sequence public.research_pattern_events_event_id_seq to service_role;
grant usage, select on sequence public.research_pattern_results_result_id_seq to service_role;

comment on table public.research_datasets is 'Versioned research inputs; never assume adjustment or survivorship quality without explicit metadata.';
comment on table public.research_pattern_results is 'Aggregated research output. A result is not a live trading recommendation.';
comment on table public.research_forecasts is 'Versioned probability forecasts and later measured outcomes for calibration monitoring.';
