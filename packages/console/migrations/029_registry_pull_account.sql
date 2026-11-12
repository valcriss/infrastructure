-- Compte de lecture seule du registre privé géré par la console : seul celui-ci est transmis aux déploiements qui tirent
-- des images ; le compte de publication (lecture et écriture) reste réservé aux correctifs. Chiffré comme le mot de passe.
ALTER TABLE registry_credentials
  ADD COLUMN pull_username     text,
  ADD COLUMN pull_password_enc text;
