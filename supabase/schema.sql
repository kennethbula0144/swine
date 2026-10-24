CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Compatibility table used by the existing Python store layer.
CREATE TABLE IF NOT EXISTS public.records (
  collection text not null,
  id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  payload jsonb not null,
  primary key (collection, id)
);

CREATE INDEX IF NOT EXISTS idx_records_collection_updated_desc
  ON public.records (collection, updated_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_records_pig_tag_id_unique
  ON public.records ((payload ->> 'tagId'))
  WHERE collection = 'pigs' AND payload ->> 'tagId' IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_records_pig_model_identity_unique
  ON public.records ((payload ->> 'modelIdentity'))
  WHERE collection = 'pigs' AND payload ->> 'modelIdentity' IS NOT NULL;

-- Core app tables.
CREATE TABLE IF NOT EXISTS public.pigs (
  id text primary key,
  tag_id text,
  model_identity text,
  stage text not null default 'Unassigned',
  days_in_pen integer,
  weight numeric(6,2),
  temp numeric(5,2),
  behavior text,
  health_indicator text,
  status text not null default 'Unreviewed' check (status in ('Unreviewed', 'Healthy', 'Monitor', 'Alert')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pigs_tag_id_format check (tag_id is null or tag_id ~ '^(0[1-9]|1[0-9]|20)$'),
  constraint pigs_model_identity_unique unique (model_identity)
);

INSERT INTO public.pigs (
  id, tag_id, model_identity, stage, days_in_pen, weight, temp,
  behavior, health_indicator, status, created_at, updated_at
)
SELECT
  id,
  payload ->> 'tagId',
  payload ->> 'modelIdentity',
  COALESCE(payload ->> 'stage', 'Unassigned'),
  NULLIF(payload ->> 'daysInPen', '')::integer,
  NULLIF(payload ->> 'weight', '')::numeric,
  NULLIF(payload ->> 'temp', '')::numeric,
  payload ->> 'behavior',
  payload ->> 'healthIndicator',
  COALESCE(payload ->> 'status', 'Unreviewed'),
  created_at,
  updated_at
FROM public.records
WHERE collection = 'pigs'
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.observations (
  id text primary key,
  detected_id text,
  pig_id text,
  identity_status text,
  source text not null default 'manual' check (source in ('camera', 'upload', 'manual')),
  estimated_weight_kg numeric(6,2),
  weight_source text,
  recognition_confidence numeric(5,2),
  detection_confidence numeric(5,2),
  behavior_indicator text,
  behavior_confidence numeric(5,2),
  behavior_source text,
  box jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS public.alerts (
  id text primary key,
  pig_id text,
  title text not null,
  type text,
  indicator text,
  evidence text,
  next_action text,
  severity text not null default 'Info' check (severity in ('Critical', 'Warning', 'Info')),
  status text not null default 'Pending' check (status in ('Pending', 'Resolved', 'Reviewed', 'Escalated')),
  referral_status text not null default 'Not referred' check (referral_status in ('Not referred', 'Referred', 'In progress', 'Completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS public.environment_readings (
  id text primary key,
  ambient_temperature numeric(5,2),
  humidity numeric(5,2),
  body_temperature numeric(5,2),
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS public.feed_records (
  id text primary key,
  date date not null,
  pigs integer not null check (pigs >= 1),
  feed_per_pig numeric(8,2) not null check (feed_per_pig > 0),
  cost_per_kg numeric(8,2) not null check (cost_per_kg > 0),
  total_kg numeric(10,2) not null default 0,
  total_cost numeric(10,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_records_touch_updated_at ON public.records;
CREATE TRIGGER trg_records_touch_updated_at
BEFORE UPDATE ON public.records
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_pigs_touch_updated_at ON public.pigs;
CREATE TRIGGER trg_pigs_touch_updated_at
BEFORE UPDATE ON public.pigs
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_observations_touch_updated_at ON public.observations;
CREATE TRIGGER trg_observations_touch_updated_at
BEFORE UPDATE ON public.observations
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_alerts_touch_updated_at ON public.alerts;
CREATE TRIGGER trg_alerts_touch_updated_at
BEFORE UPDATE ON public.alerts
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_environment_readings_touch_updated_at ON public.environment_readings;
CREATE TRIGGER trg_environment_readings_touch_updated_at
BEFORE UPDATE ON public.environment_readings
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS trg_feed_records_touch_updated_at ON public.feed_records;
CREATE TRIGGER trg_feed_records_touch_updated_at
BEFORE UPDATE ON public.feed_records
FOR EACH ROW
EXECUTE FUNCTION public.touch_updated_at();

CREATE UNIQUE INDEX IF NOT EXISTS idx_pigs_tag_id_unique
  ON public.pigs (tag_id)
  WHERE tag_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pigs_model_identity_unique_2
  ON public.pigs (model_identity)
  WHERE model_identity IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_observations_pig_id
  ON public.observations (pig_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_pig_id
  ON public.alerts (pig_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_environment_readings_created_at_desc
  ON public.environment_readings (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feed_records_date_desc
  ON public.feed_records (date DESC);
