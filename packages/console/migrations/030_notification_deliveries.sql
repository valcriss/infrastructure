-- Journal des envois de notifications (webhook) : statut et durée seulement, jamais le contenu du message ni l'adresse.
CREATE TABLE notification_deliveries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at          timestamptz NOT NULL DEFAULT now(),
  event       text        NOT NULL,
  status      text        NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  http_status integer,
  duration_ms integer,
  attempts    integer     NOT NULL DEFAULT 0,
  error       text
);
CREATE INDEX notification_deliveries_at_idx ON notification_deliveries (at DESC);
