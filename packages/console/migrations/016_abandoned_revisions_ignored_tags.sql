-- Une révision abandonnée reste dans l'historique (immuable) mais n'est plus proposée au déploiement.
ALTER TABLE stack_revisions
  ADD COLUMN abandoned_at     timestamptz,
  ADD COLUMN abandoned_by     text,
  ADD COLUMN abandoned_reason text;

-- Versions d'image proposées par la vérification des mises à jour mais écartées par l'utilisateur, par composant.
CREATE TABLE image_ignored_tags (
  stack_id   uuid        NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
  service    text        NOT NULL,
  tag        text        NOT NULL,
  reason     text,
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (stack_id, service, tag)
);
