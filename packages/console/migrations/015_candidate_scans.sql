-- Comparaison des vulnérabilités d'une autre version d'image avant de l'adopter : l'image est téléchargée sur
-- l'hôte, scannée, puis retirée. Rien n'est déployé.
ALTER TABLE image_scans ADD COLUMN candidate boolean NOT NULL DEFAULT false;

CREATE TABLE candidate_scans (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stack_id     uuid        NOT NULL REFERENCES stacks (id) ON DELETE CASCADE,
  service      text        NOT NULL,
  host_id      uuid        NOT NULL REFERENCES hosts (id) ON DELETE CASCADE,
  -- Référence candidate (dépôt:étiquette) et référence actuellement déployée.
  ref          text        NOT NULL,
  base_ref     text        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('pulling', 'scanning', 'succeeded', 'failed')),
  error        text,
  image_id     text,
  platform     text,
  scan_id      uuid,
  requested_by text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  -- Image candidate retirée de l'hôte (ou tentative faite) : plus rien à nettoyer.
  cleaned_at   timestamptz
);
CREATE INDEX candidate_scans_stack_idx ON candidate_scans (stack_id, created_at DESC);
