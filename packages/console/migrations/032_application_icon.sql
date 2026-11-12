-- Icône personnalisée d'une application : un SVG (validé et normalisé à l'enregistrement) et une couleur de fond.
-- Hors des révisions : un changement d'icône ne crée pas de révision et n'appelle aucun déploiement.
ALTER TABLE stacks ADD COLUMN icon_svg text;
ALTER TABLE stacks ADD COLUMN icon_color text;
