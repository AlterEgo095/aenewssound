-- ============================================================================
-- AENEWS SOUND — 001_playback_events_partitioning.sql
-- Conversion de PlaybackEvent en table RANGE-partitionnée mensuelle sur occurredAt
--
-- DEUX FAÇONS DE L'APPLIQUER :
--   A (RECOMMANDÉE) : prisma migrate dev --create-only
--       -> remplacer dans la migration générée le CREATE TABLE "PlaybackEvent"
--          par le DDL partitionné ci-dessous (même ordre que les autres objets)
--       -> prisma migrate dev
--      (aucun drift : Prisma garde le contrôle des migrations)
--   B : exécuter ce script APRÈS une migration initiale déjà appliquée.
--
-- CONTRAINTE POSTGRESQL : toute contrainte unique / PK d'une table partitionnée
-- doit inclure la clé de partition -> PK composite (id, occurredAt),
-- telle que déclarée dans schema.prisma (@@id([id, occurredAt])).
--
-- MAINTENANCE : job BullMQ repeatable (ou pg_cron) qui crée la partition du
-- mois suivant avant la fin de chaque mois (voir modèle en fin de fichier).
-- ============================================================================

BEGIN;

-- 1. Renommer la table brute générée par Prisma
ALTER TABLE "PlaybackEvent" RENAME TO "PlaybackEvent_legacy";

-- 2. Créer la table partitionnée (structure + PK + index identiques)
CREATE TABLE "PlaybackEvent" (
  LIKE "PlaybackEvent_legacy" INCLUDING ALL
) PARTITION BY RANGE ("occurredAt");

-- 3. Partition par défaut (filet de sécurité) + partitions initiales
CREATE TABLE "PlaybackEvent_default" PARTITION OF "PlaybackEvent" DEFAULT;

-- À générer dynamiquement ; exemples :
-- CREATE TABLE "PlaybackEvent_2026_01" PARTITION OF "PlaybackEvent"
--   FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
-- CREATE TABLE "PlaybackEvent_2026_02" PARTITION OF "PlaybackEvent"
--   FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

-- 4. Migrer les données éventuelles puis basculer
INSERT INTO "PlaybackEvent" SELECT * FROM "PlaybackEvent_legacy";
DROP TABLE "PlaybackEvent_legacy";

COMMIT;

-- ============================================================================
-- Job de création de partition (à planifier, exécuté ~25 du mois) :
--
--   -- nom de partition pour le mois suivant :
--   SELECT to_char(date_trunc('month', now()) + interval '1 month', 'YYYY_MM');
--
--   CREATE TABLE "PlaybackEvent_YYYY_MM" PARTITION OF "PlaybackEvent"
--     FOR VALUES FROM ('YYYY-MM-01') TO ('YYYY-MM+1-01');
--
-- Retention (optionnel, décision produit) :
--   DETACH + DROP des partitions > 24 mois après export vers warehouse.
-- ============================================================================
