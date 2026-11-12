-- Où l'image corrigée a été proposée : [{ stackId, stackName, service, revision, by, at }].
-- La révision créée n'est jamais déployée par la console ; ce lien sert à l'historique et à la provenance.
ALTER TABLE remediation_jobs ADD COLUMN applied jsonb NOT NULL DEFAULT '[]'::jsonb;
