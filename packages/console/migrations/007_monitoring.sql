-- Supervision (Phase 4) : infos de l'hôte Docker et métriques à rétention bornée.

ALTER TABLE hosts ADD COLUMN host_info jsonb;

-- Un échantillon par conteneur et par période de collecte (30 s par défaut).
-- La rétention est bornée et paramétrable (METRICS_RETENTION_DAYS, 7 jours par défaut).
CREATE TABLE metric_samples (
  host_id        uuid        NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  observed_at    timestamptz NOT NULL,
  container_id   text        NOT NULL,
  container_name text        NOT NULL,
  project        text,
  service        text,
  cpu_percent    real,
  mem_bytes      bigint      NOT NULL,
  mem_limit      bigint      NOT NULL,
  -- Compteurs réseau cumulés ; les débits sont calculés à la lecture.
  net_rx         bigint      NOT NULL,
  net_tx         bigint      NOT NULL
);
CREATE INDEX metric_samples_host_time_idx ON metric_samples (host_id, observed_at);
CREATE INDEX metric_samples_project_idx ON metric_samples (host_id, project, observed_at);
