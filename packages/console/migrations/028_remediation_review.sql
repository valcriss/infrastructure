-- Préparation automatique de correctifs : relecture par un humain (un correctif préparé par la planification est « à relire »).
ALTER TABLE remediation_jobs
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by text;
