import { describe, expect, it } from "vitest";
import type { AdaptiveTdeeResult, GoalMode, IntakeCoverageResult, PhysicalProfile, Recipe, TrainingActivityProfile, WeightEntry, WeightTrendResult } from "@foodos/types";
import {
  assessWeightTrajectory,
  buildAdjustmentEvidence,
  buildAdjustmentProfileFingerprint,
  buildCalorieBreakdownExplanation,
  calcAdaptiveTdee,
  calcDailyTargets,
  calcHabitualTrainingAllowanceKcal,
  calcIMC,
  calcIntakeCoverage,
  calcTdeeBreakdown,
  calcProteinBase,
  calcProteinRange,
  calcSummary,
  calcTDEE,
  calcTMB,
  calcWeightTrend,
  calculateFiberTarget,
  describeCalorieVsTdee,
  distributeWeeklyCalories,
  estimateTdeeUncertainty,
  estimateWorkoutKcal,
  evaluateAdaptiveState,
  evaluateNutritionSafety,
  explainCalorieCycle,
  filterEntriesFromCalibrationStart,
  getAdaptiveDiagnostics,
  GOAL_RATE_BAND_PCT_PER_WEEK,
  isProposalStale,
  isRelevantCalibrationChange,
  metForMuscleGroups,
  migrateLegacyTrainingActivity,
  monthlyAmountOf,
  NUTRITION_ENGINE_VERSION,
  projectSavings,
  PROTEIN_PER_KG_BY_BASE_AND_GOAL,
  resolveProteinBase,
  scaleByCalories,
  scaleByRatio,
  usesEspenAdjustedWeight,
  validateTrainingActivity,
  weeklyCycle,
} from "./nutrition";

describe("calcTMB (Mifflin-St Jeor)", () => {
  it("hombre: 10*peso + 6.25*altura - 5*edad + 5", () => {
    expect(calcTMB(75, 175, 25, "male")).toBe(Math.round(10 * 75 + 6.25 * 175 - 5 * 25 + 5));
  });

  it("mujer: 10*peso + 6.25*altura - 5*edad - 161", () => {
    expect(calcTMB(60, 165, 30, "female")).toBe(Math.round(10 * 60 + 6.25 * 165 - 5 * 30 - 161));
  });
});

describe("calcTDEE", () => {
  it("modelo legacy: aplica el factor de actividad correcto a cada nivel", () => {
    const tmb = 1500;
    const withLevel = (activityLevel: PhysicalProfile["activityLevel"]) =>
      calcTDEE({ ...baseProfile(), activityLevel, activityModelVersion: "legacy_total_pal" }, tmb);
    expect(withLevel("sedentary")).toBe(Math.round(tmb * 1.2));
    expect(withLevel("light")).toBe(Math.round(tmb * 1.375));
    expect(withLevel("moderate")).toBe(Math.round(tmb * 1.45));
    expect(withLevel("active")).toBe(Math.round(tmb * 1.65));
    expect(withLevel("very_active")).toBe(Math.round(tmb * 1.9));
  });

  it("lifestyle_plus_training (nutrition-v3 §2.5/§3): suma lifestyleTdee + replacementIncrementKcal, NO el gasto bruto del entreno", () => {
    const tmb = 1500;
    const weightKg = 80;
    const profile = baseProfile({
      weightKg,
      activityModelVersion: "lifestyle_plus_training",
      trainingActivity: {
        lifestyleActivity: "sedentary",
        strengthDaysPerWeek: 3,
        cardioDaysPerWeek: 2,
        strengthAvgDurationMin: 60,
        cardioAvgDurationMin: 60,
        habitualSteps: null,
        // Sin cardioType/cardioIntensity declarados (nutrition-v3.1): el
        // cálculo usa CARDIO_MET_UNCONFIRMED (4.5), no un 7.0 fijo.
      },
    });

    const lifestyleTdee = tmb * 1.2; // sedentary
    // grossKcal = MET × 3.5 × peso / 200 × minutos
    const strengthGross = ((5.0 * 3.5 * weightKg) / 200) * 60;
    const cardioGross   = ((4.5 * 3.5 * weightKg) / 200) * 60; // MET "sin confirmar"
    // baselineDisplaced = lifestyleTdee / 1440 × minutos (misma duración fuerza/cardio aquí)
    const baselineDisplaced = (lifestyleTdee / 1440) * 60;
    // replacementIncrement = max(0, gross - baselineDisplaced), clampado POR SESIÓN
    const strengthIncrement = Math.max(0, strengthGross - baselineDisplaced);
    const cardioIncrement   = Math.max(0, cardioGross - baselineDisplaced);
    const weeklyIncrement = 3 * strengthIncrement + 2 * cardioIncrement;
    const expectedIncrementPerDay = Math.round(weeklyIncrement / 7);
    const expected = Math.round(lifestyleTdee) + expectedIncrementPerDay;

    expect(calcTDEE(profile, tmb)).toBe(expected);
    // El bruto (lo que daba v2) habría sido mayor — confirma que NO estamos
    // sumando gross, sino el incremento neto tras descontar el baseline.
    const grossOnlyWeekly = 3 * strengthGross + 2 * cardioGross;
    const grossOnlyAllowance = Math.round(grossOnlyWeekly / 7);
    expect(expectedIncrementPerDay).toBeLessThan(grossOnlyAllowance);
  });

  it("lifestyle_plus_training sin trainingActivity relleno cae de vuelta al modelo legacy", () => {
    const tmb = 1500;
    const profile = baseProfile({ activityLevel: "moderate", activityModelVersion: "lifestyle_plus_training" });
    expect(calcTDEE(profile, tmb)).toBe(Math.round(tmb * 1.45));
  });

  it("a más días/duración de entreno, mayor TDEE (monotonía)", () => {
    const tmb = 1500;
    const light = baseProfile({
      activityModelVersion: "lifestyle_plus_training",
      trainingActivity: { lifestyleActivity: "sedentary", strengthDaysPerWeek: 1, cardioDaysPerWeek: 0, strengthAvgDurationMin: 30, cardioAvgDurationMin: 30, habitualSteps: null },
    });
    const heavy = baseProfile({
      activityModelVersion: "lifestyle_plus_training",
      trainingActivity: { lifestyleActivity: "sedentary", strengthDaysPerWeek: 5, cardioDaysPerWeek: 3, strengthAvgDurationMin: 75, cardioAvgDurationMin: 75, habitualSteps: null },
    });
    expect(calcTDEE(heavy, tmb)).toBeGreaterThan(calcTDEE(light, tmb));
  });
});

// ─── nutrition-v3 §2.5/§3.3 — invariantes de grossKcal/netAboveRestKcal/replacementIncrementKcal ──

describe("calcTdeeBreakdown — invariantes PR3", () => {
  const tmb = 1500;
  const training = (overrides: Partial<TrainingActivityProfile> = {}): TrainingActivityProfile => ({
    lifestyleActivity: "sedentary",
    strengthDaysPerWeek: 4,
    cardioDaysPerWeek: 3,
    strengthAvgDurationMin: 60,
    cardioAvgDurationMin: 45,
    habitualSteps: null,
    ...overrides,
  });
  const profileWith = (t: TrainingActivityProfile, overrides: Partial<PhysicalProfile> = {}) =>
    baseProfile({
      weightKg: 80,
      activityModelVersion: "lifestyle_plus_training",
      trainingActivity: t,
      ...overrides,
    });

  it("grossKcal (habitualTrainingGrossKcalPerDay) es independiente del lifestyle — mismo entreno, mismo peso", () => {
    const sedentary = calcTdeeBreakdown(profileWith(training({ lifestyleActivity: "sedentary" })), tmb);
    const veryActive = calcTdeeBreakdown(profileWith(training({ lifestyleActivity: "very_active" })), tmb);
    expect(sedentary.habitualTrainingGrossKcalPerDay).toBe(veryActive.habitualTrainingGrossKcalPerDay);
  });

  it("baselineDisplaced depende del lifestyle — a más lifestyle, más baseline ya 'reservado'", () => {
    const sedentary = calcTdeeBreakdown(profileWith(training({ lifestyleActivity: "sedentary" })), tmb);
    const veryActive = calcTdeeBreakdown(profileWith(training({ lifestyleActivity: "very_active" })), tmb);
    expect(veryActive.baselineDisplacedKcalPerDay).toBeGreaterThan(sedentary.baselineDisplacedKcalPerDay);
  });

  it("replacementIncrement es monótono NO creciente según sube el lifestyle (mismo entreno)", () => {
    const levels: PhysicalProfile["activityLevel"][] = ["sedentary", "light", "moderate", "active", "very_active"];
    const increments = levels.map(
      (lifestyleActivity) => calcTdeeBreakdown(profileWith(training({ lifestyleActivity })), tmb).replacementIncrementKcalPerDay
    );
    for (let i = 1; i < increments.length; i++) {
      expect(increments[i]).toBeLessThanOrEqual(increments[i - 1]);
    }
  });

  it("replacementIncrement siempre >= 0 y <= grossKcal, incluso en lifestyle muy activo con entreno ligero", () => {
    const lightTraining = training({
      lifestyleActivity: "very_active", strengthDaysPerWeek: 1, cardioDaysPerWeek: 0,
      strengthAvgDurationMin: 10, cardioAvgDurationMin: 10,
    });
    const breakdown = calcTdeeBreakdown(profileWith(lightTraining), tmb);
    expect(breakdown.replacementIncrementKcalPerDay).toBeGreaterThanOrEqual(0);
    expect(breakdown.replacementIncrementKcalPerDay).toBeLessThanOrEqual(breakdown.habitualTrainingGrossKcalPerDay);
  });

  it("sin entrenamiento (0 días fuerza y cardio): replacementIncrement = 0, TDEE = lifestyleTdee", () => {
    const noTraining = training({ strengthDaysPerWeek: 0, cardioDaysPerWeek: 0 });
    const breakdown = calcTdeeBreakdown(profileWith(noTraining), tmb);
    expect(breakdown.replacementIncrementKcalPerDay).toBe(0);
    expect(breakdown.totalTdeeKcal).toBe(breakdown.lifestyleTdeeKcal);
  });

  it("añadir entrenamiento con incremento > 0 nunca hace bajar el TDEE respecto a no entrenar", () => {
    const noTraining = calcTdeeBreakdown(profileWith(training({ strengthDaysPerWeek: 0, cardioDaysPerWeek: 0 })), tmb);
    const withTraining = calcTdeeBreakdown(profileWith(training()), tmb);
    expect(withTraining.totalTdeeKcal).toBeGreaterThanOrEqual(noTraining.totalTdeeKcal);
  });

  it("cambiar solo la duración de cardio no cambia el componente de fuerza (cardioDays=0 → cardioAvgDuration es irrelevante)", () => {
    const onlyStrength = (cardioAvgDurationMin: number) =>
      calcTdeeBreakdown(profileWith(training({ cardioDaysPerWeek: 0, cardioAvgDurationMin })), tmb);
    const a = onlyStrength(20);
    const b = onlyStrength(120);
    expect(a).toEqual(b); // con 0 días de cardio, la duración de cardio no puede afectar a nada del desglose
  });

  it("weeklyTrainingIncrement/7 == replacementIncrementKcalPerDay (no se mezclan ventanas semanal/diaria)", () => {
    const t = training();
    const profile = profileWith(t);
    const breakdown = calcTdeeBreakdown(profile, tmb);
    // Reconstruye el incremento semanal a partir de calcHabitualTrainingAllowanceKcal
    // (misma fuente que calcTdeeBreakdown, ver calcHabitualTrainingBreakdown interno)
    // multiplicando de vuelta por 7 con margen de redondeo de ±1.
    const impliedWeekly = breakdown.replacementIncrementKcalPerDay * 7;
    const allowance = calcHabitualTrainingAllowanceKcal(profile.weightKg, t, breakdown.lifestyleTdeeKcal);
    expect(allowance).toBe(breakdown.replacementIncrementKcalPerDay);
    expect(Math.abs(impliedWeekly - allowance * 7)).toBeLessThanOrEqual(1);
  });

  it("calcTDEE() coincide exactamente con calcTdeeBreakdown().totalTdeeKcal (wrapper delgado)", () => {
    const profile = profileWith(training());
    expect(calcTDEE(profile, tmb)).toBe(calcTdeeBreakdown(profile, tmb).totalTdeeKcal);
  });

  it("modelo legacy_total_pal: sin desglose — lifestyleTdeeKcal === totalTdeeKcal y los campos de entreno quedan a 0", () => {
    const profile = baseProfile({ activityLevel: "moderate", activityModelVersion: "legacy_total_pal" });
    const breakdown = calcTdeeBreakdown(profile, tmb);
    expect(breakdown.lifestyleTdeeKcal).toBe(breakdown.totalTdeeKcal);
    expect(breakdown.habitualTrainingGrossKcalPerDay).toBe(0);
    expect(breakdown.baselineDisplacedKcalPerDay).toBe(0);
    expect(breakdown.replacementIncrementKcalPerDay).toBe(0);
  });
});

describe("estimateWorkoutKcal / netAboveRestKcal — independiente del lifestyle (pipeline B, Ejercicios)", () => {
  it("cambiar lifestyleActivity no puede alterar retroactivamente las kcal de una sesión ya registrada — garantizado por la firma, no solo por comportamiento", () => {
    // No existe forma de escribir "misma sesión con lifestyle A" vs "con
    // lifestyle B" porque estimateWorkoutKcal(peso, min, met) no acepta
    // perfil/lifestyle como parámetro — es estructuralmente imposible que
    // ese dato se cuele (ver docs/NUTRITION_V3_DECISIONES.md §3.3). Esta
    // prueba documenta esa garantía y protege que nadie añada un
    // parámetro de lifestyle a esta función en el futuro sin darse cuenta
    // de que rompería la separación de responsabilidades entre pipelines.
    const sessionKcal = estimateWorkoutKcal(80, 45, 5.0);
    expect(estimateWorkoutKcal(80, 45, 5.0)).toBe(sessionKcal);
    expect(estimateWorkoutKcal.length).toBe(2); // (weightKg, durationMin) — met tiene default, no cuenta
  });
});

describe("calcIMC", () => {
  it("peso / altura^2 (altura en metros)", () => {
    expect(calcIMC(70, 175)).toBeCloseTo(22.9, 1);
  });
});

function baseProfile(overrides: Partial<PhysicalProfile> = {}): PhysicalProfile {
  return {
    age: 30,
    sex: "male",
    heightCm: 175,
    weightKg: 75,
    bodyFatPct: null,
    activityLevel: "moderate",
    goal: "maintain",
    gymDays: [1, 3, 5],
    allergies: [],
    excludedFoods: [],
    ...overrides,
  };
}

describe("calcProteinBase / usesEspenAdjustedWeight", () => {
  it("usa masa magra cuando se conoce el % graso", () => {
    const profile = baseProfile({ weightKg: 90, bodyFatPct: 20 });
    expect(calcProteinBase(profile)).toBeCloseTo(90 * 0.8, 5);
    expect(usesEspenAdjustedWeight(profile)).toBe(false);
  });

  it("usa el peso real si no hay obesidad (peso <= ideal_IMC25 * 1.25)", () => {
    const profile = baseProfile({ heightCm: 175, weightKg: 75 });
    expect(usesEspenAdjustedWeight(profile)).toBe(false);
    expect(calcProteinBase(profile)).toBe(75);
  });

  it("usa peso ajustado ESPEN en obesidad (120kg/177cm — caso documentado)", () => {
    const profile = baseProfile({ heightCm: 177, weightKg: 120 });
    const idealWeight = 25 * 1.77 * 1.77;
    const expectedAdjusted = idealWeight + (120 - idealWeight) * 0.33;
    expect(usesEspenAdjustedWeight(profile)).toBe(true);
    expect(calcProteinBase(profile)).toBeCloseTo(expectedAdjusted, 5);
    expect(calcProteinBase(profile)).toBeCloseTo(92.1, 0);
  });
});

// ─── nutrition-v3 §2.4/§4: proteína por base + tipo, tabla FFM propia ──────

describe("resolveProteinBase (nunca pierde el tipo de base antes del multiplicador)", () => {
  it("con % graso conocido, kind es fat_free_mass", () => {
    const profile = baseProfile({ weightKg: 90, bodyFatPct: 20 });
    const base = resolveProteinBase(profile);
    expect(base.kind).toBe("fat_free_mass");
    expect(base.kg).toBeCloseTo(72, 5);
  });

  it("sin % graso y sin obesidad, kind es actual_weight", () => {
    const profile = baseProfile({ heightCm: 175, weightKg: 75 });
    const base = resolveProteinBase(profile);
    expect(base.kind).toBe("actual_weight");
    expect(base.kg).toBe(75);
  });

  it("sin % graso y con obesidad, kind es adjusted_weight", () => {
    const profile = baseProfile({ heightCm: 177, weightKg: 120 });
    const base = resolveProteinBase(profile);
    expect(base.kind).toBe("adjusted_weight");
    expect(base.kg).toBeCloseTo(92.1, 0);
  });
});

describe("PROTEIN_PER_KG_BY_BASE_AND_GOAL — caso motivador del bug (90kg, 20% grasa, recomp)", () => {
  it("declarar % de grasa reduce muchísimo la magnitud de la caída del bug original, sin eliminarla del todo en recomp", () => {
    // Bug original (v2): la misma fila (2.0 g/kg) se aplicaba a
    // actual_weight Y fat_free_mass → 90×2.0=180g sin %graso, pero
    // 72×2.0=144g con %graso (−36g, −20%). Con la tabla v3, fat_free_mass
    // tiene su propia fila (2.4 en recomp, no 2.0) → 72×2.4=173g: la caída
    // baja a −7g (−3.9%), muy por debajo del −20% original. No llega a
    // igualar del todo (a diferencia de fat_loss, ver siguiente test) — es
    // la heurística deliberada documentada en PROTEIN_PER_KG_BY_BASE_AND_GOAL,
    // no un objetivo de igualdad exacta para todos los goals.
    const withoutBodyFat = baseProfile({ weightKg: 90, heightCm: 175, goal: "recomp", bodyFatPct: null });
    const withBodyFat = baseProfile({ weightKg: 90, heightCm: 175, goal: "recomp", bodyFatPct: 20 });
    const targetsWithout = calcDailyTargets(withoutBodyFat, false);
    const targetsWith = calcDailyTargets(withBodyFat, false);
    expect(targetsWithout.protein).toBe(180); // 90 × 2.0 (actual_weight, recomp)
    expect(targetsWith.protein).toBe(173);    // 72 × 2.4 (fat_free_mass, recomp)
    const dropFraction = (targetsWithout.protein - targetsWith.protein) / targetsWithout.protein;
    expect(dropFraction).toBeLessThan(0.05); // bug original era ~0.20 (20%)
  });

  it("en fat_loss, declarar % de grasa NO baja la proteína (la fila fat_free_mass ya supera a actual_weight en este caso)", () => {
    const withoutBodyFat = baseProfile({ weightKg: 90, heightCm: 175, goal: "fat_loss", bodyFatPct: null });
    const withBodyFat = baseProfile({ weightKg: 90, heightCm: 175, goal: "fat_loss", bodyFatPct: 20 });
    const targetsWithout = calcDailyTargets(withoutBodyFat, false);
    const targetsWith = calcDailyTargets(withBodyFat, false);
    expect(targetsWithout.protein).toBe(180); // 90 × 2.0 (actual_weight, fat_loss)
    expect(targetsWith.protein).toBe(187);    // 72 × 2.6 (fat_free_mass, fat_loss)
    expect(targetsWith.protein).toBeGreaterThanOrEqual(targetsWithout.protein);
  });

  // No se exige como invariante que fat_free_mass sea siempre >= la fila
  // actual/adjusted (no es fisiológicamente obligatorio, se comprobó que no
  // se sostiene en extremos >45% de grasa corporal). Lo que sí debe
  // cumplirse: introducir un % de grasa PLAUSIBLE (rango típico de adulto
  // no obeso, 10-30%) no debe producir un salto extremo/inexplicable del
  // target de proteína en ningún objetivo — ni un colapso como el del bug
  // original (que llegaba a −20% o más para pesos/objetivos concretos) ni
  // una subida desproporcionada por error de la tabla.
  it("introducir un % de grasa plausible (10-30%) no produce un salto extremo de proteína en ningún objetivo", () => {
    const goals = ["fat_loss", "recomp", "muscle_gain", "maintain"] as const;
    const plausibleBodyFatPct = [10, 15, 20, 25, 30];
    for (const goal of goals) {
      const withoutBodyFat = baseProfile({ weightKg: 85, heightCm: 175, goal, bodyFatPct: null });
      const baseline = calcDailyTargets(withoutBodyFat, false).protein;
      for (const bf of plausibleBodyFatPct) {
        const withBodyFat = baseProfile({ weightKg: 85, heightCm: 175, goal, bodyFatPct: bf });
        const withProtein = calcDailyTargets(withBodyFat, false).protein;
        const relativeChange = (withProtein - baseline) / baseline;
        // Ningún objetivo debería moverse más de un 35% en ninguna
        // dirección solo por declarar un % de grasa típico — el bug
        // original no tenía ningún límite (podía superar el −20% con
        // facilidad, más aún a pesos altos).
        expect(Math.abs(relativeChange)).toBeLessThan(0.35);
      }
    }
  });

  it("actual_weight y adjusted_weight comparten fila (sin cambios respecto a v2)", () => {
    expect(PROTEIN_PER_KG_BY_BASE_AND_GOAL.actual_weight).toEqual(PROTEIN_PER_KG_BY_BASE_AND_GOAL.adjusted_weight);
  });

  it("fat_free_mass es siempre >= a la fila actual/adjusted para el mismo objetivo (la base es más exigente, no más laxa)", () => {
    for (const goal of ["fat_loss", "recomp", "muscle_gain", "maintain"] as const) {
      expect(PROTEIN_PER_KG_BY_BASE_AND_GOAL.fat_free_mass[goal]).toBeGreaterThanOrEqual(
        PROTEIN_PER_KG_BY_BASE_AND_GOAL.actual_weight[goal]
      );
    }
  });
});

describe("calcProteinRange — centrado en el target real (nunca deja el target fuera del rango)", () => {
  it("fat_free_mass + fat_loss: target dentro de [broadMin, broadMax], y el broad queda contenido en el 2.2-3.0 g/kg FFM (dentro del contexto 2.3-3.1 de Helms, sin vender 3.1 como rutinario)", () => {
    const profile = baseProfile({ weightKg: 90, heightCm: 175, goal: "fat_loss", bodyFatPct: 20 });
    const range = calcProteinRange(profile);
    // base = 72kg, perKg = 2.6 (fat_loss, fat_free_mass) → target=72×2.6=187.2→187
    expect(range.target).toBe(187);
    expect(range.broadMin).toBe(158);       // 72 × (2.6-0.4) = 72×2.2 = 158.4 → 158
    expect(range.recommendedMin).toBe(173); // 72 × (2.6-0.2) = 72×2.4 = 172.8 → 173
    expect(range.recommendedMax).toBe(202); // 72 × (2.6+0.2) = 72×2.8 = 201.6 → 202
    expect(range.broadMax).toBe(216);       // 72 × (2.6+0.4) = 72×3.0 = 216
    expect(range.broadMin).toBeLessThanOrEqual(range.recommendedMin);
    expect(range.recommendedMin).toBeLessThanOrEqual(range.target);
    expect(range.target).toBeLessThanOrEqual(range.recommendedMax);
    expect(range.recommendedMax).toBeLessThanOrEqual(range.broadMax);
  });

  it("para cualquier base/objetivo, el target siempre cae dentro de [broadMin, broadMax]", () => {
    const profiles = [
      baseProfile({ weightKg: 75, heightCm: 175, goal: "maintain" }), // actual_weight
      baseProfile({ weightKg: 120, heightCm: 177, goal: "fat_loss" }), // adjusted_weight
      baseProfile({ weightKg: 90, heightCm: 175, goal: "muscle_gain", bodyFatPct: 15 }), // fat_free_mass
    ];
    for (const profile of profiles) {
      const range = calcProteinRange(profile);
      expect(range.target).toBeGreaterThanOrEqual(range.broadMin);
      expect(range.target).toBeLessThanOrEqual(range.broadMax);
    }
  });
});

describe("calcDailyTargets — caso real verificado en la app (120kg/177cm/24años, recomp)", () => {
  const profile = baseProfile({ age: 24, heightCm: 177, weightKg: 120, goal: "recomp" });

  it("día de gym: 2637 kcal, 184g proteína", () => {
    const targets = calcDailyTargets(profile, true);
    expect(targets.kcal).toBe(2637);
    expect(targets.protein).toBe(184);
    expect(targets.dayType).toBe("gym");
  });

  it("día de descanso: 2542 kcal", () => {
    const targets = calcDailyTargets(profile, false);
    expect(targets.kcal).toBe(2542);
    expect(targets.dayType).toBe("rest");
  });

  it("macros cuadran con las kcal totales (Atwater 4/4/9, margen de redondeo)", () => {
    const targets = calcDailyTargets(profile, true);
    const kcalFromMacros = targets.protein * 4 + targets.carbs * 4 + targets.fat * 9;
    expect(Math.abs(kcalFromMacros - targets.kcal)).toBeLessThanOrEqual(8);
  });

  it("nunca baja del suelo de seguridad de 1200 kcal", () => {
    const tinyProfile = baseProfile({ age: 60, heightCm: 150, weightKg: 40, goal: "fat_loss", activityLevel: "sedentary" });
    expect(calcDailyTargets(tinyProfile, false).kcal).toBeGreaterThanOrEqual(1200);
  });

  it("macroPreference por defecto ('balanced') no cambia las kcal ni la proteína respecto a no pasar el parámetro", () => {
    const withDefault = calcDailyTargets(profile, true);
    const withBalanced = calcDailyTargets(profile, true, "balanced");
    expect(withBalanced).toEqual(withDefault);
  });

  it("'higher_fat' sube grasa y baja carbos sin tocar kcal totales ni proteína", () => {
    const balanced = calcDailyTargets(profile, true, "balanced");
    const higherFat = calcDailyTargets(profile, true, "higher_fat");
    expect(higherFat.kcal).toBe(balanced.kcal);
    expect(higherFat.protein).toBe(balanced.protein);
    expect(higherFat.fat).toBeGreaterThan(balanced.fat);
    expect(higherFat.carbs).toBeLessThan(balanced.carbs);
  });

  it("'higher_carbohydrate' baja grasa y sube carbos sin tocar kcal totales ni proteína", () => {
    const balanced = calcDailyTargets(profile, true, "balanced");
    const higherCarb = calcDailyTargets(profile, true, "higher_carbohydrate");
    expect(higherCarb.kcal).toBe(balanced.kcal);
    expect(higherCarb.protein).toBe(balanced.protein);
    expect(higherCarb.fat).toBeLessThan(balanced.fat);
    expect(higherCarb.carbs).toBeGreaterThan(balanced.carbs);
  });

  it("adaptiveKcalOffsetKcal (PR6) desplaza el kcal final en esa cantidad exacta", () => {
    const withoutOffset = calcDailyTargets(profile, true);
    const withOffset = calcDailyTargets(baseProfile({ ...profile, adaptiveKcalOffsetKcal: -100 }), true);
    expect(withOffset.kcal).toBe(withoutOffset.kcal - 100);
  });

  it("undefined/0 en adaptiveKcalOffsetKcal no cambia nada respecto a no tener el campo", () => {
    const withUndefined = calcDailyTargets(profile, true);
    const withZero = calcDailyTargets(baseProfile({ ...profile, adaptiveKcalOffsetKcal: 0 }), true);
    expect(withZero).toEqual(withUndefined);
  });

  it("el offset nunca hace bajar del suelo de seguridad de 1200 kcal", () => {
    const tinyProfile = baseProfile({
      age: 60, heightCm: 150, weightKg: 40, goal: "fat_loss", activityLevel: "sedentary",
      adaptiveKcalOffsetKcal: -300,
    });
    expect(calcDailyTargets(tinyProfile, false).kcal).toBeGreaterThanOrEqual(1200);
  });
});

// ─── PR4 — nutrition-v3 §2.6: muscle_gain nunca es un déficit encubierto ──
// Decisión documentada como cerrada desde la primera sesión de diseño de
// v3 (0c9b4b2), pero nunca implementada hasta la auditoría final de PR4:
// kcalFactor("muscle_gain") devolvía 0.90 (déficit real ~10%) con
// IMC>=27, con el objetivo etiquetado "ganancia muscular".

// ALCANCE (corregido tras auditoría externa de fdf0f4d): el invariante
// "muscle_gain nunca déficit" es sobre el FACTOR BASE (kcalFactor), antes
// de sumar adaptiveKcalOffsetKcal — NO una promesa sobre
// calcDailyTargets().kcal final para cualquier entrada. Un offset
// adaptativo negativo ACEPTADO explícitamente por el usuario sí puede
// bajar el target final por debajo del TDEE de la fórmula, y eso es
// intencional (ver comentario junto a kcalFactor en nutrition.ts) — el
// primer test de este describe llegó a prometer lo contrario, corregido
// aquí junto con un test que documenta el comportamiento real.
describe("calcDailyTargets — muscle_gain: el FACTOR BASE nunca es un déficit, cualquiera que sea el IMC", () => {
  it("goal=muscle_gain SIN offset adaptativo → targetKcal siempre >= TDEE estimado, incluso con IMC alto", () => {
    const imcCases = [
      { weightKg: 70, heightCm: 178 },  // IMC ~22, normopeso
      { weightKg: 85, heightCm: 178 },  // IMC ~26.8, justo debajo del umbral
      { weightKg: 90, heightCm: 178 },  // IMC ~28.4, por encima del umbral
      { weightKg: 110, heightCm: 175 }, // IMC ~35.9, obesidad — el caso que falló en la auditoría manual original
    ];
    for (const { weightKg, heightCm } of imcCases) {
      const profile = baseProfile({ weightKg, heightCm, goal: "muscle_gain", activityLevel: "moderate" });
      const { tdee } = calcSummary(profile);
      const targets = calcDailyTargets(profile, false);
      expect(targets.kcal, `weightKg=${weightKg} heightCm=${heightCm}`).toBeGreaterThanOrEqual(tdee);
    }
  });

  it("con IMC>=27 el factor base es exactamente mantenimiento (1.0), no superávit ni déficit", () => {
    const profile = baseProfile({ weightKg: 110, heightCm: 175, goal: "muscle_gain", activityLevel: "moderate" });
    const { tdee } = calcSummary(profile);
    const targets = calcDailyTargets(profile, false);
    expect(targets.kcal).toBe(tdee);
  });

  it("con IMC<27 se mantiene el pequeño superávit base del 5%", () => {
    const profile = baseProfile({ weightKg: 70, heightCm: 178, goal: "muscle_gain", activityLevel: "moderate" });
    const { tdee } = calcSummary(profile);
    const targets = calcDailyTargets(profile, false);
    expect(targets.kcal).toBe(Math.round(tdee * 1.05));
  });

  it("un offset adaptativo negativo ACEPTADO por el usuario SÍ puede bajar el target final por debajo del TDEE — comportamiento intencional, no el bug de §2.6 reaparecido", () => {
    // Hallazgo de la auditoría externa de fdf0f4d: evaluateAdaptiveState()
    // puede proponer -100 kcal para muscle_gain si la trayectoria observada
    // está por encima de la banda (gana más rápido de lo esperado). Una vez
    // ACEPTADO explícitamente ese offset, el target final puede caer por
    // debajo del TDEE de la fórmula — el controlador está corrigiendo la
    // ESTIMACIÓN de TDEE con datos reales, con aceptación explícita, no
    // reintroduciendo un déficit oculto por debajo del usuario.
    const profile = baseProfile({
      weightKg: 110, heightCm: 175, goal: "muscle_gain", activityLevel: "moderate",
      adaptiveKcalOffsetKcal: -100,
    });
    const { tdee } = calcSummary(profile);
    const targets = calcDailyTargets(profile, false);
    expect(targets.kcal).toBe(tdee - 100);
    expect(targets.kcal).toBeLessThan(tdee); // intencional, ver comentario arriba
  });
});

describe("calculateFiberTarget", () => {
  it("nunca baja de 25g (suelo EFSA)", () => {
    expect(calculateFiberTarget(1200)).toBe(25);
  });

  it("escala ~14g/1000kcal por encima del suelo", () => {
    expect(calculateFiberTarget(2500)).toBe(35);
  });

  it("nunca supera el tope de 45g", () => {
    expect(calculateFiberTarget(4000)).toBe(45);
  });
});

describe("distributeWeeklyCalories (ciclado que conserva el presupuesto semanal)", () => {
  it("el total semanal generado es idéntico al de un objetivo medio constante", () => {
    const result = distributeWeeklyCalories({
      averageDailyKcal: 2200,
      trainingDays: 4,
      trainingDayDeltaKcal: 150,
    });
    const generatedWeeklyTotal = result.trainingDayKcal * 4 + result.restDayKcal * 3;
    expect(Math.abs(generatedWeeklyTotal - 2200 * 7)).toBeLessThanOrEqual(1); // margen de redondeo
  });

  it("con 0 o 7 días de entrenamiento no distingue tipos de día", () => {
    const noneTraining = distributeWeeklyCalories({ averageDailyKcal: 2000, trainingDays: 0, trainingDayDeltaKcal: 150 });
    expect(noneTraining.trainingDayKcal).toBe(2000);
    expect(noneTraining.restDayKcal).toBe(2000);

    const allTraining = distributeWeeklyCalories({ averageDailyKcal: 2000, trainingDays: 7, trainingDayDeltaKcal: 150 });
    expect(allTraining.trainingDayKcal).toBe(2000);
    expect(allTraining.restDayKcal).toBe(2000);
  });

  it("el día de entrenamiento siempre tiene más kcal que el de descanso cuando el delta es positivo", () => {
    const result = distributeWeeklyCalories({ averageDailyKcal: 2200, trainingDays: 3, trainingDayDeltaKcal: 200 });
    expect(result.trainingDayKcal).toBeGreaterThan(result.restDayKcal);
  });
});

describe("estimateWorkoutKcal", () => {
  it("resta 1 MET para excluir el gasto basal (neto, no bruto)", () => {
    // (5 - 1) * 3.5 * 80 / 200 * 45 = 252
    expect(estimateWorkoutKcal(80, 45, 5.0)).toBe(252);
  });
});

describe("metForMuscleGroups", () => {
  it("sin grupos musculares (rutina manual sin split), cae al MET moderado de siempre", () => {
    expect(metForMuscleGroups(undefined)).toBe(5.0);
    expect(metForMuscleGroups([])).toBe(5.0);
  });

  it("día de pierna/glúteo/espalda → MET vigoroso (6.0), compuesto multiarticular", () => {
    expect(metForMuscleGroups(["piernas"])).toBe(6.0);
    expect(metForMuscleGroups(["glúteos", "cuádriceps"])).toBe(6.0);
    expect(metForMuscleGroups(["espalda"])).toBe(6.0);
  });

  it("día de brazo/abdomen → MET ligero (3.5), aislamiento", () => {
    expect(metForMuscleGroups(["bíceps", "tríceps"])).toBe(3.5);
    expect(metForMuscleGroups(["abdomen"])).toBe(3.5);
  });

  it("día de pecho/hombro (no vigoroso ni ligero) → MET moderado de siempre", () => {
    expect(metForMuscleGroups(["pecho", "hombros"])).toBe(5.0);
  });

  it("mezcla de grupos vigorosos y ligeros en el mismo día → MET moderado (sin sesgo hacia ninguno)", () => {
    expect(metForMuscleGroups(["piernas", "bíceps"])).toBe(5.0);
  });

  it("no distingue mayúsculas/tildes al comparar", () => {
    expect(metForMuscleGroups(["PIERNAS"])).toBe(6.0);
    expect(metForMuscleGroups(["Gluteo"])).toBe(6.0);
  });
});

describe("scaleByRatio / scaleByCalories", () => {
  const recipe: Recipe = {
    id: "r1",
    title: "Test",
    servings: 1,
    kcal: 400,
    protein: 30,
    carbs: 40,
    fat: 10,
    cost: 2,
    image: "",
    time: 20,
    difficulty: "easy",
    tags: [],
    steps: [],
    ingredients: [{ name: "Pollo", quantity: 100, unit: "g" }],
  };

  it("escala macros e ingredientes proporcionalmente", () => {
    const scaled = scaleByRatio(recipe, 2);
    expect(scaled.macros.kcal).toBe(800);
    expect(scaled.macros.protein).toBe(60);
    expect(scaled.ingredients[0].quantity).toBe(200);
  });

  it("clampa el ratio entre 0.1 y 6 para evitar escalados absurdos", () => {
    expect(scaleByRatio(recipe, 100).ratio).toBe(6);
    expect(scaleByRatio(recipe, 0).ratio).toBe(0.1);
  });

  it("escala por kcal objetivo (ratio = targetKcal / kcalReceta)", () => {
    const scaled = scaleByCalories(recipe, 600);
    expect(scaled.macros.kcal).toBe(600);
  });
});

describe("projectSavings (interés compuesto)", () => {
  it("con interés 0%, el valor futuro es la suma simple", () => {
    const projection = projectSavings(100, 500, 0);
    expect(projection.months6).toBe(600);
    expect(projection.year1).toBe(1200);
  });

  it("con interés > 0%, el fondo indexado supera a la simple suma bancaria a 5 años", () => {
    const projection = projectSavings(100, 500, 0.07);
    expect(projection.years5Fund).toBeGreaterThan(projection.years5Bank);
  });

  it("fondo de emergencia: meses hasta cubrir 3x el gasto mensual", () => {
    const projection = projectSavings(200, 1000, 0);
    expect(projection.emergencyFundMonths).toBe(Math.ceil((1000 * 3) / 200));
  });
});

describe("monthlyAmountOf", () => {
  it("convierte cada frecuencia a un equivalente mensual", () => {
    expect(monthlyAmountOf("monthly", 1000)).toBe(1000);
    expect(monthlyAmountOf("weekly", 100)).toBeCloseTo((100 * 52) / 12, 5);
    expect(monthlyAmountOf("biweekly", 100)).toBeCloseTo((100 * 26) / 12, 5);
    expect(monthlyAmountOf("yearly", 1200)).toBe(100);
  });
});

describe("evaluateNutritionSafety", () => {
  it("bloquea el plan automático por debajo de 800 kcal (NICE NG246)", () => {
    const result = evaluateNutritionSafety({ targetKcal: 750, estimatedTdeeKcal: 2000, restingEnergyKcal: 1500 });
    expect(result.automaticPlanAllowed).toBe(false);
    expect(result.warnings).toEqual(["very_low_energy_diet"]);
  });

  it("exige confirmación cuando el objetivo baja del 70% del TDEE", () => {
    const result = evaluateNutritionSafety({ targetKcal: 1300, estimatedTdeeKcal: 2000, restingEnergyKcal: 1200 });
    expect(result.automaticPlanAllowed).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
    expect(result.warnings).toContain("aggressive_energy_deficit");
  });

  it("avisa (sin bloquear) cuando el objetivo baja de la TMB estimada", () => {
    const result = evaluateNutritionSafety({ targetKcal: 1400, estimatedTdeeKcal: 2000, restingEnergyKcal: 1500 });
    expect(result.automaticPlanAllowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.warnings).toEqual(["below_resting_energy"]);
  });

  it("sin avisos cuando el objetivo es razonable", () => {
    const result = evaluateNutritionSafety({ targetKcal: 1900, estimatedTdeeKcal: 2000, restingEnergyKcal: 1500 });
    expect(result.automaticPlanAllowed).toBe(true);
    expect(result.requiresConfirmation).toBe(false);
    expect(result.warnings).toEqual([]);
  });
});

describe("calcWeightTrend", () => {
  const REF = "2026-02-14";

  function addDays(dateKey: string, days: number): string {
    const d = new Date(`${dateKey}T12:00:00`);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  /** Serie diaria de `count` entradas terminando en `endDate`, con pendiente
      lineal `dailyDeltaKg` (positiva = ganando peso, negativa = perdiendo). */
  function linearSeries(startKg: number, count: number, dailyDeltaKg: number, endDate: string): WeightEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      date: addDays(endDate, -(count - 1 - i)),
      kg: Math.round((startKg + dailyDeltaKg * i) * 100) / 100,
    }));
  }

  it("devuelve null con menos de 3 mediciones en la ventana", () => {
    const entries = linearSeries(80, 2, -0.1, REF);
    expect(calcWeightTrend(entries, REF)).toBeNull();
  });

  it("detecta una tendencia de pérdida de peso clara (14 días, alta confianza)", () => {
    const entries = linearSeries(80, 14, -0.1, REF); // 80.0 -> 78.7 kg
    const result = calcWeightTrend(entries, REF)!;
    expect(result).not.toBeNull();
    expect(result.validMeasurements).toBe(14);
    expect(result.confidence).toBe("high");
    expect(result.latestWeightKg).toBe(78.7);
    expect(result.slopeKgPerDay).toBeLessThan(0);
    expect(result.weeklyChangeKg).toBeLessThan(0);
    expect(Math.abs(result.weeklyChangeKg)).toBeGreaterThan(0.3);
    expect(Math.abs(result.weeklyChangeKg)).toBeLessThan(1.0);
  });

  it("detecta una tendencia de ganancia de peso (pendiente positiva)", () => {
    const entries = linearSeries(70, 14, 0.08, REF);
    const result = calcWeightTrend(entries, REF)!;
    expect(result.slopeKgPerDay).toBeGreaterThan(0);
    expect(result.weeklyChangeKg).toBeGreaterThan(0);
  });

  it("peso plano (sin cambio) da pendiente ~0", () => {
    const entries = linearSeries(75, 10, 0, REF);
    const result = calcWeightTrend(entries, REF)!;
    expect(result.slopeKgPerDay).toBeCloseTo(0, 2);
    expect(result.trendWeightKg).toBeCloseTo(75, 1);
  });

  it("niveles de confianza según mediciones válidas: 3-6 baja, 7-13 moderada, 14+ alta", () => {
    expect(calcWeightTrend(linearSeries(80, 5, -0.1, REF), REF)!.confidence).toBe("low");
    expect(calcWeightTrend(linearSeries(80, 10, -0.1, REF), REF)!.confidence).toBe("moderate");
    expect(calcWeightTrend(linearSeries(80, 20, -0.1, REF), REF)!.confidence).toBe("high");
  });

  it("ignora mediciones fuera de la ventana de 28 días", () => {
    const recent = linearSeries(80, 5, -0.1, REF);
    const stale: WeightEntry = { date: addDays(REF, -40), kg: 95 };
    const result = calcWeightTrend([stale, ...recent], REF)!;
    expect(result.validMeasurements).toBe(5);
  });

  // ── PR10b (N7): qualityScore combina más que el conteo ───────────────────

  it("qualityScore está siempre entre 0 y 1", () => {
    for (const count of [3, 5, 8, 14, 25]) {
      const result = calcWeightTrend(linearSeries(80, count, -0.05, REF), REF)!;
      expect(result.qualityScore).toBeGreaterThanOrEqual(0);
      expect(result.qualityScore).toBeLessThanOrEqual(1);
    }
  });

  it("14 mediciones agrupadas en pocos días puntúan peor que 14 bien repartidas en 4 semanas (mismo count)", () => {
    // Igual número de mediciones, pero las "agrupadas" están todas en una
    // ventana de 4 días (p.ej. alguien pesándose varias veces al día durante
    // un viaje corto) — antes de PR10b, ambas contaban como "alta confianza"
    // solo por tener >=14 mediciones (ver N7/E11-23).
    const spread = linearSeries(80, 14, -0.05, REF); // una medición diaria, 14 días
    const clusteredDates = Array.from({ length: 14 }, (_, i) => addDays(REF, -Math.floor(i / 4)));
    const clustered: WeightEntry[] = clusteredDates.map((date, i) => ({
      date,
      kg: Math.round((80 - 0.05 * i) * 100) / 100,
    }));

    const spreadResult = calcWeightTrend(spread, REF)!;
    const clusteredResult = calcWeightTrend(clustered, REF)!;

    expect(clusteredResult.validMeasurements).toBeLessThanOrEqual(spreadResult.validMeasurements);
    expect(clusteredResult.qualityScore).toBeLessThan(spreadResult.qualityScore);
  });

  it("una tendencia limpia (buen ajuste lineal) puntúa mejor que una muy ruidosa con el mismo count y periodo", () => {
    const clean = linearSeries(80, 14, -0.05, REF);
    // Misma cantidad de días, mismo rango, pero con ruido grande en zigzag en
    // vez de una tendencia limpia — el R² de la regresión debería ser mucho peor.
    const noisy: WeightEntry[] = Array.from({ length: 14 }, (_, i) => ({
      date: addDays(REF, -(13 - i)),
      kg: 80 + (i % 2 === 0 ? 2.5 : -2.5),
    }));

    const cleanResult = calcWeightTrend(clean, REF)!;
    const noisyResult = calcWeightTrend(noisy, REF)!;

    expect(noisyResult.qualityScore).toBeLessThan(cleanResult.qualityScore);
  });

  it("un registro muy irregular (huecos dispares) puntúa peor que uno con la misma cadencia (regularidad)", () => {
    const regular = linearSeries(80, 8, -0.05, REF); // cada 1 día
    // Mismo nº de mediciones y mismo rango total, pero agrupadas en dos
    // ráfagas separadas por un hueco grande, en vez de espaciado uniforme.
    const irregularDates = [
      addDays(REF, -20), addDays(REF, -19), addDays(REF, -18), addDays(REF, -17),
      addDays(REF, -3), addDays(REF, -2), addDays(REF, -1), REF,
    ];
    const irregular: WeightEntry[] = irregularDates.map((date, i) => ({
      date, kg: Math.round((80 - 0.05 * i) * 100) / 100,
    }));

    const regularResult = calcWeightTrend(regular, REF)!;
    const irregularResult = calcWeightTrend(irregular, REF)!;

    expect(irregularResult.qualityScore).toBeLessThan(regularResult.qualityScore);
  });

  it("peso perfectamente plano no se penaliza por 'mal ajuste' (SS_tot≈0 se trata como ajuste perfecto)", () => {
    const flat = linearSeries(75, 14, 0, REF);
    const result = calcWeightTrend(flat, REF)!;
    expect(result.confidence).toBe("high");
    expect(result.qualityScore).toBeGreaterThan(0.85);
  });
});

describe("calcIntakeCoverage", () => {
  const REF = "2026-02-14";

  it("devuelve null si ningún día llega al umbral de cobertura", () => {
    const daily = [
      { date: "2026-02-13", kcal: 300 },
      { date: "2026-02-12", kcal: 200 },
    ];
    expect(calcIntakeCoverage(daily, REF, 7)).toBeNull();
  });

  it("promedia solo los días con cobertura suficiente e ignora los demás", () => {
    const daily = [
      { date: "2026-02-14", kcal: 2000 },
      { date: "2026-02-13", kcal: 1800 },
      { date: "2026-02-12", kcal: 300 }, // por debajo del umbral, se descarta
    ];
    const result = calcIntakeCoverage(daily, REF, 7)!;
    expect(result.daysWithData).toBe(2);
    expect(result.avgKcal).toBe(1900);
    expect(result.coverageFraction).toBeCloseTo(2 / 7, 2);
  });

  it("ignora datos fuera de la ventana", () => {
    const daily = [
      { date: "2026-02-14", kcal: 2000 },
      { date: "2026-01-01", kcal: 2500 }, // muy anterior a la ventana
    ];
    const result = calcIntakeCoverage(daily, REF, 7)!;
    expect(result.daysWithData).toBe(1);
  });

  // ── PR10 (N6): suelo relativo al objetivo, no solo absoluto ──────────────

  it("sin targetKcal, el comportamiento es idéntico al de antes de PR10 (solo suelo absoluto)", () => {
    const daily = [{ date: "2026-02-14", kcal: 600 }]; // por encima de 500, sin target
    const result = calcIntakeCoverage(daily, REF, 7)!;
    expect(result.daysWithData).toBe(1);
  });

  it("caso documentado en N6: objetivo 2600, solo 1200 registrados (46%) — ya no cuenta como día completo", () => {
    const daily = [
      { date: "2026-02-14", kcal: 1200 }, // > 500 (suelo absoluto) pero < 60% de 2600
      { date: "2026-02-13", kcal: 2550 },
    ];
    const targetKcalByDate = new Map([["2026-02-14", 2600], ["2026-02-13", 2600]]);
    const result = calcIntakeCoverage(daily, REF, 7, targetKcalByDate)!;
    expect(result.daysWithData).toBe(1);
    expect(result.avgKcal).toBe(2550);
  });

  it("un déficit deliberado cumplido al 100% del objetivo SÍ cuenta (el suelo relativo no penaliza objetivos bajos)", () => {
    const daily = [{ date: "2026-02-14", kcal: 1500 }];
    const result = calcIntakeCoverage(daily, REF, 7, new Map([["2026-02-14", 1500]]))!;
    expect(result.daysWithData).toBe(1);
  });

  it("justo en el límite del 60% cuenta; un kcal por debajo no", () => {
    const targetKcalByDate = new Map([["2026-02-14", 2000]]);
    const atThreshold = calcIntakeCoverage([{ date: "2026-02-14", kcal: 1200 }], REF, 7, targetKcalByDate)!; // exactamente 60%
    expect(atThreshold.daysWithData).toBe(1);
    const belowThreshold = calcIntakeCoverage([{ date: "2026-02-14", kcal: 1199 }], REF, 7, targetKcalByDate);
    expect(belowThreshold).toBeNull();
  });

  it("con targetKcalByDate, sigue exigiendo también el suelo absoluto de 500 kcal (objetivos muy bajos no lo saltan)", () => {
    // 60% de un objetivo de 700 son 420 kcal — por debajo del suelo absoluto,
    // así que 450 kcal registradas NO deberían contar como día fiable.
    const result = calcIntakeCoverage([{ date: "2026-02-14", kcal: 450 }], REF, 7, new Map([["2026-02-14", 700]]));
    expect(result).toBeNull();
  });

  // ── nutrition-v3 §2.3: target real por fecha, nunca inventado ────────────

  it("un día sin fila nutrition_goals para esa fecha no aplica suelo relativo (no inventa el target del perfil actual)", () => {
    const daily = [
      { date: "2026-02-14", kcal: 1200 }, // tiene target conocido: 1200 < 60% de 2600, se descartaría CON suelo relativo
      { date: "2026-02-13", kcal: 600 },  // SIN entrada en el mapa — por encima del suelo absoluto (500), debe contar
    ];
    // Solo 02-14 tiene fila histórica; 02-13 no (hueco en nutrition_goals).
    const targetKcalByDate = new Map([["2026-02-14", 2600]]);
    const result = calcIntakeCoverage(daily, REF, 7, targetKcalByDate)!;
    // 02-14 se descarta por el suelo relativo (1200 < 1560), 02-13 SÍ cuenta
    // porque sin target conocido solo se exige el suelo absoluto — no se
    // reconstruye el target de ese día con el perfil actual.
    expect(result.daysWithData).toBe(1);
    expect(result.avgKcal).toBe(600);
  });

  it("targetKcalByDate vacío o ausente se comporta igual (retrocompatible, solo suelo absoluto)", () => {
    const daily = [{ date: "2026-02-14", kcal: 600 }];
    const withEmptyMap = calcIntakeCoverage(daily, REF, 7, new Map())!;
    const withoutMap = calcIntakeCoverage(daily, REF, 7)!;
    expect(withEmptyMap.daysWithData).toBe(withoutMap.daysWithData);
    expect(withEmptyMap.avgKcal).toBe(withoutMap.avgKcal);
  });
});

describe("calcAdaptiveTdee", () => {
  const trend = (confidence: WeightTrendResult["confidence"], slopeKgPerDay: number): WeightTrendResult => ({
    latestWeightKg: 80,
    trendWeightKg: 80,
    slopeKgPerDay,
    weeklyChangeKg: slopeKgPerDay * 7,
    weeklyChangePercent: (slopeKgPerDay * 7 / 80) * 100,
    validMeasurements: 14,
    confidence,
    qualityScore: confidence === "high" ? 0.9 : confidence === "moderate" ? 0.7 : 0.4,
  });

  it("insufficient_data si no hay tendencia de peso", () => {
    const result = calcAdaptiveTdee({ initialTdeeKcal: 2200, avgIntakeKcal: 2000, weightTrend: null });
    expect(result.confidence).toBe("insufficient_data");
    expect(result.observedKcal).toBeNull();
    expect(result.combinedKcal).toBe(2200);
  });

  it("insufficient_data si no hay ingesta media", () => {
    const result = calcAdaptiveTdee({ initialTdeeKcal: 2200, avgIntakeKcal: null, weightTrend: trend("high", -0.05) });
    expect(result.confidence).toBe("insufficient_data");
  });

  it("perdiendo peso: el TDEE observado es mayor que la ingesta media", () => {
    const result = calcAdaptiveTdee({ initialTdeeKcal: 2200, avgIntakeKcal: 1900, weightTrend: trend("high", -0.05) });
    expect(result.observedKcal).toBe(Math.round(1900 - -0.05 * 7700));
    expect(result.observedKcal!).toBeGreaterThan(1900);
  });

  it("ganando peso: el TDEE observado es menor que la ingesta media", () => {
    const result = calcAdaptiveTdee({ initialTdeeKcal: 2200, avgIntakeKcal: 2600, weightTrend: trend("high", 0.05) });
    expect(result.observedKcal!).toBeLessThan(2600);
  });

  it("el combinado se acerca más al observado cuanta más confianza (peso mayor)", () => {
    const params = (confidence: WeightTrendResult["confidence"]) =>
      calcAdaptiveTdee({ initialTdeeKcal: 2200, avgIntakeKcal: 1800, weightTrend: trend(confidence, -0.1) });
    const low = params("low");
    const high = params("high");
    // Con más confianza, el combinado se aleja más del inicial (2200) hacia el observado.
    expect(Math.abs(high.combinedKcal - high.initialKcal)).toBeGreaterThan(Math.abs(low.combinedKcal - low.initialKcal));
  });

  it("sin discrepancia fuerte, warnings queda vacío", () => {
    const result = calcAdaptiveTdee({ initialTdeeKcal: 2200, avgIntakeKcal: 2000, weightTrend: trend("high", -0.02) });
    expect(result.warnings).toEqual([]);
  });

  it("marca tdee_estimates_strongly_disagree cuando observado y fórmula difieren >30%", () => {
    // slope muy agresivo -> observado se dispara muy por encima del inicial
    const result = calcAdaptiveTdee({ initialTdeeKcal: 2200, avgIntakeKcal: 2000, weightTrend: trend("high", -0.15) });
    expect(Math.abs(result.observedKcal! - result.initialKcal)).toBeGreaterThan(result.initialKcal * 0.3);
    expect(result.warnings).toContain("tdee_estimates_strongly_disagree");
  });
});

// ─── Adaptive v3 (PR2) — controlador por ritmo, ver docs/NUTRITION_V3_DECISIONES.md §6 ──

describe("assessWeightTrajectory (bandas semanales, bordes inclusivos)", () => {
  it("fat_loss: dentro/fuera de [-1.00, -0.50] %/semana", () => {
    expect(assessWeightTrajectory("fat_loss", -1.00)).toBe("inside"); // borde
    expect(assessWeightTrajectory("fat_loss", -0.75)).toBe("inside");
    expect(assessWeightTrajectory("fat_loss", -0.50)).toBe("inside"); // borde
    expect(assessWeightTrajectory("fat_loss", -1.01)).toBe("below");  // pierde más rápido de lo esperado
    expect(assessWeightTrajectory("fat_loss", -0.49)).toBe("above");  // pierde más despacio de lo esperado
  });

  it("muscle_gain: dentro/fuera de [+0.25, +0.50] %/semana", () => {
    expect(assessWeightTrajectory("muscle_gain", 0.25)).toBe("inside"); // borde
    expect(assessWeightTrajectory("muscle_gain", 0.50)).toBe("inside"); // borde
    expect(assessWeightTrajectory("muscle_gain", 0.24)).toBe("below");  // gana más despacio de lo esperado
    expect(assessWeightTrajectory("muscle_gain", 0.51)).toBe("above");  // gana más rápido de lo esperado
  });

  it("maintain: dentro/fuera de [-0.25, +0.25] %/semana", () => {
    expect(assessWeightTrajectory("maintain", -0.25)).toBe("inside");
    expect(assessWeightTrajectory("maintain", 0.25)).toBe("inside");
    expect(assessWeightTrajectory("maintain", -0.26)).toBe("below");
    expect(assessWeightTrajectory("maintain", 0.26)).toBe("above");
  });

  it("recomp: banda ASIMÉTRICA [-0.50, 0.00] %/semana — casos obligatorios del contrato", () => {
    expect(assessWeightTrajectory("recomp", -0.50)).toBe("inside");
    expect(assessWeightTrajectory("recomp", -0.25)).toBe("inside");
    expect(assessWeightTrajectory("recomp", 0.00)).toBe("inside");
    expect(assessWeightTrajectory("recomp", -0.51)).toBe("below"); // fuera por abajo
    expect(assessWeightTrajectory("recomp", 0.01)).toBe("above");  // fuera por arriba
  });
});

describe("evaluateAdaptiveState — invariantes de dirección (docs §6.9)", () => {
  const goodCoverage: IntakeCoverageResult = { avgKcal: 1900, coverageFraction: 0.9, daysWithData: 25, windowDays: 28 };
  const trend = (weeklyChangePercent: number, overrides: Partial<WeightTrendResult> = {}): WeightTrendResult => ({
    latestWeightKg: 80, trendWeightKg: 80, slopeKgPerDay: weeklyChangePercent / 700,
    weeklyChangeKg: (weeklyChangePercent / 100) * 80 / 7 * 7, weeklyChangePercent,
    validMeasurements: 25, confidence: "high", qualityScore: 0.9,
    ...overrides,
  });
  const evaluate = (goal: GoalMode, weeklyChangePercent: number) =>
    evaluateAdaptiveState({
      goal, currentTargetKcal: 2000, weightTrend: trend(weeklyChangePercent),
      intakeCoverage: goodCoverage, lastAdjustmentDecisionAt: null, referenceDate: "2026-02-14",
    });

  it.each([
    ["fat_loss",    -0.20, -100], // pierde despacio (por encima de -0.50) → bajar kcal
    ["fat_loss",    -1.50,  100], // pierde rápido (por debajo de -1.00)   → subir kcal
    ["muscle_gain",  0.10,  100], // gana despacio (por debajo de +0.25)   → subir kcal
    ["muscle_gain",  0.80, -100], // gana rápido (por encima de +0.50)     → bajar kcal
    ["maintain",     0.50, -100], // gana                                  → bajar kcal
    ["maintain",    -0.50,  100], // pierde                                → subir kcal
    ["recomp",       0.30, -100], // gana (>0%)                            → bajar kcal
    ["recomp",      -0.80,  100], // pierde más de -0.5%                   → subir kcal
  ] as const)("%s con ritmo %f%%/semana → deltaKcal = %i", (goal, pct, expectedDelta) => {
    const result = evaluate(goal, pct);
    expect(result.deltaKcal).toBe(expectedDelta);
    expect(result.shouldPropose).toBe(true);
    expect(result.proposedTargetKcal).toBe(2000 + expectedDelta);
  });

  it.each(["fat_loss", "muscle_gain", "maintain", "recomp"] as const)(
    "%s: dentro de la banda → deltaKcal = 0, shouldPropose = false",
    (goal) => {
      const band = GOAL_RATE_BAND_PCT_PER_WEEK[goal];
      const midpoint = (band.minPct + band.maxPct) / 2;
      const result = evaluate(goal, midpoint);
      expect(result.deltaKcal).toBe(0);
      expect(result.shouldPropose).toBe(false);
      expect(result.trajectory).toBe("inside");
    }
  );

  it("el delta nunca es un valor intermedio — solo -100, 0 o +100", () => {
    for (const pct of [-3, -1.5, -0.9, -0.5, -0.3, -0.1, 0, 0.1, 0.3, 0.6, 1, 3]) {
      const result = evaluate("fat_loss", pct);
      expect([-100, 0, 100]).toContain(result.deltaKcal);
    }
  });
});

describe("evaluateAdaptiveState — gates de calidad (no accionan sin datos buenos)", () => {
  const goodCoverage: IntakeCoverageResult = { avgKcal: 1900, coverageFraction: 0.9, daysWithData: 25, windowDays: 28 };
  const goodTrend: WeightTrendResult = {
    latestWeightKg: 80, trendWeightKg: 80, slopeKgPerDay: -0.02,
    weeklyChangeKg: -0.7, weeklyChangePercent: -0.20, // fuera de banda fat_loss → dispararía si no fuera por el gate
    validMeasurements: 25, confidence: "high", qualityScore: 0.9,
  };
  const base = {
    goal: "fat_loss" as const, currentTargetKcal: 2000,
    lastAdjustmentDecisionAt: null as string | null, referenceDate: "2026-02-14",
  };

  it("sin weightTrend, no propone (trajectory null, no se inventa 'inside')", () => {
    const result = evaluateAdaptiveState({ ...base, weightTrend: null, intakeCoverage: goodCoverage });
    expect(result.shouldPropose).toBe(false);
    expect(result.trajectory).toBeNull();
    expect(result.blockingReasons.length).toBeGreaterThan(0);
  });

  it("sin intakeCoverage, no propone", () => {
    const result = evaluateAdaptiveState({ ...base, weightTrend: goodTrend, intakeCoverage: null });
    expect(result.shouldPropose).toBe(false);
  });

  it("confianza != 'high' bloquea (gate semántico directo, no vía ADAPTIVE_CONFIDENCE_WEIGHTS)", () => {
    const result = evaluateAdaptiveState({
      ...base, weightTrend: { ...goodTrend, confidence: "moderate" }, intakeCoverage: goodCoverage,
    });
    expect(result.shouldPropose).toBe(false);
    expect(result.blockingReasons.some((r) => r.includes("confianza"))).toBe(true);
  });

  it("cobertura < 85% bloquea (gate de interpretabilidad, no de adherencia)", () => {
    const result = evaluateAdaptiveState({
      ...base, weightTrend: goodTrend, intakeCoverage: { ...goodCoverage, coverageFraction: 0.5 },
    });
    expect(result.shouldPropose).toBe(false);
  });

  it("días evaluados < mínimo provisional bloquea", () => {
    const result = evaluateAdaptiveState({
      ...base, weightTrend: { ...goodTrend, validMeasurements: 5 }, intakeCoverage: goodCoverage,
    });
    expect(result.shouldPropose).toBe(false);
  });

  it("cooldown activo bloquea, pero trajectory/deltaKcal se siguen calculando (no se pierde la información)", () => {
    const result = evaluateAdaptiveState({
      ...base, weightTrend: goodTrend, intakeCoverage: goodCoverage,
      lastAdjustmentDecisionAt: "2026-02-10", referenceDate: "2026-02-14", // 4 días < cooldown de 14
    });
    expect(result.shouldPropose).toBe(false);
    expect(result.trajectory).toBe("above"); // -0.20 está por encima de -0.50 (pierde despacio)
    expect(result.deltaKcal).toBe(0); // shouldPropose=false SIEMPRE trae deltaKcal 0 en el resultado final
    expect(result.blockingReasons.some((r) => r.toLowerCase().includes("esperar"))).toBe(true);
  });

  it("con todos los gates en verde, propone", () => {
    const result = evaluateAdaptiveState({ ...base, weightTrend: goodTrend, intakeCoverage: goodCoverage });
    expect(result.shouldPropose).toBe(true);
    expect(result.deltaKcal).toBe(-100);
  });
});

describe("evaluateAdaptiveState — test anti-7700 (prueba ejecutable del desacoplamiento arquitectónico)", () => {
  it("evaluateAdaptiveState no acepta avgIntakeKcal/observedTdeeKcal en absoluto — desacoplamiento garantizado por el tipo, no solo por convención", () => {
    // Esto es más fuerte que un test de comportamiento: la firma de
    // evaluateAdaptiveState ni siquiera tiene un parámetro para el TDEE
    // observado vía 7700 — es estructuralmente imposible que lo use.
    const goodCoverage: IntakeCoverageResult = { avgKcal: 1900, coverageFraction: 0.9, daysWithData: 25, windowDays: 28 };
    const trend: WeightTrendResult = {
      latestWeightKg: 80, trendWeightKg: 80, slopeKgPerDay: -0.03,
      weeklyChangeKg: -0.9, weeklyChangePercent: -0.75, validMeasurements: 25, confidence: "high", qualityScore: 0.9,
    };
    const result = evaluateAdaptiveState({
      goal: "fat_loss", currentTargetKcal: 2000, weightTrend: trend, intakeCoverage: goodCoverage,
      lastAdjustmentDecisionAt: null, referenceDate: "2026-02-14",
    });
    // -0.75%/sem está DENTRO de la banda fat_loss [-1.00,-0.50] — sin
    // necesidad de saber nada sobre ingesta/7700 para llegar a esta conclusión.
    expect(result.trajectory).toBe("inside");
    expect(result.shouldPropose).toBe(false);
  });
});

// ─── PR8: versionado del motor + evidencia de propuestas (N1/N13) ──────────

describe("NUTRITION_ENGINE_VERSION", () => {
  it("es la constante v3.1 — PR1-3 (v3) + MET de cardio por tipo/intensidad, solapamiento, incertidumbre y explicabilidad (v3.1) ya cerrados", () => {
    expect(NUTRITION_ENGINE_VERSION).toBe("nutrition-v3.1");
  });
});

describe("buildAdjustmentEvidence", () => {
  const weightLog: WeightEntry[] = Array.from({ length: 20 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    kg: 80 - i * 0.05,
  }));
  const dailyKcal = Array.from({ length: 20 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    kcal: 2100,
  }));

  it("traslada 1:1 los campos del diagnóstico ya calculado, sin recalcular nada distinto", () => {
    const diagnostics = getAdaptiveDiagnostics({
      goal: "maintain",
      weightLog,
      dailyKcal,
      referenceDate: "2026-01-20",
      initialTdeeKcal: 2400,
      currentTargetKcal: 1900,
      lastAdjustmentDecisionAt: null,
    });
    const evidence = buildAdjustmentEvidence(diagnostics, [], NUTRITION_ENGINE_VERSION);

    expect(evidence.evaluationWindow).toEqual({ start: diagnostics.evaluationStart, end: diagnostics.evaluationEnd });
    expect(evidence.intakeCoverage).toBe(diagnostics.calorieCoverage);
    expect(evidence.averageIntakeKcal).toBe(diagnostics.averageLoggedCalories);
    expect(evidence.weightMeasurements).toBe(diagnostics.weightMeasurements);
    expect(evidence.regressionSlopeKgPerDay).toBe(diagnostics.regressionSlopeKgPerDay);
    expect(evidence.confidence).toBe(diagnostics.confidenceLevel);
    expect(evidence.initialTdeeKcal).toBe(diagnostics.initialTdeeKcal);
    expect(evidence.observedTdeeKcal).toBe(diagnostics.observedTdeeKcal);
    expect(evidence.combinedTdeeKcal).toBe(diagnostics.blendedTdeeKcal);
    expect(evidence.engineVersion).toBe(NUTRITION_ENGINE_VERSION);
  });

  it("conserva los warnings del TDEE adaptativo que recibe (no los del diagnóstico, que no los expone)", () => {
    const diagnostics = getAdaptiveDiagnostics({
      goal: "maintain",
      weightLog,
      dailyKcal,
      referenceDate: "2026-01-20",
      initialTdeeKcal: 2400,
      currentTargetKcal: 1900,
      lastAdjustmentDecisionAt: null,
    });
    const evidence = buildAdjustmentEvidence(diagnostics, ["tdee_estimates_strongly_disagree"], NUTRITION_ENGINE_VERSION);
    expect(evidence.warnings).toEqual(["tdee_estimates_strongly_disagree"]);
  });

  it("nunca queda vacía: siempre hay al menos ventana evaluada, TDEE inicial y versión — a diferencia del evidence:{} anterior", () => {
    const diagnostics = getAdaptiveDiagnostics({
      goal: "maintain",
      weightLog: [],
      dailyKcal: [],
      referenceDate: "2026-01-20",
      initialTdeeKcal: 2400,
      currentTargetKcal: 1900,
      lastAdjustmentDecisionAt: null,
    });
    const evidence = buildAdjustmentEvidence(diagnostics, [], NUTRITION_ENGINE_VERSION);
    expect(Object.keys(evidence).length).toBeGreaterThan(0);
    expect(evidence.evaluationWindow.start).toBeTruthy();
    expect(evidence.initialTdeeKcal).toBe(2400);
    expect(evidence.engineVersion).toBe(NUTRITION_ENGINE_VERSION);
  });
});

// ─── PR9: ciclo de calibración y propuestas obsoletas (N4/N5) ─────────────

describe("isRelevantCalibrationChange", () => {
  const training: TrainingActivityProfile = {
    lifestyleActivity: "light", strengthDaysPerWeek: 3, cardioDaysPerWeek: 1, strengthAvgDurationMin: 60, cardioAvgDurationMin: 60,
  };

  it("prev=null (primer perfil) nunca cuenta como cambio", () => {
    expect(isRelevantCalibrationChange(null, baseProfile())).toBe(false);
  });

  it("no cambia nada relevante: false", () => {
    const prev = baseProfile({ weightKg: 75 });
    const next = baseProfile({ weightKg: 74 }); // solo cambia el peso
    expect(isRelevantCalibrationChange(prev, next)).toBe(false);
  });

  it("cambiar el objetivo (goal) SÍ reinicia la calibración", () => {
    const prev = baseProfile({ goal: "maintain" });
    const next = baseProfile({ goal: "fat_loss" });
    expect(isRelevantCalibrationChange(prev, next)).toBe(true);
  });

  it("cambiar activityLevel SÍ reinicia la calibración", () => {
    const prev = baseProfile({ activityLevel: "sedentary" });
    const next = baseProfile({ activityLevel: "active" });
    expect(isRelevantCalibrationChange(prev, next)).toBe(true);
  });

  it("cambiar activityModelVersion SÍ reinicia la calibración", () => {
    const prev = baseProfile({ activityModelVersion: "legacy_total_pal" });
    const next = baseProfile({ activityModelVersion: "lifestyle_plus_training", trainingActivity: training });
    expect(isRelevantCalibrationChange(prev, next)).toBe(true);
  });

  it("cambiar días de fuerza/cardio o duración de trainingActivity SÍ reinicia la calibración", () => {
    const prev = baseProfile({ activityModelVersion: "lifestyle_plus_training", trainingActivity: training });
    const next = baseProfile({
      activityModelVersion: "lifestyle_plus_training",
      trainingActivity: { ...training, strengthDaysPerWeek: 5 },
    });
    expect(isRelevantCalibrationChange(prev, next)).toBe(true);
  });

  it("cambiar solo habitualSteps NO reinicia la calibración (N8: todavía no afecta al cálculo)", () => {
    const prev = baseProfile({ activityModelVersion: "lifestyle_plus_training", trainingActivity: { ...training, habitualSteps: 5000 } });
    const next = baseProfile({ activityModelVersion: "lifestyle_plus_training", trainingActivity: { ...training, habitualSteps: 12000 } });
    expect(isRelevantCalibrationChange(prev, next)).toBe(false);
  });
});

describe("filterEntriesFromCalibrationStart", () => {
  const entries = [
    { date: "2026-01-01", kg: 80 },
    { date: "2026-01-10", kg: 79 },
    { date: "2026-01-20", kg: 78 },
  ];

  it("sin fecha de calibración, no filtra nada (comportamiento previo a PR9)", () => {
    expect(filterEntriesFromCalibrationStart(entries, null)).toEqual(entries);
    expect(filterEntriesFromCalibrationStart(entries, undefined)).toEqual(entries);
  });

  it("con fecha de calibración, solo conserva date >= esa fecha", () => {
    const result = filterEntriesFromCalibrationStart(entries, "2026-01-10");
    expect(result.map((e) => e.date)).toEqual(["2026-01-10", "2026-01-20"]);
  });

  it("una fecha posterior a todas las entradas deja el resultado vacío", () => {
    expect(filterEntriesFromCalibrationStart(entries, "2026-02-01")).toEqual([]);
  });
});

describe("buildAdjustmentProfileFingerprint / isProposalStale", () => {
  it("dos perfiles idénticos producen fingerprints iguales → no obsoleta", () => {
    const profile = baseProfile({ adaptiveKcalOffsetKcal: 50 });
    const a = buildAdjustmentProfileFingerprint(profile, "balanced");
    const b = buildAdjustmentProfileFingerprint({ ...profile }, "balanced");
    expect(isProposalStale(a, b)).toBe(false);
  });

  it("sin fingerprint original (propuesta previa a PR9), nunca se considera obsoleta", () => {
    const current = buildAdjustmentProfileFingerprint(baseProfile(), "balanced");
    expect(isProposalStale(undefined, current)).toBe(false);
  });

  it("cambiar el objetivo entre generar y aceptar marca la propuesta como obsoleta", () => {
    const original = buildAdjustmentProfileFingerprint(baseProfile({ goal: "maintain" }), "balanced");
    const current = buildAdjustmentProfileFingerprint(baseProfile({ goal: "fat_loss" }), "balanced");
    expect(isProposalStale(original, current)).toBe(true);
  });

  it("cambiar el peso entre generar y aceptar marca la propuesta como obsoleta", () => {
    const original = buildAdjustmentProfileFingerprint(baseProfile({ weightKg: 80 }), "balanced");
    const current = buildAdjustmentProfileFingerprint(baseProfile({ weightKg: 78 }), "balanced");
    expect(isProposalStale(original, current)).toBe(true);
  });

  it("cambiar la preferencia de macros marca la propuesta como obsoleta", () => {
    const original = buildAdjustmentProfileFingerprint(baseProfile(), "balanced");
    const current = buildAdjustmentProfileFingerprint(baseProfile(), "higher_carbohydrate");
    expect(isProposalStale(original, current)).toBe(true);
  });

  it("aceptar otra propuesta mientras esta seguía pendiente (offset distinto) la marca obsoleta", () => {
    const original = buildAdjustmentProfileFingerprint(baseProfile({ adaptiveKcalOffsetKcal: 0 }), "balanced");
    const current = buildAdjustmentProfileFingerprint(baseProfile({ adaptiveKcalOffsetKcal: 80 }), "balanced");
    expect(isProposalStale(original, current)).toBe(true);
  });

  // ── PR4 — nutrition-v3 §6.11: completar el fingerprint con inputs que
  // cambian materialmente el plan (RMR/IMC/base de proteína) y no estaban
  // cubiertos hasta la auditoría final.

  it("cambiar la edad marca la propuesta como obsoleta (cambia RMR)", () => {
    const original = buildAdjustmentProfileFingerprint(baseProfile({ age: 30 }), "balanced");
    const current = buildAdjustmentProfileFingerprint(baseProfile({ age: 31 }), "balanced");
    expect(isProposalStale(original, current)).toBe(true);
  });

  it("cambiar el sexo marca la propuesta como obsoleta (cambia RMR)", () => {
    const original = buildAdjustmentProfileFingerprint(baseProfile({ sex: "male" }), "balanced");
    const current = buildAdjustmentProfileFingerprint(baseProfile({ sex: "female" }), "balanced");
    expect(isProposalStale(original, current)).toBe(true);
  });

  it("cambiar la altura marca la propuesta como obsoleta (cambia RMR e IMC)", () => {
    const original = buildAdjustmentProfileFingerprint(baseProfile({ heightCm: 175 }), "balanced");
    const current = buildAdjustmentProfileFingerprint(baseProfile({ heightCm: 180 }), "balanced");
    expect(isProposalStale(original, current)).toBe(true);
  });

  it("declarar/cambiar el % de grasa marca la propuesta como obsoleta (cambia la base de proteína a fat_free_mass)", () => {
    const original = buildAdjustmentProfileFingerprint(baseProfile({ bodyFatPct: null }), "balanced");
    const current = buildAdjustmentProfileFingerprint(baseProfile({ bodyFatPct: 20 }), "balanced");
    expect(isProposalStale(original, current)).toBe(true);
  });

  it("bodyFatSource NO forma parte del fingerprint — solo cambia procedencia/UX, ningún target (decisión v3 §2.4/§9)", () => {
    const original = buildAdjustmentProfileFingerprint(baseProfile({ bodyFatPct: 20, bodyFatSource: null }), "balanced");
    const current = buildAdjustmentProfileFingerprint(baseProfile({ bodyFatPct: 20, bodyFatSource: "dxa" }), "balanced");
    expect(isProposalStale(original, current)).toBe(false);
  });

  it("gymDays NO forma parte del fingerprint — evaluateAdaptiveState() ni siquiera recibe gymDay, el offset es independiente del tipo de día (§6.11)", () => {
    const original = buildAdjustmentProfileFingerprint(baseProfile({ gymDays: [1, 3, 5] }), "balanced");
    const current = buildAdjustmentProfileFingerprint(baseProfile({ gymDays: [0, 2, 4, 6] }), "balanced");
    expect(isProposalStale(original, current)).toBe(false);
  });

  it("un fingerprint persistido entre PR9 y PR4 (sin age/sex/heightCm/bodyFatPct) se trata como obsoleto al compararlo — degradación segura, no un crash", () => {
    // Simula una propuesta ya guardada en DB antes de que existieran estos
    // campos: el objeto existe (no es undefined, ese caso ya lo cubre "sin
    // fingerprint original"), pero le faltan las claves nuevas. undefined
    // !== valor actual siempre es true, así que la propuesta se invalida
    // — el comportamiento correcto por defecto (bloquear una aceptación
    // sobre datos incompletos), documentado explícitamente aquí para que
    // no sorprenda si aparece en producción tras desplegar PR4.
    const legacyFingerprint = {
      goal: "recomp", weightKg: 80, activityLevel: "moderate", activityModelVersion: "legacy_total_pal",
      trainingActivity: null, macroPreference: "balanced", adaptiveKcalOffsetKcal: 0,
    } as unknown as ReturnType<typeof buildAdjustmentProfileFingerprint>;
    const current = buildAdjustmentProfileFingerprint(
      baseProfile({ goal: "recomp", weightKg: 80, activityModelVersion: "legacy_total_pal" }),
      "balanced"
    );
    expect(isProposalStale(legacyFingerprint, current)).toBe(true);
  });
});

describe("getAdaptiveDiagnostics — ventana recortada por calibración (PR9)", () => {
  const weightLog: WeightEntry[] = Array.from({ length: 40 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    kg: 80,
  })).filter((e) => Number(e.date.slice(-2)) <= 31);
  const dailyKcal = weightLog.map((e) => ({ date: e.date, kcal: 2100 }));

  it("sin calibración, la ventana evaluada es la estándar (referenceDate - windowDays)", () => {
    const diagnostics = getAdaptiveDiagnostics({
      goal: "maintain", weightLog, dailyKcal, referenceDate: "2026-02-10", initialTdeeKcal: 2400, currentTargetKcal: 1900,
      lastAdjustmentDecisionAt: null,
    });
    expect(diagnostics.evaluationStart).toBe("2026-01-13"); // 2026-02-10 - 28 días
  });

  it("con una calibración MÁS RECIENTE que la ventana estándar, la ventana se recorta a esa fecha", () => {
    const diagnostics = getAdaptiveDiagnostics({
      goal: "maintain", weightLog, dailyKcal, referenceDate: "2026-02-10", initialTdeeKcal: 2400, currentTargetKcal: 1900,
      lastAdjustmentDecisionAt: null,
      calibrationStartedAt: "2026-01-25",
    });
    expect(diagnostics.evaluationStart).toBe("2026-01-25");
  });

  it("con una calibración MÁS ANTIGUA que la ventana estándar, no la alarga (el techo de 28 días se mantiene)", () => {
    const diagnostics = getAdaptiveDiagnostics({
      goal: "maintain", weightLog, dailyKcal, referenceDate: "2026-02-10", initialTdeeKcal: 2400, currentTargetKcal: 1900,
      lastAdjustmentDecisionAt: null,
      calibrationStartedAt: "2025-12-01",
    });
    expect(diagnostics.evaluationStart).toBe("2026-01-13");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// nutrition-v3.1 — precisión y explicabilidad del gasto energético
// (ver docs/NUTRITION_V3_DECISIONES.md §11)
// ═══════════════════════════════════════════════════════════════════════════

/** Perfil de referencia del diagnóstico: 124kg/177cm sedentario, fuerza
    5×60min, cardio 5×100min — el caso que reportó TDEE 4015 con MET 7.0
    fijo, sin preguntar intensidad. */
function referenceObeseProfile(training: Partial<TrainingActivityProfile> = {}): PhysicalProfile {
  return baseProfile({
    age: 24,
    sex: "male",
    heightCm: 177,
    weightKg: 124,
    activityLevel: "sedentary",
    activityModelVersion: "lifestyle_plus_training",
    goal: "recomp",
    gymDays: [1, 2, 3, 4, 5],
    trainingActivity: {
      lifestyleActivity: "sedentary",
      strengthDaysPerWeek: 5,
      cardioDaysPerWeek: 5,
      strengthAvgDurationMin: 60,
      cardioAvgDurationMin: 100,
      habitualSteps: null,
      ...training,
    },
  });
}

describe("nutrition-v3.1 — MET de cardio por tipo × intensidad", () => {
  it("1) misma duración: cardio suave < moderado < intenso en gasto estimado", () => {
    const tmb = calcTMB(124, 177, 24, "male");
    const light    = referenceObeseProfile({ cardioType: "run", cardioIntensity: "light" });
    const moderate = referenceObeseProfile({ cardioType: "run", cardioIntensity: "moderate" });
    const vigorous = referenceObeseProfile({ cardioType: "run", cardioIntensity: "vigorous" });

    const tdeeLight    = calcTDEE(light, tmb);
    const tdeeModerate = calcTDEE(moderate, tmb);
    const tdeeVigorous = calcTDEE(vigorous, tmb);

    expect(tdeeLight).toBeLessThan(tdeeModerate);
    expect(tdeeModerate).toBeLessThan(tdeeVigorous);
  });

  it("perfil legacy/sin confirmar usa un MET propio (4.5), no el 7.0 fijo de antes", () => {
    const tmb = calcTMB(124, 177, 24, "male");
    const unconfirmed = referenceObeseProfile(); // sin cardioType/cardioIntensity
    const tdee = calcTDEE(unconfirmed, tmb);
    // Con MET 7.0 fijo (comportamiento anterior) el TDEE rondaba 4015.
    expect(tdee).toBeLessThan(4015);
    expect(tdee).toBeGreaterThan(3400);
  });
});

describe("nutrition-v3.1 — solapamiento fuerza/cardio", () => {
  it("2) cardio incluido en la sesión de fuerza no se cuenta dos veces", () => {
    const tmb = 1500;
    const weightKg = 80;
    const additive = baseProfile({
      weightKg, activityModelVersion: "lifestyle_plus_training",
      trainingActivity: {
        lifestyleActivity: "sedentary",
        strengthDaysPerWeek: 3, cardioDaysPerWeek: 3,
        strengthAvgDurationMin: 60, cardioAvgDurationMin: 20,
        habitualSteps: null,
        cardioType: "bike", cardioIntensity: "moderate",
      },
    });
    const overlapping = baseProfile({
      weightKg, activityModelVersion: "lifestyle_plus_training",
      trainingActivity: {
        lifestyleActivity: "sedentary",
        strengthDaysPerWeek: 3, cardioDaysPerWeek: 3,
        strengthAvgDurationMin: 60, cardioAvgDurationMin: 20,
        habitualSteps: null,
        cardioType: "bike", cardioIntensity: "moderate",
        cardioOverlapDaysPerWeek: 3,
        strengthAvgDurationMinIncludesCardio: true,
      },
    });

    // Con el cardio incluido en la sesión (20 de los 60 minutos totales),
    // el TDEE debe ser MENOR que tratarlo como tiempo aditivo aparte —
    // nunca igual (eso significaría que el flag no hizo nada) ni mayor.
    expect(calcTDEE(overlapping, tmb)).toBeLessThan(calcTDEE(additive, tmb));
  });

  it("no trunca minutos en silencio: cardio > duración total con el flag activo se trata como aditivo, no se recorta", () => {
    const tmb = 1500;
    const weightKg = 80;
    const inconsistent = baseProfile({
      weightKg, activityModelVersion: "lifestyle_plus_training",
      trainingActivity: {
        lifestyleActivity: "sedentary",
        strengthDaysPerWeek: 3, cardioDaysPerWeek: 3,
        strengthAvgDurationMin: 60, cardioAvgDurationMin: 100, // > 60
        habitualSteps: null,
        cardioType: "run", cardioIntensity: "moderate",
        cardioOverlapDaysPerWeek: 3,
        strengthAvgDurationMinIncludesCardio: true,
      },
    });
    const additiveEquivalent = baseProfile({
      weightKg, activityModelVersion: "lifestyle_plus_training",
      trainingActivity: {
        lifestyleActivity: "sedentary",
        strengthDaysPerWeek: 3, cardioDaysPerWeek: 3,
        strengthAvgDurationMin: 60, cardioAvgDurationMin: 100,
        habitualSteps: null,
        cardioType: "run", cardioIntensity: "moderate",
        // sin overlap activo — mismo dato, tratamiento aditivo explícito
      },
    });
    // El dato inconsistente cae al mismo resultado que el aditivo explícito
    // (fallback documentado), no a una versión con los 100 min recortados a 60.
    expect(calcTDEE(inconsistent, tmb)).toBe(calcTDEE(additiveEquivalent, tmb));

    expect(validateTrainingActivity(inconsistent.trainingActivity!)).toContain(
      "Si el cardio está incluido en la sesión de fuerza, sus minutos no pueden superar la duración total de esa sesión — ajusta las duraciones en vez de guardar así.",
    );
  });

  it("validateTrainingActivity: días de solape no pueden superar min(fuerza, cardio)", () => {
    const training: TrainingActivityProfile = {
      lifestyleActivity: "sedentary",
      strengthDaysPerWeek: 2, cardioDaysPerWeek: 5,
      strengthAvgDurationMin: 60, cardioAvgDurationMin: 30,
      habitualSteps: null,
      cardioOverlapDaysPerWeek: 3, // > min(2,5)=2
    };
    expect(validateTrainingActivity(training).length).toBeGreaterThan(0);
  });
});

describe("nutrition-v3.1 — pasos y doble conteo (3)", () => {
  it("3) stepsIncludeCardio no cambia el TDEE — los pasos siguen sin entrar en ninguna fórmula", () => {
    const tmb = 1500;
    const base = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "moderate", habitualSteps: 12000 });
    const withFlagTrue = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "moderate", habitualSteps: 12000, stepsIncludeCardio: true });
    const withFlagFalse = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "moderate", habitualSteps: 12000, stepsIncludeCardio: false });
    expect(calcTDEE(withFlagTrue, tmb)).toBe(calcTDEE(base, tmb));
    expect(calcTDEE(withFlagFalse, tmb)).toBe(calcTDEE(base, tmb));
  });
});

describe("nutrition-v3.1 — fingerprint / staleness (4)", () => {
  it("4) cambiar cardioType, cardioIntensity, strengthIntensity, overlap o el flag de sesión combinada invalida la propuesta", () => {
    const base = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "light" });
    const original = buildAdjustmentProfileFingerprint(base, "balanced");

    const changedType = referenceObeseProfile({ cardioType: "run", cardioIntensity: "light" });
    expect(isProposalStale(original, buildAdjustmentProfileFingerprint(changedType, "balanced"))).toBe(true);

    const changedIntensity = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "vigorous" });
    expect(isProposalStale(original, buildAdjustmentProfileFingerprint(changedIntensity, "balanced"))).toBe(true);

    const changedStrength = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "light", strengthIntensity: "vigorous" });
    expect(isProposalStale(original, buildAdjustmentProfileFingerprint(changedStrength, "balanced"))).toBe(true);

    const changedOverlap = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "light", cardioOverlapDaysPerWeek: 2 });
    expect(isProposalStale(original, buildAdjustmentProfileFingerprint(changedOverlap, "balanced"))).toBe(true);

    const changedIncludes = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "light", strengthAvgDurationMinIncludesCardio: true });
    expect(isProposalStale(original, buildAdjustmentProfileFingerprint(changedIncludes, "balanced"))).toBe(true);
  });

  it("stepsIncludeCardio e isHabitual son informativos: NO invalidan la propuesta", () => {
    const base = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "light" });
    const original = buildAdjustmentProfileFingerprint(base, "balanced");

    const changedSteps = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "light", stepsIncludeCardio: true });
    expect(isProposalStale(original, buildAdjustmentProfileFingerprint(changedSteps, "balanced"))).toBe(false);

    const changedHabit = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "light", isHabitual: false });
    expect(isProposalStale(original, buildAdjustmentProfileFingerprint(changedHabit, "balanced"))).toBe(false);
  });
});

describe("nutrition-v3.1 — perfiles legacy (5)", () => {
  it("5) un perfil legacy sin ningún campo nuevo produce un resultado válido y conservador (no revienta, no MET 7 fijo)", () => {
    const tmb = calcTMB(124, 177, 24, "male");
    const legacy = referenceObeseProfile(); // ningún campo v3.1 declarado
    const breakdown = calcTdeeBreakdown(legacy, tmb);
    expect(breakdown.totalTdeeKcal).toBeGreaterThan(0);
    expect(Number.isFinite(breakdown.totalTdeeKcal)).toBe(true);
    expect(breakdown.totalTdeeKcal).toBeLessThan(4015); // ya no MET 7 fijo

    const uncertainty = estimateTdeeUncertainty(legacy, breakdown);
    expect(uncertainty.confidence).toBe("low");
  });

  it("migrateLegacyTrainingActivity: dato v2 (un solo avgSessionDurationMin) migra sin campos v3.1, tratado como sin confirmar", () => {
    const migrated = migrateLegacyTrainingActivity({
      lifestyleActivity: "sedentary",
      strengthDaysPerWeek: 4,
      cardioDaysPerWeek: 3,
      avgSessionDurationMin: 45,
      habitualSteps: null,
    });
    expect(migrated.legacyDurationUnconfirmed).toBe(true);
    expect(migrated.cardioType).toBeUndefined();
    expect(migrated.cardioIntensity).toBeUndefined();
  });
});

describe("nutrition-v3.1 — P0: ninguna explicación afirma superávit en déficit (6)", () => {
  it("6) recomp (124kg, IMC≥30): el texto generado nunca dice 'superávit' cuando gym/rest/media están en déficit", () => {
    const profile = referenceObeseProfile({ cardioType: "run", cardioIntensity: "moderate" });
    const tmb = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
    const tdee = calcTDEE(profile, tmb);
    const gymTargets = calcDailyTargets(profile, true);
    const restTargets = calcDailyTargets(profile, false);

    // Con kcalFactor(recomp, *, imc>=30) el factor SIEMPRE es <1 — confirma
    // que el caso real cae en déficit ambos días, como reporta el usuario.
    expect(gymTargets.kcal).toBeLessThan(tdee);
    expect(restTargets.kcal).toBeLessThan(tdee);

    const text = explainCalorieCycle({
      gymDayKcal: gymTargets.kcal, restDayKcal: restTargets.kcal,
      gymDaysPerWeek: profile.gymDays.length, tdeeKcal: tdee,
    });
    expect(text.toLowerCase()).not.toContain("superávit");
    expect(text.toLowerCase()).toContain("déficit");
  });

  it("describeCalorieVsTdee: nunca clasifica como surplus un valor por debajo del TDEE", () => {
    expect(describeCalorieVsTdee(1800, 2400)).toBe("deficit");
    expect(describeCalorieVsTdee(2400, 2400)).toBe("near_maintenance");
    expect(describeCalorieVsTdee(2900, 2400)).toBe("surplus");
  });

  it("explainCalorieCycle: con superávit real en gym, SÍ lo dice (no oculta el caso contrario)", () => {
    const text = explainCalorieCycle({ gymDayKcal: 2900, restDayKcal: 2200, gymDaysPerWeek: 4, tdeeKcal: 2400 });
    expect(text.toLowerCase()).toContain("superávit");
  });
});

describe("nutrition-v3.1 — media semanal coherente (7)", () => {
  it("7) la media semanal mostrada coincide matemáticamente con los 7 días reales", () => {
    const profile = referenceObeseProfile({ cardioType: "bike", cardioIntensity: "moderate" });
    const cycle = weeklyCycle(profile);
    const weeklyTotal = cycle.reduce((sum, day) => sum + day.targets.kcal, 0);
    const weeklyAverage = Math.round(weeklyTotal / 7);

    const tmb = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
    const breakdown = calcTdeeBreakdown(profile, tmb);
    const explanation = buildCalorieBreakdownExplanation(breakdown, weeklyAverage);

    expect(explanation.weeklyAverageTargetKcal).toBe(weeklyAverage);
    // Invariante de suma: reposo + vida cotidiana + entreno + ajuste == media semanal
    expect(
      explanation.restingEnergyKcal + explanation.dailyLifeKcal + explanation.habitualTrainingKcal + explanation.goalAdjustmentKcal,
    ).toBe(explanation.weeklyAverageTargetKcal);
  });
});

describe("nutrition-v3.1 — caso 124kg: incertidumbre, nunca cifra exacta (8)", () => {
  it("8) el TDEE mostrado va acompañado de un rango y de confianza explicada, nunca como cifra exacta sola", () => {
    const profile = referenceObeseProfile(); // sin confirmar tipo/intensidad, como reportó el usuario
    const tmb = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
    const breakdown = calcTdeeBreakdown(profile, tmb);
    const uncertainty = estimateTdeeUncertainty(profile, breakdown);

    expect(uncertainty.midKcal).toBe(breakdown.totalTdeeKcal);
    expect(uncertainty.lowKcal).toBeLessThan(uncertainty.midKcal);
    expect(uncertainty.highKcal).toBeGreaterThan(uncertainty.midKcal);
    expect(uncertainty.confidence).not.toBe("high"); // nunca "high" en el estimador estático
    expect(uncertainty.confidence).toBe("low"); // sin tipo/intensidad confirmados
    expect(uncertainty.confidenceReason.length).toBeGreaterThan(0);
  });

  it("con todo confirmado, el techo de confianza sigue sin superar 'moderate' (IMC≥30)", () => {
    const profile = referenceObeseProfile({
      cardioType: "run", cardioIntensity: "moderate", strengthIntensity: "moderate", isHabitual: true,
    });
    const tmb = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
    const breakdown = calcTdeeBreakdown(profile, tmb);
    const uncertainty = estimateTdeeUncertainty(profile, breakdown);
    expect(uncertainty.confidence).toBe("moderate");
  });

  it("isHabitual=false NO reduce el kcal calculado — solo baja la confianza (nunca un descuento arbitrario)", () => {
    const habitual = referenceObeseProfile({ cardioType: "run", cardioIntensity: "moderate", isHabitual: true });
    const plan = referenceObeseProfile({ cardioType: "run", cardioIntensity: "moderate", isHabitual: false });
    const tmb = calcTMB(124, 177, 24, "male");
    expect(calcTDEE(plan, tmb)).toBe(calcTDEE(habitual, tmb));

    const breakdown = calcTdeeBreakdown(plan, tmb);
    expect(estimateTdeeUncertainty(plan, breakdown).confidence).toBe("low");
  });
});

describe("nutrition-v3.1 — motor adaptativo e invariantes previas siguen intactos (9)", () => {
  it("9) NUTRITION_ENGINE_VERSION sube a nutrition-v3.1 (cambia el resultado numérico del TDEE)", () => {
    expect(NUTRITION_ENGINE_VERSION).toBe("nutrition-v3.1");
  });

  it("calcAdaptiveTdee (7700) sigue siendo diagnóstico puro — evaluateAdaptiveState no lo recibe como input", () => {
    // Firma de evaluateAdaptiveState no acepta avgIntakeKcal/TDEE calculado
    // directamente (solo weeklyChangePercent vía weightTrend) — esta prueba
    // documenta la invariante ya cerrada de v3, que nutrition-v3.1 no debe
    // romper.
    const trend: WeightTrendResult = {
      latestWeightKg: 124, trendWeightKg: 124, slopeKgPerDay: -0.03,
      weeklyChangeKg: -0.5, weeklyChangePercent: -0.5,
      validMeasurements: 21, confidence: "high", qualityScore: 0.9,
    };
    const coverage: IntakeCoverageResult = { avgKcal: 2000, coverageFraction: 0.9, daysWithData: 19, windowDays: 21 };
    const result = evaluateAdaptiveState({
      goal: "fat_loss", currentTargetKcal: 2000, weightTrend: trend, intakeCoverage: coverage,
      lastAdjustmentDecisionAt: null, referenceDate: "2026-02-10",
    });
    expect(result).toBeDefined();
  });

  it("muscle_gain nunca en déficit — invariante v3 intacta con perfiles que usan los nuevos campos", () => {
    const profile = referenceObeseProfile({ cardioType: "walk", cardioIntensity: "light" });
    profile.goal = "muscle_gain";
    const tmb = calcTMB(profile.weightKg, profile.heightCm, profile.age, profile.sex);
    const tdee = calcTDEE(profile, tmb);
    const gymTargets = calcDailyTargets(profile, true);
    const restTargets = calcDailyTargets(profile, false);
    expect(gymTargets.kcal).toBeGreaterThanOrEqual(tdee);
    expect(restTargets.kcal).toBeGreaterThanOrEqual(tdee);
  });
});

describe("nutrition-v3.1 — round-trip de persistencia (extra_state)", () => {
  it("todos los campos nuevos de TrainingActivityProfile sobreviven un round-trip JSON (localStorage/Supabase JSONB) + migrateLegacyTrainingActivity", () => {
    const original: TrainingActivityProfile = {
      lifestyleActivity: "light",
      strengthDaysPerWeek: 4,
      cardioDaysPerWeek: 4,
      strengthAvgDurationMin: 70,
      cardioAvgDurationMin: 25,
      habitualSteps: 8000,
      cardioType: "row",
      cardioIntensity: "vigorous",
      strengthIntensity: "light",
      cardioOverlapDaysPerWeek: 2,
      strengthAvgDurationMinIncludesCardio: true,
      stepsIncludeCardio: true,
      isHabitual: false,
    };

    // Simula exactamente lo que le pasa al objeto al escribirlo en
    // localStorage (JSON.stringify) o en extra_state (columna jsonb de
    // Supabase, serializada/deserializada como JSON) y leerlo de vuelta con
    // el mismo mapper que usa data-layer.ts (migrateLegacyTrainingActivity).
    const roundTripped = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    const migrated = migrateLegacyTrainingActivity(roundTripped);

    expect(migrated).toEqual(original);
  });
});
