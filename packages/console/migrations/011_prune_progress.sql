-- Avancement en direct d'un nettoyage (phase, élément en cours, compteurs).
ALTER TABLE prune_runs ADD COLUMN progress jsonb;
