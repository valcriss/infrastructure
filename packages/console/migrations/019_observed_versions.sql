-- Historique des versions d'image des applications observées (projets Compose sans stack) : une ligne à chaque
-- changement d'image ou de contenu d'un service. La plus récente d'un service est sa version actuelle.
-- La clé (hôte, projet) survit à la prise en charge du projet : l'historique est alors conservé.
CREATE TABLE observed_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id     uuid        NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  project     text        NOT NULL,
  service     text        NOT NULL,
  -- Référence telle que déclarée par le conteneur (nom:étiquette).
  image       text        NOT NULL,
  image_id    text        NOT NULL,
  -- Digest de registre de l'image quand il est connu (absent pour une image construite localement).
  digest      text,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX observed_versions_service_idx ON observed_versions (host_id, project, service, observed_at DESC);
