// Ejemplos reproducibles: cómo un "ajuste medio diario" se traduce a objetivos DIARIOS en v3.1 (calcDailyTargets)
// y en V4 (planWeeklyStrategy → planWeek → allocateDailyMacros), con ciclado, redondeo, preferencia de macros
// y suelo energético. Perfiles sintéticos; nada de datos reales. Escribe results/delta-translation.json.
import { describe, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { calcDailyTargets, calcSummary } from "../../../apps/web/src/lib/nutrition";
import { planWeeklyStrategy } from "../../../packages/engine/src/weekly-strategy-kernel";

const WEEK = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]; // lun..dom
const WEEKDAY = [1, 2, 3, 4, 5, 6, 0];
type Goal = "fat_loss" | "recomp" | "muscle_gain" | "maintain";
const PRIORITY: Record<Goal, string | null> = { fat_loss: "fat_loss_max", recomp: "balanced", muscle_gain: "muscle_gain_lean", maintain: null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const out: any[] = [];

function profile(goal: Goal, over: Record<string, unknown> = {}, offset = 0) {
  return {
    age: 32, sex: "male", heightCm: 178, weightKg: 80, bodyFatPct: null, activityLevel: "moderate", goal,
    gymDays: [1, 3, 5], allergies: [], excludedFoods: [], activityModelVersion: "legacy_total_pal",
    adaptiveKcalOffsetKcal: offset, ...over,
  } as never;
}

function compare(label: string, goal: Goal, over: Record<string, unknown>, pref: "balanced" | "higher_fat" | "higher_carbohydrate", delta: number) {
  const p0 = profile(goal, over, 0);
  const pD = profile(goal, over, delta);
  const gym = (p0 as { gymDays: number[] }).gymDays;
  const { tdee } = calcSummary(p0);
  const v31Before = WEEKDAY.map((wd) => calcDailyTargets(p0, gym.includes(wd), pref));
  const v31After = WEEKDAY.map((wd) => calcDailyTargets(pD, gym.includes(wd), pref));
  const days = WEEK.map((dateKey, i) => ({ dateKey, label: (gym.includes(WEEKDAY[i]) ? "strength" : "rest") as "strength" | "rest" }));
  const base = {
    weightKg: (p0 as { weightKg: number }).weightKg, heightCm: (p0 as { heightCm: number }).heightCm, tdeeKcal: tdee,
    age: (p0 as { age: number }).age, sex: (p0 as { sex: "male" | "female" }).sex, days,
    goal: PRIORITY[goal] === null ? { goalIntent: "maintain" as const } : { goalIntent: "priority_driven" as const, priority: PRIORITY[goal] as never },
  };
  const v4Before = planWeeklyStrategy({ ...base, currentAverageDailyEnergyAdjustmentKcal: 0 });
  const v4After = planWeeklyStrategy({ ...base, currentAverageDailyEnergyAdjustmentKcal: delta });
  const dayRows = (r: ReturnType<typeof planWeeklyStrategy>) =>
    r.status === "ok"
      ? r.weeklyPlan.days.map((d) => ({ kcal: d.distributedKcalTarget, protein: d.allocation.protein.assignedG, fat: d.allocation.fat.assignedG, carbs: d.allocation.carbs.assignedG }))
      : null;
  out.push({
    label, goal, macroPreference: pref, tdee, deltaKcalPerDay: delta, gymDays: gym,
    v31: {
      weeklyBefore: v31Before.reduce((s, t) => s + t.kcal, 0), weeklyAfter: v31After.reduce((s, t) => s + t.kcal, 0),
      perDayBefore: v31Before.map((t) => [t.kcal, t.protein, t.carbs, t.fat]), perDayAfter: v31After.map((t) => [t.kcal, t.protein, t.carbs, t.fat]),
      perDayKcalChange: v31After.map((t, i) => t.kcal - v31Before[i].kcal),
    },
    v4: {
      statusBefore: v4Before.status, statusAfter: v4After.status,
      weeklyBefore: v4Before.status === "ok" ? v4Before.weeklyPlan.energy.roundedWeeklyKcalTarget : null,
      weeklyAfter: v4After.status === "ok" ? v4After.weeklyPlan.energy.roundedWeeklyKcalTarget : null,
      perDayBefore: dayRows(v4Before)?.map((d) => [d.kcal, d.protein, d.carbs, d.fat]) ?? null,
      perDayAfter: dayRows(v4After)?.map((d) => [d.kcal, d.protein, d.carbs, d.fat]) ?? null,
      perDayKcalChange: dayRows(v4Before) && dayRows(v4After) ? dayRows(v4After)!.map((d, i) => d.kcal - dayRows(v4Before)![i].kcal) : null,
      safetyAfter: v4After.status === "ok" ? null : JSON.stringify("audit" in v4After ? v4After.audit : "reasons" in v4After ? v4After.reasons : null),
    },
  });
}

describe("traducción del ajuste medio a objetivos diarios", () => {
  it("genera los ejemplos", () => {
    compare("A. uniforme (fat_loss), −100", "fat_loss", {}, "balanced", -100);
    compare("B. ciclado (recomp, 3 días de gym), −100", "recomp", {}, "balanced", -100);
    compare("C. ciclado (recomp), +100", "recomp", {}, "balanced", 100);
    compare("D. preferencia de macros (fat_loss higher_fat), −100", "fat_loss", {}, "higher_fat", -100);
    compare("E. suelo energético (mujer 52 kg, sedentaria), −100", "fat_loss", { sex: "female", weightKg: 52, heightCm: 157, age: 40, activityLevel: "sedentary" }, "balanced", -100);
    compare("F. redondeo (muscle_gain), −100", "muscle_gain", {}, "balanced", -100);
    const dir = fileURLToPath(new URL("./results/", import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(dir + "delta-translation.json", JSON.stringify(out, null, 2));
  });
});
