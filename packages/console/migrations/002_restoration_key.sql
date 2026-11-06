-- Clé de restauration : seule la partie publique (destinataire age) est stockée.
-- La clé privée est remise une seule fois à l'administrateur lors de l'initialisation.
ALTER TABLE admin ADD COLUMN restoration_recipient text;
