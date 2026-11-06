-- Sauvegarde de la configuration dans un dépôt Git unique (Phase 3).

-- Compteur monotone des changements de configuration (stacks, révisions…) et
-- identifiant stable de l'installation, écrit dans le manifeste du dépôt.
CREATE TABLE config_state (
  singleton       boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  config_revision bigint      NOT NULL DEFAULT 0,
  installation_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
INSERT INTO config_state DEFAULT VALUES;

-- Dépôt de sauvegarde : un seul. Le jeton est chiffré avec la clé maître de la
-- console (jamais écrit dans Git ni dans les journaux).
CREATE TABLE backup_settings (
  singleton          boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  repo_url           text        NOT NULL,
  username           text        NOT NULL,
  token_enc          text        NOT NULL,
  branch             text        NOT NULL DEFAULT 'main',
  enabled            boolean     NOT NULL DEFAULT true,
  -- config_revision exportée dans le dernier commit local / poussée avec succès.
  covered_revision   bigint      NOT NULL DEFAULT 0,
  pushed_revision    bigint      NOT NULL DEFAULT 0,
  local_commit       text,
  pushed_commit      text,
  last_push_at       timestamptz,
  last_error_code    text,
  last_error_message text,
  last_error_at      timestamptz,
  retry_count        integer     NOT NULL DEFAULT 0,
  next_retry_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Évite de re-chiffrer (donc de modifier les fichiers .age) un secret inchangé :
-- le HMAC (clé maître) identifie le contenu en clair sans le révéler.
CREATE TABLE backup_secret_cache (
  path       text PRIMARY KEY,
  hmac       text NOT NULL,
  ciphertext text NOT NULL
);

-- Classification des éléments sensibles d'une révision (chiffrés dans Git).
ALTER TABLE stack_revisions
  ADD COLUMN sensitive_files   jsonb   NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN compose_sensitive boolean NOT NULL DEFAULT false;
