-- Stacks, révisions immuables et opérations (Phase 2).

CREATE TABLE stacks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text        NOT NULL UNIQUE,
  host_id           uuid        NOT NULL REFERENCES hosts (id),
  description       text        NOT NULL DEFAULT '',
  -- Dernière révision enregistrée (configuration souhaitée).
  current_revision  integer     NOT NULL DEFAULT 0,
  -- Dernière révision réellement déployée avec succès.
  deployed_revision integer,
  deployed_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- Une révision est immuable : toute modification en crée une nouvelle.
CREATE TABLE stack_revisions (
  stack_id   uuid        NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
  revision   integer     NOT NULL,
  compose    text        NOT NULL,
  -- { "NOM": { "value": "...", "sensitive": false } }
  variables  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- { "chemin/relatif": "contenu" }
  files      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  digest     text        NOT NULL,
  author     text        NOT NULL,
  message    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stack_id, revision)
);

CREATE TABLE operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type            text        NOT NULL CHECK (type IN ('deploy', 'stop', 'start')),
  stack_id        uuid        NOT NULL REFERENCES stacks (id),
  host_id         uuid        NOT NULL REFERENCES hosts (id),
  revision        integer,
  status          text        NOT NULL
                  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'unknown')),
  options         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  requested_by    text        NOT NULL,
  idempotency_key text        UNIQUE,
  log             text        NOT NULL DEFAULT '',
  error           text,
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);

-- Sérialise les opérations d'une même stack : une seule active à la fois.
CREATE UNIQUE INDEX operations_active_per_stack
  ON operations (stack_id) WHERE status IN ('pending', 'running');
CREATE INDEX operations_stack_idx ON operations (stack_id, created_at DESC);
