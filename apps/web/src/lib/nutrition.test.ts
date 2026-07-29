import { describe, expect, it } from "vitest";
import type { PhysicalProfile, Recipe } from "@foodos/types";
import {
  calcDailyTargets,
  calcIMC,
  calcProteinBase,
  calcTDEE,
  calcTMB,
  calculateFiberTarget,
  distributeWeeklyCalories,
  estimateWorkoutKcal,
  evaluateNutritionSafety,
  monthlyAmountOf,
  projectSavings,
  scaleByCalories,
  scaleByRatio,
  usesEspenAdjustedWeight,
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
  it("aplica el factor de actividad correcto a cada nivel", () => {
    const tmb = 1500;
    expect(calcTDEE(tmb, "sedentary")).toBe(Math.round(tmb * 1.2));
    expect(calcTDEE(tmb, "light")).toBe(Math.round(tmb * 1.375));
    expect(calcTDEE(tmb, "moderate")).toBe(Math.round(tmb * 1.45));
    expect(calcTDEE(tmb, "active")).toBe(Math.round(tmb * 1.65));
    expect(calcTDEE(tmb, "very_active")).toBe(Math.round(tmb * 1.9));
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
