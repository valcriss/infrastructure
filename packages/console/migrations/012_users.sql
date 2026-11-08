-- Utilisateurs, rôles, deuxième facteur et clés d'accès.
-- La table « admin » est conservée : elle sert de marqueur d'initialisation et porte la clé de
-- restauration. Les identifiants de connexion vivent désormais dans « users ».

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                text        NOT NULL,
  -- Ancien identifiant de connexion (compte administrateur d'origine) : accepté en plus de l'e-mail.
  username             text,
  display_name         text        NOT NULL DEFAULT '',
  role                 text        NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  -- Droit « Terminal » : indépendant du rôle, jamais implicite.
  terminal_allowed     boolean     NOT NULL DEFAULT false,
  -- Vide pour un compte qui n'a que des clés d'accès (ou, plus tard, un fournisseur SSO).
  password_hash        text,
  must_change_password boolean     NOT NULL DEFAULT false,
  -- Secret TOTP chiffré avec la clé maître ; actif seulement une fois confirmé.
  totp_secret          text,
  totp_enabled         boolean     NOT NULL DEFAULT false,
  -- Dernier pas de temps TOTP accepté : un code ne sert qu une fois.
  totp_last_step       bigint,
  active               boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  last_login_at        timestamptz
);
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));
CREATE UNIQUE INDEX users_username_idx ON users (lower(username)) WHERE username IS NOT NULL;

-- Clés d'accès WebAuthn : seule la partie publique est stockée ; plusieurs par utilisateur.
CREATE TABLE passkeys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  credential_id text        NOT NULL UNIQUE,
  public_key    text        NOT NULL,
  counter       bigint      NOT NULL DEFAULT 0,
  transports    text[]      NOT NULL DEFAULT '{}',
  name          text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX passkeys_user_idx ON passkeys (user_id);

-- Codes de secours à usage unique (empreintes seulement).
CREATE TABLE recovery_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash  text        NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id);

-- L'administrateur d'origine devient le premier utilisateur.
INSERT INTO users (email, username, display_name, role, password_hash)
SELECT CASE WHEN username LIKE '%@%' THEN lower(username) ELSE lower(username) || '@console.local' END,
       CASE WHEN username LIKE '%@%' THEN NULL ELSE username END,
       username, 'admin', password_hash
  FROM admin;

-- Les sessions existantes appartenaient à l'administrateur unique : on les rattache à lui.
ALTER TABLE sessions
  ADD COLUMN user_id     uuid REFERENCES users (id) ON DELETE CASCADE,
  -- password, passkey (plus tard : sso) ; sert à savoir si un deuxième facteur a été présenté.
  ADD COLUMN auth_method text NOT NULL DEFAULT 'password',
  ADD COLUMN mfa_at      timestamptz;
UPDATE sessions SET user_id = (SELECT id FROM users ORDER BY created_at LIMIT 1);
DELETE FROM sessions WHERE user_id IS NULL;
ALTER TABLE sessions ALTER COLUMN user_id SET NOT NULL;
CREATE INDEX sessions_user_idx ON sessions (user_id);
