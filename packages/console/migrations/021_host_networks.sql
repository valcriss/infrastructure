-- Réseaux Docker de l'hôte, remontés avec l'inventaire (choix du réseau partagé de Traefik).
ALTER TABLE hosts ADD COLUMN networks jsonb;
