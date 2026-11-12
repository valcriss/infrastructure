-- Vérification de démarrage d'un correctif : la commande configurée au lancement du job est conservée avec lui (le résultat
-- figure dans le bilan), même si le réglage change ensuite.
ALTER TABLE remediation_jobs ADD COLUMN verify_check jsonb;
