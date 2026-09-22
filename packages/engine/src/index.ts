// Motores puros de FoodOS — Nutrition Engine v4 + Exercise Engine v2.
// PR1: clasificador de aplicabilidad de evidencia. PR2A: kernel de
// asignación diaria de macros. PR2B: kernel de plan semanal. PR3: kernel
// de estrategia semanal. PR4: kernel de señales de rendimiento de
// ejercicio. PR5A: kernels de tendencia de peso y de cobertura de registro
// de ingesta. El Adaptive Coordinator (PR5B) llega en un PR posterior.
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
// Igual que PR2A/PR2B: solo planWeeklyStrategy es API pública de PR3 —
// todos sus helpers (tabla energética, resolución de proteína, ESPEN,
// canonicalización) son funciones privadas de weekly-strategy-kernel.ts
// (sin `export`), probadas solo indirectamente a través del resultado
// público de planWeeklyStrategy.
export { planWeeklyStrategy } from "./weekly-strategy-kernel";
// Igual que PR1–PR3: solo evaluateExercisePerformance es API pública de
// PR4 — todos sus helpers (validación de fechas/forma, canonicalización,
// cálculo de señales) son funciones privadas de
// exercise-performance-kernel.ts (sin `export`), probadas solo
// indirectamente a través del resultado público de
// evaluateExercisePerformance.
export { evaluateExercisePerformance } from "./exercise-performance-kernel";
// Igual que PR1–PR4: PR5A añade exactamente dos funciones públicas,
// calculateWeightTrend y calculateIntakeLoggingCoverage. Todos sus helpers
// (fechas, canonicalización, validación por fases, cálculo) son funciones
// privadas de sus kernels, probadas solo a través del resultado público.
export { calculateWeightTrend } from "./weight-trend-kernel";
export { calculateIntakeLoggingCoverage } from "./intake-logging-coverage-kernel";
// Igual que PR1-PR5A: PR5B añade exactamente una función pública,
// evaluateAdaptiveReview. Todos sus helpers (fechas, canonicalización,
// clasificación semántica de cada señal upstream) son funciones privadas
// de adaptive-coordinator-kernel.ts (sin `export`), probadas solo
// indirectamente a través del resultado público de evaluateAdaptiveReview.
export { evaluateAdaptiveReview } from "./adaptive-coordinator-kernel";
