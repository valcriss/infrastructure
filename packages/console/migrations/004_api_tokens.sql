-- Jetons API : seule l'empreinte SHA-256 est stockée, jamais le jeton.
CREATE TABLE api_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text        NOT NULL,
  -- `read` : requêtes GET/HEAD uniquement ; `write` : toutes les routes d'automatisation.
  scope        text        NOT NULL CHECK (scope IN ('read', 'write')),
  token_hash   text        NOT NULL UNIQUE,
  -- Début du jeton, pour l'identifier dans la liste sans le révéler.
  prefix       text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  last_used_at timestamptz,
  revoked_at   timestamptz
);
