-- Image corrigée supprimée du registre privé (nettoyage manuel) : le correctif reste dans l'historique, mais son image
-- ne peut plus être proposée à une application.
ALTER TABLE remediation_jobs ADD COLUMN registry_deleted_at timestamptz;
