// Nutrition Engine v4 — ÚNICO punto de la aplicación autorizado a importar
// el paquete de kernels puros (ver packages/engine/src/test-support/
// web-boundary.ts y su uso en cada *-kernel.test.ts: ese mismo helper, y
// solo para ESTE archivo exacto, deja pasar la mención que en cualquier
// otro archivo de apps/web/src haría fallar la prueba de frontera).
//
// Responsabilidad ÚNICA: evaluar cobertura de integridad nutricional de
// SOLO LECTURA. Esta función no escribe nada, no llama a Supabase, no lee
// ni cambia ningún estado mutable, no dispara ninguna propuesta adaptativa
// y no cambia ningún objetivo — es, literalmente, `input -> resultado`,
// sin nada más. Quien la llama decide qué hacer con el resultado; este
// archivo no decide nada por su cuenta.
//
// Importa del BARREL público del paquete (packages/engine/src/index.ts),
// no de un archivo interno por ruta profunda: es la superficie que ese
// paquete declara como su API — el propio barrel documenta, kernel a
// kernel, que cada uno expone exactamente una función pública. Las pruebas
// de frontera (ver más abajo) verifican que este archivo no importa NADA
// MÁS de ese barrel.
import { evaluateNutrientCoverage } from "@foodos/engine";
import type { DailyIntegrityResult, DailyIntegrityWindowInput } from "@foodos/types";

/**
 * Evalúa cobertura de integridad nutricional para una ventana ya construida
 * (ver `buildDiaryIntegrityInput`, nutrition-v4-adapter.ts). Pura y
 * síncrona: mismo input siempre produce el mismo resultado, nunca muta el
 * input recibido. No decide ningún umbral — los recibe siempre de quien
 * llama (ver `DailyIntegrityWindowInput.dailyReliabilityThreshold`/
 * `provisionalKcalFractionThreshold`).
 */
export function evaluateDiaryNutrientCoverageReadOnly(input: DailyIntegrityWindowInput): DailyIntegrityResult {
  return evaluateNutrientCoverage(input);
}
