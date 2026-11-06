-- Import d'une stack observée : tant que le premier déploiement n'a pas réussi,
-- l'agent est autorisé à reprendre le projet Compose existant du même nom.
ALTER TABLE stacks ADD COLUMN adopt_pending boolean NOT NULL DEFAULT false;
