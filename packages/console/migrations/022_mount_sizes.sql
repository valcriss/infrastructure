-- Taille sur le disque des montages (volumes nommés et dossiers « bind »), mesurée par l'agent de chaque hôte.
CREATE TABLE mount_sizes (
  host_id     uuid        NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('volume', 'bind')),
  source      text        NOT NULL,
  size_bytes  bigint,
  note        text,
  measured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, kind, source)
);
