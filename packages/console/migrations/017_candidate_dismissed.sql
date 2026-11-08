-- Une comparaison fermée n'est plus proposée ; le résultat reste en base (le nettoyage de l'image candidate se poursuit).
ALTER TABLE candidate_scans ADD COLUMN dismissed_at timestamptz;
