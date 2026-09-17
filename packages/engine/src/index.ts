// Motores puros de FoodOS — Nutrition Engine v4.
// PR1: clasificador de aplicabilidad de evidencia. PR2A: kernel de
// asignación diaria de macros. PR2B: kernel de plan semanal.
// exercise-v2.ts y adaptive-coordinator.ts llegan en PRs posteriores.
export * from "./nutrition-evidence-classifier";
// Solo allocateDailyMacros es API pública de PR2A — dedupeAndOrderInvalidReasons
// y dedupeAndOrderPolicyRequirements son funciones privadas de
// macro-allocation-kernel.ts (sin `export`): no se exportan ni desde ese
// módulo ni desde este barrel, así que no son alcanzables ni por import
// directo ni por deep import. Se prueban solo indirectamente, observando el
// resultado público de allocateDailyMacros (orden, deduplicación e
// inmutabilidad de sus reasons[]).
export { allocateDailyMacros } from "./macro-allocation-kernel";
// Igual que PR2A: solo planWeek es API pública de PR2B — todos sus
// helpers (fechas, canonicalización, validación de mapas, resto mayor)
// son funciones privadas de weekly-plan-kernel.ts (sin `export`),
// probadas solo indirectamente a través del resultado público de planWeek.
export { planWeek } from "./weekly-plan-kernel";
