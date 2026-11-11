-- Stacks générées et entretenues par la console (registry) : leur contenu ne se modifie plus à la main.
-- NULL : stack ordinaire. Sinon, nom du module qui la gère ('registry').
ALTER TABLE stacks ADD COLUMN managed_by text;
