-- Initial schema for the shared Sannolikhetsterminal journal.
-- The API uses the service-role secret only on the server. No public policies are added.
create table if not exists public.trades (
  trade_id text primary key,
  strategy_version text not null,
  ticker text not null,
  company_name text,
  timestamp timestamptz not null,
  signal text not null check (signal in ('BUY', 'SELL', 'NO_TRADE')),
  direction text not null check (direction in ('LONG', 'SHORT', 'NONE')),
  confidence numeric not null check (confidence between 0 and 100),
  entry_price numeric check (entry_price is null or entry_price > 0),
  stop_loss numeric check (stop_loss is null or stop_loss > 0),
  target numeric check (target is null or target > 0),
  exit_price numeric check (exit_price is null or exit_price > 0),
  risk_reward numeric check (risk_reward is null or risk_reward >= 0),
  position_size numeric check (position_size is null or position_size >= 0),
  risk_percent numeric check (risk_percent is null or risk_percent between 0 and 100),
  risk_amount numeric check (risk_amount is null or risk_amount >= 0),
  technical_score numeric check (technical_score is null or technical_score between 0 and 100),
  momentum_score numeric check (momentum_score is null or momentum_score between 0 and 100),
  volume_score numeric check (volume_score is null or volume_score between 0 and 100),
  volatility_score numeric check (volatility_score is null or volatility_score between 0 and 100),
  trend text check (trend is null or trend in ('bullish', 'bearish', 'neutral', 'unclear')),
  support numeric check (support is null or support > 0),
  resistance numeric check (resistance is null or resistance > 0),
  rvol numeric check (rvol is null or rvol >= 0),
  atr numeric check (atr is null or atr >= 0),
  news_score numeric check (news_score is null or news_score between 0 and 100),
  news_confidence numeric check (news_confidence is null or news_confidence between 0 and 100),
  catalyst_strength numeric check (catalyst_strength is null or catalyst_strength between 0 and 10),
  chart_pattern text,
  chart_confidence numeric check (chart_confidence is null or chart_confidence between 0 and 100),
  market_regime text check (market_regime is null or market_regime in ('risk_on', 'risk_off', 'bullish', 'bearish', 'neutral', 'high_volatility', 'low_volatility', 'unclear')),
  sector_direction text check (sector_direction is null or sector_direction in ('bullish', 'bearish', 'neutral', 'unclear')),
  index_direction text check (index_direction is null or index_direction in ('bullish', 'bearish', 'neutral', 'unclear')),
  risk_engine_status text check (risk_engine_status is null or risk_engine_status in ('APPROVED', 'REJECTED', 'NOT_EVALUATED')),
  risk_rejection_reason text,
  trade_status text check (trade_status is null or trade_status in ('SIGNAL_ONLY', 'REJECTED', 'PENDING', 'OPEN', 'CLOSED', 'CANCELLED', 'NO_TRADE')),
  result_percent numeric,
  result_r numeric,
  winner boolean,
  exit_reason text check (exit_reason is null or exit_reason in ('TARGET', 'STOP_LOSS', 'MANUAL', 'TIME_EXIT', 'SIGNAL_REVERSAL', 'END_OF_DAY', 'OTHER')),
  post_trade_analysis text,
  signal_inputs jsonb,
  detected_errors jsonb not null default '[]'::jsonb check (jsonb_typeof(detected_errors) = 'array'),
  learning_tags jsonb not null default '[]'::jsonb check (jsonb_typeof(learning_tags) = 'array')
);

create index if not exists trades_timestamp_desc_idx on public.trades (timestamp desc);
create index if not exists trades_ticker_timestamp_idx on public.trades (ticker, timestamp desc);
create index if not exists trades_status_timestamp_idx on public.trades (trade_status, timestamp desc);

alter table public.trades enable row level security;
