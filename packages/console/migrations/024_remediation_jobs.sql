-- Remédiation des images (ADR 0002) : correctifs des paquets du système préparés sur un hôte, jamais déployés.
-- Un job est lié au CONTENU de l'image (identifiant + plateforme), pas à un tag mutable.
CREATE TABLE remediation_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id         text        NOT NULL,
  platform         text        NOT NULL,
  host_id          uuid        NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  image_ref        text        NOT NULL,
  -- Scan sur lequel l'éligibilité a été décidée (conservé pour la provenance).
  source_scan_id   uuid        REFERENCES image_scans (id) ON DELETE SET NULL,
  policy           text        NOT NULL DEFAULT 'os_safe' CHECK (policy IN ('os_safe')),
  -- Version des règles du moteur (verdict, options des scans) : un changement autorise un nouveau job.
  policy_version   integer     NOT NULL DEFAULT 1,
  status           text        NOT NULL CHECK (status IN (
                     'queued', 'preparing', 'scanning_before', 'patching', 'scanning_after', 'verifying',
                     'validated', 'partial', 'rejected', 'failed', 'unknown', 'cancelled')),
  requested_by     text        NOT NULL,
  -- Registre cible et noms (tag de correctif immuable : unique).
  registry_host    text        NOT NULL,
  repository       text        NOT NULL,
  source_tag       text        NOT NULL,
  patched_tag      text        NOT NULL,
  patch_number     integer     NOT NULL,
  source_digest    text,
  patched_digest   text,
  tools            jsonb,
  -- Bilan avant / après (verdict, raisons, CVE corrigées, restantes, nouvelles).
  bilan            jsonb,
  package_changes  jsonb,
  config_changes   jsonb,
  labels_added     jsonb,
  vex_statements   integer,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  UNIQUE (registry_host, repository, patched_tag)
);
CREATE INDEX remediation_jobs_image_idx ON remediation_jobs (image_id, platform, created_at DESC);
CREATE INDEX remediation_jobs_host_idx ON remediation_jobs (host_id, status);
-- Un seul job actif par contenu d'image et version de règles : pas de double exécution.
CREATE UNIQUE INDEX remediation_jobs_active_idx ON remediation_jobs (image_id, platform, policy, policy_version)
  WHERE status IN ('queued', 'preparing', 'scanning_before', 'patching', 'scanning_after', 'verifying', 'unknown');
