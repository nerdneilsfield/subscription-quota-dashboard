export type Migration = {
  version: number
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: [
      "create table if not exists provider_cache(",
      "  provider_account_id text primary key,",
      "  fetched_at text not null,",
      "  stale_after text not null,",
      "  status text not null,",
      "  normalized_json text not null,",
      "  error_json text",
      ")",
    ].join("\n"),
  },
  {
    version: 2,
    sql: [
      "create table if not exists quota_snapshots(",
      "  id integer primary key,",
      "  provider_account_id text not null,",
      "  subscription_id text not null,",
      "  metric_id text not null,",
      "  metric_key text not null,",
      "  timestamp text not null,",
      "  source text not null,",
      "  source_value_kind text not null,",
      "  authoritative_value real,",
      "  used real,",
      "  remaining real,",
      "  limit_value real",
      ")",
    ].join("\n"),
  },
  {
    version: 3,
    sql: [
      "create table if not exists provider_history_events(",
      "  provider_account_id text not null,",
      "  metric_key text not null,",
      "  provider_metric_id text not null,",
      "  normalized_usage_filter text not null,",
      "  provider_event_id text not null,",
      "  source_timestamp text not null,",
      "  value real not null,",
      "  value_kind text not null,",
      "  raw_json text,",
      "  primary key(provider_account_id, metric_key, provider_event_id)",
      ")",
    ].join("\n"),
  },
  {
    version: 4,
    sql: [
      "create table if not exists provider_import_state(",
      "  provider_account_id text primary key,",
      "  max_creation_time integer,",
      "  imported_query_ids_at_max_json text not null default '[]',",
      "  updated_at text not null",
      ")",
    ].join("\n"),
  },
  {
    version: 5,
    sql: [
      "create table if not exists refresh_runs(",
      "  id integer primary key,",
      "  started_at text not null,",
      "  finished_at text,",
      "  status text not null,",
      "  provider_account_ids_json text not null,",
      "  error_json text",
      ")",
    ].join("\n"),
  },
]
