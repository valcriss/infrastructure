-- Images, scans de vulnérabilités (Trivy) et suivi des versions (Phase 5).

-- Images utilisées par les conteneurs de l'hôte, d'après le dernier inventaire.
ALTER TABLE hosts ADD COLUMN images jsonb;

CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Un résultat de scan s'applique à un contenu d'image (identifiant + plateforme),
-- quel que soit l'hôte : une image identique sur deux hôtes n'est scannée qu'une fois.
CREATE TABLE image_scans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id        text        NOT NULL,
  platform        text        NOT NULL DEFAULT '',
  host_id         uuid        NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  image_ref       text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  trigger         text        NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  requested_by    text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz,
  error           text,
  trivy_version   text,
  db_version      integer,
  db_updated_at   timestamptz,
  db_downloaded_at timestamptz,
  os_family       text,
  os_name         text,
  os_eosl         boolean,
  counts          jsonb,
  total           integer,
  truncated       boolean     NOT NULL DEFAULT false,
  vulnerabilities jsonb
);
CREATE INDEX image_scans_image_idx ON image_scans (image_id, platform, created_at DESC);
CREATE INDEX image_scans_host_idx ON image_scans (host_id, status);
-- Déduplication : un seul scan actif par contenu d'image.
CREATE UNIQUE INDEX image_scans_active_idx ON image_scans (image_id, platform) WHERE status IN ('pending', 'running');

-- Règle de suivi des versions par composant (service) d'une stack.
CREATE TABLE image_policies (
  stack_id   uuid        NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
  service    text        NOT NULL,
  policy     text        NOT NULL CHECK (policy IN ('same_tag', 'patch', 'minor', 'major', 'pattern')),
  pattern    text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stack_id, service)
);

-- Registres d'images : identifiants (facultatifs) et option HTTP non sécurisé.
CREATE TABLE registry_credentials (
  registry     text PRIMARY KEY,
  username     text,
  password_enc text,
  insecure     boolean     NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Dernière vérification des versions par composant. En cas d'échec du registre,
-- `detail` (dernière observation réussie) est conservé et daté.
CREATE TABLE image_checks (
  stack_id        uuid        NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
  service         text        NOT NULL,
  checked_at      timestamptz NOT NULL,
  status          text        NOT NULL CHECK (status IN ('ok', 'error')),
  kind            text,
  detail          jsonb,
  error           text,
  last_success_at timestamptz,
  PRIMARY KEY (stack_id, service)
);
