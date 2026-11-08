-- Sessions de terminal de conteneur et leur enregistrement (format asciinema v2, sortie écran seulement).
CREATE TABLE terminal_sessions (
  id              uuid PRIMARY KEY,
  user_id         uuid        REFERENCES users (id) ON DELETE SET NULL,
  -- Conservés tels quels : l'enregistrement doit survivre à la suppression du compte, de l'hôte ou du conteneur.
  user_email      text        NOT NULL,
  host_id         uuid,
  host_name       text        NOT NULL,
  container_id    text        NOT NULL,
  container_name  text        NOT NULL,
  project         text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz,
  end_reason      text,
  exit_code       integer,
  cols            integer     NOT NULL,
  rows            integer     NOT NULL,
  -- Peut contenir des secrets affichés à l'écran : réservé aux administrateurs, jamais sauvegardé dans Git.
  recording       text        NOT NULL DEFAULT '',
  recording_bytes integer     NOT NULL DEFAULT 0,
  recording_truncated boolean NOT NULL DEFAULT false,
  recorded        boolean     NOT NULL DEFAULT true
);
CREATE INDEX terminal_sessions_started_idx ON terminal_sessions (started_at DESC);
