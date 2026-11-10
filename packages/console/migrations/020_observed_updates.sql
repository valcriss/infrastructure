-- Suivi des mises à jour d'image des applications observées (projets Compose sans stack) : mêmes règles que pour
-- les stacks gérées, par service, mais rattachées à (hôte, projet) puisqu'il n'y a pas de stack.
CREATE TABLE observed_image_policies (
  host_id    uuid        NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  project    text        NOT NULL,
  service    text        NOT NULL,
  policy     text        NOT NULL CHECK (policy IN ('same_tag', 'patch', 'minor', 'major', 'pattern')),
  pattern    text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, project, service)
);

CREATE TABLE observed_image_ignored_tags (
  host_id    uuid        NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  project    text        NOT NULL,
  service    text        NOT NULL,
  tag        text        NOT NULL,
  reason     text,
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (host_id, project, service, tag)
);

CREATE TABLE observed_image_checks (
  host_id         uuid        NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  project         text        NOT NULL,
  service         text        NOT NULL,
  checked_at      timestamptz NOT NULL,
  status          text        NOT NULL CHECK (status IN ('ok', 'error')),
  kind            text,
  detail          jsonb,
  error           text,
  last_success_at timestamptz,
  PRIMARY KEY (host_id, project, service)
);
