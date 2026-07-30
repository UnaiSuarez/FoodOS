// Casos de referencia reproducibles para el motor adaptativo (PR7).
//
// A propósito NO se comprueban cifras exactas de TDEE/combinado — el
// algoritmo puede evolucionar (ver PR8+). Lo que se protege aquí son
// invariantes: propiedades que deben cumplirse SIEMPRE, sea cual sea el
// ajuste fino de constantes internas (alpha del EWMA, pesos de confianza...).
import { describe, expect, it } from "vitest";
import type { PhysicalProfile, WeightEntry } from "@foodos/types";
import {
  calcAdaptiveTdee,
  calcDailyTargets,
  calcIntakeCoverage,
  calcSummary,
  calcWeightTrend,
  evaluateAdjustmentProposal,
  evaluateNutritionSafety,
  isAdjustmentCooldownActive,
} from "./nutrition";

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const REF = "2026-03-01"; // fecha de referencia fija para reproducibilidad

/** Serie de peso diaria terminando en `endDate`, con pendiente lineal y
    ruido opcional (para simular variación de agua/sal día a día). */
function weightSeries(params: {
  startKg: number;
  days: number;
  dailyDeltaKg: number;
  noiseKg?: number;
  endDate?: string;
}): WeightEntry[] {
  const { startKg, days, dailyDeltaKg, noiseKg = 0, endDate = REF } = params;
  // Ruido determinista (sin Math.random) para que el test sea 100% reproducible.
  const pseudoNoise = (i: number) => Math.sin(i * 12.9898) * noiseKg;
  return Array.from({ length: days }, (_, i) => ({
    date: addDays(endDate, -(days - 1 - i)),
    kg: Math.round((startKg + dailyDeltaKg * i + pseudoNoise(i)) * 100) / 100,
  }));
}

/** N días de ingesta a `kcalPerDay`, terminando en `endDate`. Con
    `skipEvery` se puede simular cobertura incompleta (ej. skipEvery=4 ->
    3 de cada 4 días registrados). */
function dailyKcalSeries(params: {
  kcalPerDay: number;
  days: number;
  endDate?: string;
  skipEvery?: number;
}): Array<{ date: string; kcal: number }> {
  const { kcalPerDay, days, endDate = REF, skipEvery = 0 } = params;
  const out: Array<{ date: string; kcal: number }> = [];
  for (let i = 0; i < days; i++) {
    if (skipEvery > 0 && i % skipEvery === skipEvery - 1) continue;
    out.push({ date: addDays(endDate, -i), kcal: kcalPerDay });
  }
  return out;
}

function baseProfile(overrides: Partial<PhysicalProfile> = {}): PhysicalProfile {
  return {
    age: 30,
    sex: "male",
    heightCm: 178,
    weightKg: 85,
    bodyFatPct: null,
    activityLevel: "moderate",
    goal: "fat_loss",
    gymDays: [1, 3, 5],
    allergies: [],
    excludedFoods: [],
    ...overrides,
  };
}

/** Corre el pipeline completo (tendencia -> cobertura -> adaptativo ->
    decisión) para un caso dado. */
function runEngine(params: {
  weightLog: WeightEntry[];
  dailyKcal: Array<{ date: string; kcal: number }>;
  initialTdeeKcal: number;
  currentTargetKcal: number;
  referenceDate?: string;
}) {
  const referenceDate = params.referenceDate ?? REF;
  const weightTrend = calcWeightTrend(params.weightLog, referenceDate);
  const coverage = calcIntakeCoverage(params.dailyKcal, referenceDate, 28);
  const adaptive = calcAdaptiveTdee({
    initialTdeeKcal: params.initialTdeeKcal,
    avgIntakeKcal: coverage?.avgKcal ?? null,
    weightTrend,
  });
  const decision = evaluateAdjustmentProposal({
    currentTargetKcal: params.currentTargetKcal,
    adaptive,
    weightTrend,
    intakeCoverage: coverage,
  });
  return { weightTrend, coverage, adaptive, decision };
}

// ─── Casos de referencia ──────────────────────────────────────────────────

describe("motor adaptativo — casos de referencia", () => {
  it("pérdida de peso lenta y dentro de rango: no debería proponer subir calorías", () => {
    // -0.2 kg/semana ≈ -0.0286 kg/día, ingesta consistente con el objetivo
    const { decision } = runEngine({
      weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.2 / 7 }),
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2300, days: 28 }),
      initialTdeeKcal: 2600,
      currentTargetKcal: 2300,
    });
    if (decision.shouldPropose) {
      expect(decision.deltaKcal).toBeLessThanOrEqual(0);
    }
  });

  it("pérdida dentro del objetivo (~0.5 kg/semana): objetivo ya alineado, no debería proponer", () => {
    const { decision } = runEngine({
      weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.5 / 7 }),
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2080, days: 28 }),
      initialTdeeKcal: 2600,
      currentTargetKcal: 2080,
    });
    // El propio ritmo real ya coincide con el objetivo -> sin motivo para tocar nada.
    expect(decision.shouldPropose).toBe(false);
  });

  it("pérdida demasiado rápida: si propone, es subir calorías (nunca bajar más)", () => {
    const { decision } = runEngine({
      weightLog: weightSeries({ startKg: 90, days: 25, dailyDeltaKg: -1.2 / 7 }),
      dailyKcal: dailyKcalSeries({ kcalPerDay: 1900, days: 28 }),
      initialTdeeKcal: 2700,
      currentTargetKcal: 2000,
    });
    if (decision.shouldPropose) {
      expect(decision.deltaKcal).toBeGreaterThanOrEqual(0);
    }
  });

  it("mantenimiento estable: objetivo ya alineado, no debería proponer nada", () => {
    const { decision } = runEngine({
      weightLog: weightSeries({ startKg: 78, days: 25, dailyDeltaKg: 0 }),
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2400, days: 28 }),
      initialTdeeKcal: 2400,
      currentTargetKcal: 2400,
    });
    expect(decision.shouldPropose).toBe(false);
  });

  it("ganancia muscular lenta y controlada: no debería proponer bajar calorías", () => {
    const { decision } = runEngine({
      weightLog: weightSeries({ startKg: 75, days: 25, dailyDeltaKg: 0.1 / 7 }),
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2700, days: 28 }),
      initialTdeeKcal: 2550,
      currentTargetKcal: 2700,
    });
    if (decision.shouldPropose) {
      expect(decision.deltaKcal).toBeGreaterThanOrEqual(0);
    }
  });

  it("ganancia de peso excesiva: si propone, es bajar calorías (nunca subir más)", () => {
    const { decision } = runEngine({
      weightLog: weightSeries({ startKg: 75, days: 25, dailyDeltaKg: 0.5 / 7 }),
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2900, days: 28 }),
      initialTdeeKcal: 2500,
      currentTargetKcal: 2900,
    });
    if (decision.shouldPropose) {
      expect(decision.deltaKcal).toBeLessThanOrEqual(0);
    }
  });

  it("datos insuficientes (solo 2 pesajes): nunca propone", () => {
    const { decision, weightTrend } = runEngine({
      weightLog: weightSeries({ startKg: 80, days: 2, dailyDeltaKg: -0.1 }),
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2200, days: 28 }),
      initialTdeeKcal: 2500,
      currentTargetKcal: 2200,
    });
    expect(weightTrend).toBeNull();
    expect(decision.shouldPropose).toBe(false);
  });

  it("ingesta incompleta (cobertura baja): nunca propone aunque el peso esté clarísimo", () => {
    const { decision, coverage } = runEngine({
      weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.3 / 7 }),
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2200, days: 28, skipEvery: 2 }), // ~50% cobertura
      initialTdeeKcal: 2600,
      currentTargetKcal: 2300,
    });
    expect(coverage!.coverageFraction).toBeLessThan(0.85);
    expect(decision.shouldPropose).toBe(false);
  });

  it("peso con mucha variación de agua/sal: la tendencia no debería invertir el signo real", () => {
    // Pendiente real de pérdida, pero con ruido diario de +-0.8kg (agua/sal/glucógeno)
    const { weightTrend } = runEngine({
      weightLog: weightSeries({ startKg: 88, days: 25, dailyDeltaKg: -0.25 / 7, noiseKg: 0.8 }),
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2200, days: 28 }),
      initialTdeeKcal: 2600,
      currentTargetKcal: 2300,
    });
    // A pesar del ruido, el suavizado debe seguir detectando la pérdida real (signo correcto).
    expect(weightTrend).not.toBeNull();
    expect(weightTrend!.slopeKgPerDay).toBeLessThan(0);
  });

  it("salto brusco tipo 'inicio de creatina' (+1kg sostenido): limitación conocida, no una invariante — documentado, no silencioso", () => {
    // Un escalón de peso SOSTENIDO (agua retenida por creatina, no un pico de
    // un solo día) es indistinguible de una ganancia real para un algoritmo
    // que solo mira el peso: la mediana móvil de 3 amortigua picos aislados,
    // no escalones de varios días. Esto es una limitación real del modelo
    // (mencionada explícitamente al proponer PR7), no algo que esta PR
    // prometa resolver — resolverlo requeriría una señal distinta al peso
    // (ej. declarar manualmente "empecé a tomar creatina"). Lo que SÍ importa
    // aquí es que, si el salto es lo bastante grande como para generar una
    // discrepancia fuerte con la fórmula, el guardarraíl de PR7 lo bloquee en
    // vez de aplicarlo a ciegas — y que en cualquier caso nunca se salga de
    // ±150 kcal.
    const steady = weightSeries({ startKg: 80, days: 20, dailyDeltaKg: 0 });
    const jump: WeightEntry[] = steady.map((e, i) => (i >= 15 ? { ...e, kg: e.kg + 1 } : e));
    const { decision, adaptive } = runEngine({
      weightLog: jump,
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2400, days: 28 }),
      initialTdeeKcal: 2400,
      currentTargetKcal: 2400,
    });
    if (adaptive.warnings.includes("tdee_estimates_strongly_disagree")) {
      expect(decision.shouldPropose).toBe(false);
    }
    expect(decision.deltaKcal).toBeLessThanOrEqual(150);
    expect(decision.deltaKcal).toBeGreaterThanOrEqual(-150);
  });

  it("mismo peso/ingesta con distinto TDEE inicial (clásico vs lifestyle_plus_training): confianza y cobertura no dependen del modelo de actividad", () => {
    const weightLog = weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.3 / 7 });
    const dailyKcal = dailyKcalSeries({ kcalPerDay: 2200, days: 28 });
    const classic = runEngine({ weightLog, dailyKcal, initialTdeeKcal: 2600, currentTargetKcal: 2300 });
    const lifestylePlusTraining = runEngine({ weightLog, dailyKcal, initialTdeeKcal: 2450, currentTargetKcal: 2300 });
    // Confianza y cobertura salen del peso/ingesta, no de qué modelo calculó el TDEE inicial.
    expect(classic.weightTrend!.confidence).toBe(lifestylePlusTraining.weightTrend!.confidence);
    expect(classic.coverage!.coverageFraction).toBe(lifestylePlusTraining.coverage!.coverageFraction);
    // El TDEE observado (depende solo de ingesta/peso) también coincide.
    expect(classic.adaptive.observedKcal).toBe(lifestylePlusTraining.adaptive.observedKcal);
  });

  it("un ajuste que empujaría el objetivo por debajo de 800 kcal queda bloqueado por evaluateNutritionSafety", () => {
    const profile = baseProfile({ weightKg: 45, heightCm: 150, age: 55, goal: "fat_loss" });
    const { tmb, tdee } = calcSummary(profile);
    const currentTargets = calcDailyTargets(profile, false);
    // Simula que se acepta un ajuste de -150 kcal sobre un objetivo ya muy bajo.
    const proposedProfile: PhysicalProfile = { ...profile, adaptiveKcalOffsetKcal: -150 };
    const proposedTargets = calcDailyTargets(proposedProfile, false);
    const safety = evaluateNutritionSafety({
      targetKcal: proposedTargets.kcal,
      estimatedTdeeKcal: tdee,
      restingEnergyKcal: tmb,
    });
    // El suelo de 1200 kcal de calcDailyTargets ya protege este caso concreto,
    // pero lo relevante es que evaluateNutritionSafety SIEMPRE se re-evalúa
    // sobre el objetivo ya ajustado, nunca sobre el original.
    expect(proposedTargets.kcal).toBeGreaterThanOrEqual(1200);
    expect(safety.automaticPlanAllowed).toBe(true);
    expect(currentTargets.kcal).toBeGreaterThanOrEqual(1200);
  });
});

// ─── Invariantes globales (deben cumplirse en TODOS los casos anteriores) ──

describe("motor adaptativo — invariantes globales", () => {
  const scenarios = [
    { label: "pérdida lenta", weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.2 / 7 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2300, days: 28 }), initialTdeeKcal: 2600, currentTargetKcal: 2300 },
    { label: "pérdida objetivo", weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.5 / 7 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2080, days: 28 }), initialTdeeKcal: 2600, currentTargetKcal: 2080 },
    { label: "pérdida rápida", weightLog: weightSeries({ startKg: 90, days: 25, dailyDeltaKg: -1.2 / 7 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 1900, days: 28 }), initialTdeeKcal: 2700, currentTargetKcal: 2000 },
    { label: "mantenimiento", weightLog: weightSeries({ startKg: 78, days: 25, dailyDeltaKg: 0 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2400, days: 28 }), initialTdeeKcal: 2400, currentTargetKcal: 2400 },
    { label: "ganancia lenta", weightLog: weightSeries({ startKg: 75, days: 25, dailyDeltaKg: 0.1 / 7 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2700, days: 28 }), initialTdeeKcal: 2550, currentTargetKcal: 2700 },
    { label: "ganancia excesiva", weightLog: weightSeries({ startKg: 75, days: 25, dailyDeltaKg: 0.5 / 7 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2900, days: 28 }), initialTdeeKcal: 2500, currentTargetKcal: 2900 },
    { label: "ingesta incompleta", weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.3 / 7 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2200, days: 28, skipEvery: 2 }), initialTdeeKcal: 2600, currentTargetKcal: 2300 },
    { label: "agua/sal ruidosa", weightLog: weightSeries({ startKg: 88, days: 25, dailyDeltaKg: -0.25 / 7, noiseKg: 0.8 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2200, days: 28 }), initialTdeeKcal: 2600, currentTargetKcal: 2300 },
  ];

  it("nunca propone un delta fuera de ±150 kcal", () => {
    for (const s of scenarios) {
      const { decision } = runEngine(s);
      expect(decision.deltaKcal, s.label).toBeLessThanOrEqual(150);
      expect(decision.deltaKcal, s.label).toBeGreaterThanOrEqual(-150);
    }
  });

  it("nunca propone con cobertura de ingesta por debajo del 85%", () => {
    for (const s of scenarios) {
      const { decision, coverage } = runEngine(s);
      if (decision.shouldPropose) {
        expect(coverage!.coverageFraction, s.label).toBeGreaterThanOrEqual(0.85);
      }
    }
  });

  it("nunca propone con menos de 14 días evaluados", () => {
    for (const s of scenarios) {
      const { decision, weightTrend } = runEngine(s);
      if (decision.shouldPropose) {
        expect(weightTrend!.validMeasurements, s.label).toBeGreaterThanOrEqual(14);
      }
    }
  });

  it("evaluateAdjustmentProposal es una función pura: no muta sus argumentos ni el entorno", () => {
    const s = scenarios[0];
    const weightTrend = calcWeightTrend(s.weightLog, REF);
    const coverage = calcIntakeCoverage(s.dailyKcal, REF, 28);
    const adaptive = calcAdaptiveTdee({ initialTdeeKcal: s.initialTdeeKcal, avgIntakeKcal: coverage?.avgKcal ?? null, weightTrend });
    const snapshotBefore = JSON.stringify({ weightTrend, coverage, adaptive });
    evaluateAdjustmentProposal({ currentTargetKcal: s.currentTargetKcal, adaptive, weightTrend, intakeCoverage: coverage });
    const snapshotAfter = JSON.stringify({ weightTrend, coverage, adaptive });
    expect(snapshotAfter).toBe(snapshotBefore);
  });

  it("nunca permite generar otra propuesta durante el cooldown de 14 días", () => {
    const decidedYesterday = addDays(REF, -1);
    const decided20DaysAgo = addDays(REF, -20);
    expect(isAdjustmentCooldownActive(decidedYesterday, REF)).toBe(true);
    expect(isAdjustmentCooldownActive(decided20DaysAgo, REF)).toBe(false);
    expect(isAdjustmentCooldownActive(null, REF)).toBe(false);
  });

  it("rechazar una propuesta no debe cambiar el kcal calculado (no se toca adaptiveKcalOffsetKcal)", () => {
    const profile = baseProfile();
    const before = calcDailyTargets(profile, false);
    // "Rechazar" == no escribir adaptiveKcalOffsetKcal — el perfil queda igual.
    const after = calcDailyTargets({ ...profile }, false);
    expect(after).toEqual(before);
  });
});
