-- Annulation d'un correctif en cours : demandée par un opérateur, confirmée par l'agent (résultat « cancelled »).
ALTER TABLE remediation_jobs
  ADD COLUMN cancel_requested_at timestamptz,
  ADD COLUMN cancel_requested_by text;
