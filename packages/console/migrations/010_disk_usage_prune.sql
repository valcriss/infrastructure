-- Espace disque Docker par hôte (équivalent de `docker system df`) et historique des nettoyages.

ALTER TABLE hosts ADD COLUMN disk_usage jsonb;
ALTER TABLE hosts ADD COLUMN disk_usage_at timestamptz;

CREATE TABLE prune_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id      uuid        NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  requested_by text        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'unknown')),
  -- Réglages choisis et éléments ciblés (noms et identifiants, jamais de données applicatives).
  options      jsonb       NOT NULL,
  targets      jsonb       NOT NULL,
  result       jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX prune_runs_host_idx ON prune_runs (host_id, created_at DESC);
-- Un seul nettoyage à la fois par hôte.
CREATE UNIQUE INDEX prune_runs_active_idx ON prune_runs (host_id) WHERE status = 'running';
