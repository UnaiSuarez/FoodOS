// Motores puros de FoodOS — Nutrition Engine v4.
// PR1: clasificador de aplicabilidad de evidencia. PR2A: kernel de
// asignación diaria de macros. El plan semanal (PR2B), exercise-v2.ts y
// adaptive-coordinator.ts llegan en PRs posteriores.
export * from "./nutrition-evidence-classifier";
// Solo allocateDailyMacros es API pública de PR2A — dedupeAndOrderInvalidReasons
// y dedupeAndOrderPolicyRequirements son detalles internos de construcción
// del resultado, exportados de macro-allocation-kernel.ts únicamente para
// que el test los importe por ruta relativa, nunca para uso externo.
export { allocateDailyMacros } from "./macro-allocation-kernel";
