-- Suppression d'une application : nouveau type d'opération (retire conteneurs, réseaux, volumes, images et dossier de l'hôte).
ALTER TABLE operations DROP CONSTRAINT operations_type_check;
ALTER TABLE operations ADD CONSTRAINT operations_type_check CHECK (type IN ('deploy', 'stop', 'start', 'destroy'));
