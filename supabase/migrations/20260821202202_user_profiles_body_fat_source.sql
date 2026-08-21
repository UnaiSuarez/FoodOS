-- FoodOS — Nutrition v3: procedencia del % de grasa corporal
-- Ver docs/NUTRITION_V3_DECISIONES.md §2.4/§4/§9 — v3 añade una procedencia
-- MÍNIMA del dato (bodyFatSource), sin implementar todavía un sistema
-- completo de confidence/provenance ni hacer depender la estrategia
-- nutricional de un score de confianza (eso queda aplazado a fase 2).
--
-- NULL representa "sin procedencia registrada" (perfiles históricos, o el
-- usuario no lo indicó) — no se añade un valor 'unknown' porque NULL ya
-- expresa exactamente eso; tener ambos crearía dos estados equivalentes.
-- Idempotente: ADD COLUMN IF NOT EXISTS.
--
-- Aplicada ya en remoto vía MCP apply_migration (2026-08-21) antes de
-- renombrar este archivo — mismo motivo que en
-- 20260821202150_user_profiles_age_min18.sql: el timestamp del nombre se
-- ajustó para coincidir con la versión registrada en el historial remoto,
-- no con la fecha de creación del archivo. El SQL no se re-ejecuta al
-- renombrar.

alter table public.user_profiles
  add column if not exists body_fat_source text
    check (body_fat_source is null or body_fat_source in (
      'dxa', 'bia_professional', 'smart_scale', 'skinfold', 'visual_estimate', 'other'
    ));

comment on column public.user_profiles.body_fat_source is
  'Procedencia del % de grasa corporal (body_fat_pct): dxa/bia_professional/smart_scale/skinfold/visual_estimate/other. NULL = sin procedencia registrada (perfiles históricos o no indicado). No se usa como score de confianza automático en v3, ver docs/NUTRITION_V3_DECISIONES.md §9.';
