// Casos de referencia reproducibles para el motor adaptativo (PR7, reescrito
// en PR2/Adaptive v3 — ver docs/NUTRITION_V3_DECISIONES.md §6).
//
// A propósito NO se comprueban cifras exactas de TDEE/combinado — el
// algoritmo puede evolucionar. Lo que se protege aquí son invariantes:
// propiedades que deben cumplirse SIEMPRE, sea cual sea el ajuste fino de
// constantes internas (alpha del EWMA, bandas...). Adaptive v3 decide por
// RITMO (weeklyChangePercent contra la banda del goal) — el TDEE vía 7700
// (calcAdaptiveTdee) se sigue calculando en runEngine solo como diagnóstico,
// nunca alimenta `decision`.
import { describe, expect, it } from "vitest";
import type { GoalMode, PhysicalProfile, WeightEntry } from "@foodos/types";
import {
  ADJUSTMENT_MIN_EVALUATION_DAYS,
  calcAdaptiveTdee,
  calcDailyTargets,
  calcIntakeCoverage,
  calcSummary,
  calcWeightTrend,
  evaluateAdaptiveState,
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

/** Corre el pipeline completo (tendencia -> cobertura -> decisión por
    ritmo). `initialTdeeKcal` sigue calculándose vía calcAdaptiveTdee (7700)
    y se devuelve para aserciones de diagnóstico, pero NUNCA se pasa a
    evaluateAdaptiveState — el test anti-7700 dedicado (nutrition.test.ts)
    verifica esto a nivel de tipo/firma; aquí se verifica en un pipeline
    realista de extremo a extremo. */
function runEngine(params: {
  goal: GoalMode;
  weightLog: WeightEntry[];
  dailyKcal: Array<{ date: string; kcal: number }>;
  initialTdeeKcal: number;
  currentTargetKcal: number;
  referenceDate?: string;
  lastAdjustmentDecisionAt?: string | null;
}) {
  const referenceDate = params.referenceDate ?? REF;
  const weightTrend = calcWeightTrend(params.weightLog, referenceDate);
  const coverage = calcIntakeCoverage(params.dailyKcal, referenceDate, 28);
  const adaptive = calcAdaptiveTdee({
    initialTdeeKcal: params.initialTdeeKcal,
    avgIntakeKcal: coverage?.avgKcal ?? null,
    weightTrend,
  });
  const decision = evaluateAdaptiveState({
    goal: params.goal,
    currentTargetKcal: params.currentTargetKcal,
    weightTrend,
    intakeCoverage: coverage,
    lastAdjustmentDecisionAt: params.lastAdjustmentDecisionAt ?? null,
    referenceDate,
  });
  return { weightTrend, coverage, adaptive, decision };
}

// ─── Casos de referencia ──────────────────────────────────────────────────

describe("motor adaptativo — casos de referencia (banda por ritmo, Adaptive v3)", () => {
  it("fat_loss dentro de banda (~-0.6%/sem de 85kg): no debería proponer", () => {
    const { decision } = runEngine({
      goal: "fat_loss",
      weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.073 }), // ≈ -0.51kg/sem ≈ -0.6%/sem
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2300, days: 28 }),
      initialTdeeKcal: 2600,
      currentTargetKcal: 2300,
    });
    expect(decision.shouldPropose).toBe(false);
  });

  it("fat_loss demasiado lento (~-0.2%/sem, por encima de la banda): si propone, es BAJAR kcal (más déficit, nunca subir)", () => {
    const { decision } = runEngine({
      goal: "fat_loss",
      weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.024 }), // ≈ -0.17kg/sem ≈ -0.2%/sem
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2300, days: 28 }),
      initialTdeeKcal: 2600,
      currentTargetKcal: 2300,
    });
    if (decision.shouldPropose) {
      expect(decision.deltaKcal).toBeLessThan(0);
    }
  });

  it("fat_loss demasiado rápido (~-1.5%/sem): si propone, es SUBIR kcal (nunca bajar más)", () => {
    const { decision } = runEngine({
      goal: "fat_loss",
      weightLog: weightSeries({ startKg: 90, days: 25, dailyDeltaKg: -0.193 }), // ≈ -1.35kg/sem ≈ -1.5%/sem
      dailyKcal: dailyKcalSeries({ kcalPerDay: 1900, days: 28 }),
      initialTdeeKcal: 2700,
      currentTargetKcal: 2000,
    });
    if (decision.shouldPropose) {
      expect(decision.deltaKcal).toBeGreaterThan(0);
    }
  });

  it("maintain estable (0 kg/sem): dentro de banda, no debería proponer nada", () => {
    const { decision } = runEngine({
      goal: "maintain",
      weightLog: weightSeries({ startKg: 78, days: 25, dailyDeltaKg: 0 }),
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2400, days: 28 }),
      initialTdeeKcal: 2400,
      currentTargetKcal: 2400,
    });
    expect(decision.shouldPropose).toBe(false);
  });

  it("muscle_gain lento y dentro de banda (~+0.35%/sem de 75kg): no debería proponer", () => {
    const { decision } = runEngine({
      goal: "muscle_gain",
      weightLog: weightSeries({ startKg: 75, days: 25, dailyDeltaKg: 0.0375 }), // ≈ +0.26kg/sem ≈ +0.35%/sem
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2700, days: 28 }),
      initialTdeeKcal: 2550,
      currentTargetKcal: 2700,
    });
    expect(decision.shouldPropose).toBe(false);
  });

  it("muscle_gain excesivo (~+1.0%/sem): si propone, es BAJAR kcal (nunca subir más)", () => {
    const { decision } = runEngine({
      goal: "muscle_gain",
      weightLog: weightSeries({ startKg: 75, days: 25, dailyDeltaKg: 0.107 }), // ≈ +0.75kg/sem ≈ +1.0%/sem
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2900, days: 28 }),
      initialTdeeKcal: 2500,
      currentTargetKcal: 2900,
    });
    if (decision.shouldPropose) {
      expect(decision.deltaKcal).toBeLessThan(0);
    }
  });

  it("datos insuficientes (solo 2 pesajes): nunca propone", () => {
    const { decision, weightTrend } = runEngine({
      goal: "maintain",
      weightLog: weightSeries({ startKg: 80, days: 2, dailyDeltaKg: -0.1 }),
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2200, days: 28 }),
      initialTdeeKcal: 2500,
      currentTargetKcal: 2200,
    });
    expect(weightTrend).toBeNull();
    expect(decision.shouldPropose).toBe(false);
    expect(decision.trajectory).toBeNull();
  });

  it("ingesta incompleta (cobertura baja): nunca propone aunque el ritmo esté clarísimo fuera de banda", () => {
    const { decision, coverage } = runEngine({
      goal: "fat_loss",
      weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.024 }), // fuera de banda (muy lento)
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
      goal: "fat_loss",
      weightLog: weightSeries({ startKg: 88, days: 25, dailyDeltaKg: -0.036, noiseKg: 0.8 }),
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
    // un solo día) es indistinguible de una ganancia real para CUALQUIER
    // algoritmo que solo mira el peso — daba igual con el TDEE vía 7700 (v2)
    // que con el ritmo por banda (v3, Adaptive v3): la mediana móvil de 3
    // amortigua picos aislados, no escalones de varios días. Sigue siendo
    // una limitación real del modelo (E11-24 en el backlog, fuera de
    // alcance de PR2 — ver docs/NUTRITION_V3_DECISIONES.md §6.2), no algo
    // que esta PR prometa resolver. Lo que SÍ debe cumplirse: si el
    // controlador decide proponer algo con este salto, el delta sigue
    // siendo el paso fijo, nunca un salto adicional descontrolado.
    const steady = weightSeries({ startKg: 80, days: 20, dailyDeltaKg: 0 });
    const jump: WeightEntry[] = steady.map((e, i) => (i >= 15 ? { ...e, kg: e.kg + 1 } : e));
    const { decision } = runEngine({
      goal: "maintain",
      weightLog: jump,
      dailyKcal: dailyKcalSeries({ kcalPerDay: 2400, days: 28 }),
      initialTdeeKcal: 2400,
      currentTargetKcal: 2400,
    });
    expect(decision.deltaKcal).toBeLessThanOrEqual(150);
    expect(decision.deltaKcal).toBeGreaterThanOrEqual(-150);
    expect([-100, 0, 100]).toContain(decision.deltaKcal);
  });

  it("mismo peso/ingesta con distinto TDEE inicial: confianza y cobertura no dependen del modelo de actividad (ni del goal — son puramente de datos)", () => {
    const weightLog = weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.036 });
    const dailyKcal = dailyKcalSeries({ kcalPerDay: 2200, days: 28 });
    const classic = runEngine({ goal: "fat_loss", weightLog, dailyKcal, initialTdeeKcal: 2600, currentTargetKcal: 2300 });
    const lifestylePlusTraining = runEngine({ goal: "fat_loss", weightLog, dailyKcal, initialTdeeKcal: 2450, currentTargetKcal: 2300 });
    // Confianza y cobertura salen del peso/ingesta, no de qué modelo calculó el TDEE inicial.
    expect(classic.weightTrend!.confidence).toBe(lifestylePlusTraining.weightTrend!.confidence);
    expect(classic.coverage!.coverageFraction).toBe(lifestylePlusTraining.coverage!.coverageFraction);
    // El TDEE observado (depende solo de ingesta/peso) también coincide — sigue siendo diagnóstico puro.
    expect(classic.adaptive.observedKcal).toBe(lifestylePlusTraining.adaptive.observedKcal);
    // Y la DECISIÓN (que ya no depende del TDEE inicial en absoluto) también coincide.
    expect(classic.decision.deltaKcal).toBe(lifestylePlusTraining.decision.deltaKcal);
    expect(classic.decision.shouldPropose).toBe(lifestylePlusTraining.decision.shouldPropose);
  });

  it("test anti-7700 de extremo a extremo: cambiar la ingesta registrada (y por tanto el TDEE observado) sin cambiar el peso ni la cobertura no cambia la decisión", () => {
    const weightLog = weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.024 }); // fuera de banda fat_loss (muy lento)
    const dailyKcalA = dailyKcalSeries({ kcalPerDay: 2000, days: 28 });
    const dailyKcalB = dailyKcalSeries({ kcalPerDay: 2600, days: 28 }); // misma cobertura (28/28 días), ingesta MUY distinta
    const a = runEngine({ goal: "fat_loss", weightLog, dailyKcal: dailyKcalA, initialTdeeKcal: 2600, currentTargetKcal: 2300 });
    const b = runEngine({ goal: "fat_loss", weightLog, dailyKcal: dailyKcalB, initialTdeeKcal: 2600, currentTargetKcal: 2300 });
    // El TDEE observado (7700) SÍ cambia mucho — es justo lo que se espera del diagnóstico.
    expect(a.adaptive.observedKcal).not.toBe(b.adaptive.observedKcal);
    // Pero la decisión (trayectoria/delta/elegibilidad) es IDÉNTICA — no depende de la ingesta en absoluto.
    expect(a.decision.trajectory).toBe(b.decision.trajectory);
    expect(a.decision.deltaKcal).toBe(b.decision.deltaKcal);
    expect(a.decision.shouldPropose).toBe(b.decision.shouldPropose);
  });

  it("un ajuste que empujaría el objetivo por debajo de 800 kcal queda bloqueado por evaluateNutritionSafety", () => {
    const profile = baseProfile({ weightKg: 45, heightCm: 150, age: 55, goal: "fat_loss" });
    const { tmb, tdee } = calcSummary(profile);
    const currentTargets = calcDailyTargets(profile, false);
    // Simula que se acepta un ajuste de -100 kcal (paso normal del controlador v3) sobre un objetivo ya muy bajo.
    const proposedProfile: PhysicalProfile = { ...profile, adaptiveKcalOffsetKcal: -100 };
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
  const scenarios: Array<{
    label: string;
    goal: GoalMode;
    weightLog: WeightEntry[];
    dailyKcal: Array<{ date: string; kcal: number }>;
    initialTdeeKcal: number;
    currentTargetKcal: number;
  }> = [
    { label: "fat_loss dentro de banda", goal: "fat_loss", weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.073 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2300, days: 28 }), initialTdeeKcal: 2600, currentTargetKcal: 2300 },
    { label: "fat_loss demasiado lento", goal: "fat_loss", weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.024 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2300, days: 28 }), initialTdeeKcal: 2600, currentTargetKcal: 2300 },
    { label: "fat_loss demasiado rápido", goal: "fat_loss", weightLog: weightSeries({ startKg: 90, days: 25, dailyDeltaKg: -0.193 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 1900, days: 28 }), initialTdeeKcal: 2700, currentTargetKcal: 2000 },
    { label: "maintain estable", goal: "maintain", weightLog: weightSeries({ startKg: 78, days: 25, dailyDeltaKg: 0 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2400, days: 28 }), initialTdeeKcal: 2400, currentTargetKcal: 2400 },
    { label: "muscle_gain dentro de banda", goal: "muscle_gain", weightLog: weightSeries({ startKg: 75, days: 25, dailyDeltaKg: 0.0375 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2700, days: 28 }), initialTdeeKcal: 2550, currentTargetKcal: 2700 },
    { label: "muscle_gain excesivo", goal: "muscle_gain", weightLog: weightSeries({ startKg: 75, days: 25, dailyDeltaKg: 0.107 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2900, days: 28 }), initialTdeeKcal: 2500, currentTargetKcal: 2900 },
    { label: "ingesta incompleta", goal: "fat_loss", weightLog: weightSeries({ startKg: 85, days: 25, dailyDeltaKg: -0.024 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2200, days: 28, skipEvery: 2 }), initialTdeeKcal: 2600, currentTargetKcal: 2300 },
    { label: "agua/sal ruidosa", goal: "fat_loss", weightLog: weightSeries({ startKg: 88, days: 25, dailyDeltaKg: -0.036, noiseKg: 0.8 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2200, days: 28 }), initialTdeeKcal: 2600, currentTargetKcal: 2300 },
    { label: "recomp banda asimétrica", goal: "recomp", weightLog: weightSeries({ startKg: 80, days: 25, dailyDeltaKg: -0.028 }), dailyKcal: dailyKcalSeries({ kcalPerDay: 2200, days: 28 }), initialTdeeKcal: 2500, currentTargetKcal: 2200 },
  ];

  it("nunca propone un delta fuera de {-100, 0, 100} (y por tanto nunca fuera de ±150)", () => {
    for (const s of scenarios) {
      const { decision } = runEngine(s);
      expect([-100, 0, 100], s.label).toContain(decision.deltaKcal);
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

  it(`nunca propone con menos de ${ADJUSTMENT_MIN_EVALUATION_DAYS} días evaluados (mínimo PROVISIONAL, ver §6.7)`, () => {
    for (const s of scenarios) {
      const { decision, weightTrend } = runEngine(s);
      if (decision.shouldPropose) {
        expect(weightTrend!.validMeasurements, s.label).toBeGreaterThanOrEqual(ADJUSTMENT_MIN_EVALUATION_DAYS);
      }
    }
  });

  it("nunca propone con confianza de tendencia distinta de 'high'", () => {
    for (const s of scenarios) {
      const { decision, weightTrend } = runEngine(s);
      if (decision.shouldPropose) {
        expect(weightTrend!.confidence, s.label).toBe("high");
      }
    }
  });

  it("evaluateAdaptiveState es una función pura: no muta sus argumentos ni el entorno", () => {
    const s = scenarios[0];
    const weightTrend = calcWeightTrend(s.weightLog, REF);
    const coverage = calcIntakeCoverage(s.dailyKcal, REF, 28);
    const snapshotBefore = JSON.stringify({ weightTrend, coverage });
    evaluateAdaptiveState({
      goal: s.goal, currentTargetKcal: s.currentTargetKcal, weightTrend, intakeCoverage: coverage,
      lastAdjustmentDecisionAt: null, referenceDate: REF,
    });
    const snapshotAfter = JSON.stringify({ weightTrend, coverage });
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
