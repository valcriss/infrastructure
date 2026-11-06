-- Utilisation de la machine hôte (CPU global, mémoire, disque de l'espace de travail), même rétention
-- que les métriques de conteneurs. Un relevé par période de collecte et par hôte.
CREATE TABLE host_metric_samples (
  host_id       uuid        NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  observed_at   timestamptz NOT NULL,
  cpu_percent   real,
  mem_total     bigint,
  mem_used      bigint,
  disk_total    bigint,
  disk_used     bigint
);
CREATE INDEX host_metric_samples_host_time_idx ON host_metric_samples (host_id, observed_at);
