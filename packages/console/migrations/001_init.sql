-- Schéma initial de la console (Phase 1).

-- Un seul administrateur : la clé primaire booléenne contrainte à TRUE
-- garantit l'unicité au niveau de la base, même sous requêtes concurrentes.
CREATE TABLE admin (
  singleton     boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  username      text        NOT NULL,
  password_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id_hash    text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE enrollment_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text        NOT NULL UNIQUE,
  purpose    text        NOT NULL CHECK (purpose IN ('bootstrap', 'manual')),
  host_name  text,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE hosts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL,
  secret_hash           text        NOT NULL,
  agent_version         text,
  capabilities          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  last_seen_at          timestamptz,
  docker_version        text,
  inventory             jsonb,
  inventory_observed_at timestamptz,
  revoked_at            timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Journal d'audit : aucune valeur sensible n'y est écrite.
CREATE TABLE audit_events (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  actor  text        NOT NULL,
  action text        NOT NULL,
  target text,
  result text        NOT NULL
);
