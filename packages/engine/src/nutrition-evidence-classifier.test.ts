import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type {
  ApplicabilityLevel,
  DataSufficiency,
  EvidenceSourceId,
  HelmsProteinEvidenceProfile,
  ProteinPolicy,
  Sex,
} from "@foodos/types";
import {
  assessDataSufficiency,
  buildProteinEvidenceNote,
  classifyHelmsProteinEvidence,
  classifyInterventionContextApplicability,
  classifyPopulationApplicability,
  combineApplicability,
  dedupeAndOrderReasons,
  deriveEvidenceConfidence,
  deriveProteinPolicy,
} from "./nutrition-evidence-classifier";

// ─── Fixtures — solo en código de test, nunca en un archivo exportable de
// producción (packages/engine/src/index.ts no las reexporta). ────────────

function profile(overrides: Partial<HelmsProteinEvidenceProfile> = {}): HelmsProteinEvidenceProfile {
  return {
    age: 30,
    sex: "male",
    heightCm: 177,
    weightKg: 80,
    bodyFatPct: null,
    energyRestrictionStatus: "unknown",
    strengthTrainingCurrentStatus: "unknown",
    strengthTrainingExperience: "unknown",
    ...overrides,
  };
}

function strengthTraining(strengthDaysPerWeek = 3) {
  return {
    lifestyleActivity: "sedentary" as const,
    strengthDaysPerWeek,
    cardioDaysPerWeek: 0,
    strengthAvgDurationMin: 60,
    cardioAvgDurationMin: 0,
  };
}

/** El caso REALMENTE alcanzable: composición corporal medida por DXA dentro
    del criterio, sexo y edad adulta confirmados, entrenamiento de fuerza
    CONFIRMADO como actual (no solo planificado), más de 6 meses de
    experiencia confirmados, y restricción energética confirmada como
    activa. Debe producir matched + matched + sufficient + moderate +
    evidence_supported, con reasons=[]. `trainingActivity` se incluye aquí
    solo como dato COMPLEMENTARIO (4 días/semana planificados) — lo que
    hace que el eje de intervención sea "matched" es
    `strengthTrainingCurrentStatus: "confirmed_current"`, nunca el plan
    semanal en sí (ver classifyInterventionContextApplicability). */
const FULLY_MATCHED_REACHABLE: HelmsProteinEvidenceProfile = profile({
  bodyFatPct: 15,
  bodyFatSource: "dxa",
  trainingActivity: strengthTraining(4),
  energyRestrictionStatus: "confirmed_current",
  strengthTrainingCurrentStatus: "confirmed_current",
  strengthTrainingExperience: "confirmed_over_six_months",
});

describe("caso completamente coincidente y alcanzable (Corrección de revisión #1)", () => {
  it("FULLY_MATCHED_REACHABLE -> matched + matched + sufficient + moderate + evidence_supported, reasons=[]", () => {
    const result = classifyHelmsProteinEvidence(FULLY_MATCHED_REACHABLE);
    expect(result.populationApplicability).toBe("matched");
    expect(result.interventionContextApplicability).toBe("matched");
    expect(result.dataSufficiency).toBe("sufficient");
    expect(result.reasons).toEqual([]);
    expect(result.evidenceConfidence).toBe("moderate");
    const combined = combineApplicability({ population: result.populationApplicability, interventionContext: result.interventionContextApplicability });
    expect(deriveProteinPolicy(combined, result.dataSufficiency)).toBe("evidence_supported");
  });

  it("buildProteinEvidenceNote para evidence_supported no insinúa validación individual", () => {
    const result = classifyHelmsProteinEvidence(FULLY_MATCHED_REACHABLE);
    const note = buildProteinEvidenceNote(result, "evidence_supported");
    expect(note).not.toMatch(/validad[oa] para ti/i);
    expect(note.length).toBeGreaterThan(0);
  });
});

describe("restricción energética — señal explícita, nunca inferida de goal (Corrección de revisión #1)", () => {
  const RESTRICTION_PLANNED: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, energyRestrictionStatus: "explicitly_planned" };
  const RESTRICTION_ABSENT: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, energyRestrictionStatus: "not_restricted" };
  const RESTRICTION_UNKNOWN: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, energyRestrictionStatus: "unknown" };

  it("confirmed_current no añade ningún motivo (ya cubierto por FULLY_MATCHED_REACHABLE)", () => {
    expect(classifyHelmsProteinEvidence(FULLY_MATCHED_REACHABLE).reasons).toEqual([]);
  });

  it("explicitly_planned -> 'energy_restriction_planned_not_active', contexto 'partially_matched' (nunca completo)", () => {
    const result = classifyHelmsProteinEvidence(RESTRICTION_PLANNED);
    expect(result.reasons).toEqual(["energy_restriction_planned_not_active"]);
    expect(result.interventionContextApplicability).toBe("partially_matched");
    expect(result.populationApplicability).toBe("matched"); // no contamina el otro eje
  });

  it("not_restricted -> 'energy_restriction_absent', discrepancia real -> contexto 'mismatched'", () => {
    const result = classifyHelmsProteinEvidence(RESTRICTION_ABSENT);
    expect(result.reasons).toEqual(["energy_restriction_absent"]);
    expect(result.interventionContextApplicability).toBe("mismatched");
  });

  it("unknown -> 'energy_restriction_unknown', impide coincidencia completa -> contexto 'unknown'", () => {
    const result = classifyHelmsProteinEvidence(RESTRICTION_UNKNOWN);
    expect(result.reasons).toEqual(["energy_restriction_unknown"]);
    expect(result.interventionContextApplicability).toBe("unknown");
  });

  it("un 'goal' adicional (bystander, ajeno al tipo) no cambia el resultado — ya no existe ninguna inferencia desde goal", () => {
    // HelmsProteinEvidenceProfile ya no tiene el campo `goal`: esto es hoy una
    // garantía en tiempo de COMPILACIÓN, más fuerte que un test en runtime.
    // Este test demuestra además que, aunque alguien cuele un campo extra
    // `goal` en el objeto (p. ej. reutilizando un PhysicalProfile completo),
    // el clasificador lo ignora por completo.
    const withBystanderGoal = { ...RESTRICTION_UNKNOWN, goal: "fat_loss" } as unknown as HelmsProteinEvidenceProfile;
    const withDifferentBystanderGoal = { ...RESTRICTION_UNKNOWN, goal: "maintain" } as unknown as HelmsProteinEvidenceProfile;
    expect(classifyHelmsProteinEvidence(withBystanderGoal)).toEqual(classifyHelmsProteinEvidence(RESTRICTION_UNKNOWN));
    expect(classifyHelmsProteinEvidence(withBystanderGoal)).toEqual(classifyHelmsProteinEvidence(withDifferentBystanderGoal));
  });

  it("'goal=fat_loss' (bystander) sin restricción explícita NUNCA confirma el contexto", () => {
    const fatLossGoalButNoRestriction = { ...RESTRICTION_UNKNOWN, goal: "fat_loss" } as unknown as HelmsProteinEvidenceProfile;
    expect(classifyHelmsProteinEvidence(fatLossGoalButNoRestriction).interventionContextApplicability).not.toBe("matched");
  });
});

describe("experiencia de entrenamiento — meses confirmados, nunca ExperienceLevel (Corrección de revisión #3)", () => {
  const EXPERIENCE_UNDER_SIX_MONTHS: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, strengthTrainingExperience: "under_six_months" };
  const EXPERIENCE_UNKNOWN: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, strengthTrainingExperience: "unknown" };

  it("confirmed_over_six_months no añade motivo (ya cubierto por FULLY_MATCHED_REACHABLE)", () => {
    expect(classifyHelmsProteinEvidence(FULLY_MATCHED_REACHABLE).reasons).toEqual([]);
  });

  it("under_six_months -> 'training_experience_insufficient', discrepancia confirmada -> contexto 'mismatched'", () => {
    const result = classifyHelmsProteinEvidence(EXPERIENCE_UNDER_SIX_MONTHS);
    expect(result.reasons).toEqual(["training_experience_insufficient"]);
    expect(result.interventionContextApplicability).toBe("mismatched");
  });

  it("unknown -> 'training_experience_unknown', contexto 'unknown'", () => {
    const result = classifyHelmsProteinEvidence(EXPERIENCE_UNKNOWN);
    expect(result.reasons).toEqual(["training_experience_unknown"]);
    expect(result.interventionContextApplicability).toBe("unknown");
  });
});

describe("entrenamiento de fuerza actual — señal explícita, nunca inferida de trainingActivity (Corrección de revisión #2)", () => {
  const CURRENT_CONFIRMED: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, strengthTrainingCurrentStatus: "confirmed_current" };
  const CURRENT_PLANNED_ONLY: HelmsProteinEvidenceProfile = {
    ...FULLY_MATCHED_REACHABLE,
    trainingActivity: strengthTraining(4), // plan de 4 días/semana — NUNCA confirma por sí solo
    strengthTrainingCurrentStatus: "explicitly_planned",
  };
  const NOT_TRAINING: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, strengthTrainingCurrentStatus: "not_training" };
  const CURRENT_UNKNOWN: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, strengthTrainingCurrentStatus: "unknown" };

  it("confirmed_current no añade motivo (ya cubierto por FULLY_MATCHED_REACHABLE)", () => {
    expect(classifyHelmsProteinEvidence(CURRENT_CONFIRMED).reasons).toEqual([]);
  });

  it("un plan de 4 días/semana SIN confirmación actual solo produce coincidencia PARCIAL, nunca completa", () => {
    const result = classifyHelmsProteinEvidence(CURRENT_PLANNED_ONLY);
    expect(result.reasons).toEqual(["strength_training_planned_not_confirmed"]);
    expect(result.interventionContextApplicability).toBe("partially_matched");
    expect(result.interventionContextApplicability).not.toBe("matched");
  });

  it("not_training -> 'not_currently_strength_training', discrepancia confirmada -> contexto 'mismatched'", () => {
    const result = classifyHelmsProteinEvidence(NOT_TRAINING);
    expect(result.reasons).toEqual(["not_currently_strength_training"]);
    expect(result.interventionContextApplicability).toBe("mismatched");
  });

  it("unknown -> 'strength_training_status_unknown', contexto 'unknown'", () => {
    const result = classifyHelmsProteinEvidence(CURRENT_UNKNOWN);
    expect(result.reasons).toEqual(["strength_training_status_unknown"]);
    expect(result.interventionContextApplicability).toBe("unknown");
  });

  it("un plan semanal completo (trainingActivity) sin strengthTrainingCurrentStatus confirmado NUNCA basta por sí solo", () => {
    // Mismo perfil salvo por trainingActivity: con o sin el plan declarado,
    // el resultado es idéntico mientras strengthTrainingCurrentStatus sea
    // "unknown" — la planificación es puramente informativa.
    const withPlan: HelmsProteinEvidenceProfile = { ...CURRENT_UNKNOWN, trainingActivity: strengthTraining(5) };
    const withoutPlan: HelmsProteinEvidenceProfile = { ...CURRENT_UNKNOWN, trainingActivity: undefined };
    expect(classifyHelmsProteinEvidence(withPlan)).toEqual(classifyHelmsProteinEvidence(withoutPlan));
  });
});

describe("experiencia y estado actual se evalúan de forma independiente (Corrección de revisión #2)", () => {
  it("experiencia desconocida + entrenamiento actual confirmado -> solo el motivo de experiencia aparece", () => {
    const p: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, strengthTrainingExperience: "unknown", strengthTrainingCurrentStatus: "confirmed_current" };
    const result = classifyHelmsProteinEvidence(p);
    expect(result.reasons).toEqual(["training_experience_unknown"]);
  });

  it("experiencia confirmada + entrenamiento actual desconocido -> solo el motivo de entrenamiento actual aparece", () => {
    const p: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, strengthTrainingExperience: "confirmed_over_six_months", strengthTrainingCurrentStatus: "unknown" };
    const result = classifyHelmsProteinEvidence(p);
    expect(result.reasons).toEqual(["strength_training_status_unknown"]);
  });

  it("under_six_months (experiencia) + not_training (actual) -> ambos motivos, cada uno atribuido a su propia señal", () => {
    const p: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, strengthTrainingExperience: "under_six_months", strengthTrainingCurrentStatus: "not_training" };
    const result = classifyHelmsProteinEvidence(p);
    expect(result.reasons).toEqual(["not_currently_strength_training", "training_experience_insufficient"]);
  });
});

describe("no mezclar población e intervención silenciosamente (Corrección de revisión #2 y #6)", () => {
  it("IMC alto (35.9) + %grasa medido bajo (15%, DXA) -> población 'matched' LIMPIA, sin razón de IMC; el downgrade (si lo hay) es atribuible solo al eje de intervención", () => {
    const profileWithUnknownExperience: HelmsProteinEvidenceProfile = {
      ...FULLY_MATCHED_REACHABLE,
      weightKg: 110,
      heightCm: 175, // IMC = 110/1.75^2 ≈ 35.9
      bodyFatPct: 15,
      bodyFatSource: "dxa",
      strengthTrainingExperience: "unknown", // única variable deliberadamente incompleta
    };
    const result = classifyHelmsProteinEvidence(profileWithUnknownExperience);

    // La medición manda: población queda perfectamente limpia.
    expect(result.populationApplicability).toBe("matched");
    expect(result.reasons).not.toContain("bmi_obesity_range_without_body_fat_measurement");
    expect(result.reasons).not.toContain("body_composition_outside_studied_population");

    // El único motivo de todo el resultado es de intervención, no de IMC.
    expect(result.reasons).toEqual(["training_experience_unknown"]);
    expect(result.interventionContextApplicability).toBe("unknown");

    // El downgrade del combinado es 100% atribuible al eje de intervención.
    const combined = combineApplicability({ population: result.populationApplicability, interventionContext: result.interventionContextApplicability });
    expect(combined).toBe("unknown");
    expect(combined).not.toBe(result.populationApplicability); // demuestra que el combinado != población por sí sola
  });

  it("la razón de IMC SOLO aparece cuando no existe ninguna medición utilizable", () => {
    const withMeasurement = classifyPopulationApplicability({ ...FULLY_MATCHED_REACHABLE, weightKg: 124, heightCm: 177, bodyFatPct: 35 });
    expect(withMeasurement.reasons).not.toContain("bmi_obesity_range_without_body_fat_measurement");
    const withoutMeasurement = classifyPopulationApplicability({ ...FULLY_MATCHED_REACHABLE, weightKg: 124, heightCm: 177, bodyFatPct: null });
    expect(withoutMeasurement.reasons).toContain("bmi_obesity_range_without_body_fat_measurement");
  });
});

describe("composición corporal — medición manda sobre proxy de IMC (Corrección de revisión #2)", () => {
  const OBESITY_BMI_PROXY_NO_MEASUREMENT: HelmsProteinEvidenceProfile = {
    ...FULLY_MATCHED_REACHABLE,
    weightKg: 124,
    heightCm: 177,
    bodyFatPct: null,
    bodyFatSource: undefined,
  };
  const MISMATCHED_MEASURED_35_MALE: HelmsProteinEvidenceProfile = {
    ...FULLY_MATCHED_REACHABLE,
    weightKg: 124,
    heightCm: 177,
    bodyFatPct: 35,
  };

  it("IMC>=30 SIN %grasa medido nunca produce 'mismatched' por sí solo, y el eje de intervención queda intacto (matched)", () => {
    const result = classifyHelmsProteinEvidence(OBESITY_BMI_PROXY_NO_MEASUREMENT);
    expect(result.populationApplicability).not.toBe("mismatched");
    // Sexo y edad sí coinciden (solo la composición corporal es desconocida),
    // así que el eje de población queda en "partially_matched", no en el
    // "unknown" más severo — ver classifyPopulationApplicability.
    expect(result.populationApplicability).toBe("partially_matched");
    expect(result.interventionContextApplicability).toBe("matched"); // sin contaminación cruzada
    expect(result.reasons).toEqual(["body_composition_unknown", "bmi_obesity_range_without_body_fat_measurement", "reliable_ffm_missing"]);
  });

  it("%grasa medido por encima del corte SÍ produce 'mismatched' (35% en hombre)", () => {
    const result = classifyHelmsProteinEvidence(MISMATCHED_MEASURED_35_MALE);
    expect(result.populationApplicability).toBe("mismatched");
    expect(result.reasons).toContain("body_composition_outside_studied_population");
  });

  it("sexo invalido (string ajeno a la unión, defensivo más allá del propio tipo) nunca usa silenciosamente el corte de otro grupo", () => {
    const unknownSex = { ...FULLY_MATCHED_REACHABLE, sex: "unspecified" as unknown as Sex };
    const result = classifyHelmsProteinEvidence(unknownSex);
    expect(result.reasons).toContain("sex_unknown");
    expect(result.populationApplicability).not.toBe("matched");
  });

  it("sexo ausente (null) — representable sin cast — tampoco usa el corte de ningún grupo", () => {
    const nullSex: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, sex: null };
    const result = classifyHelmsProteinEvidence(nullSex);
    expect(result.reasons).toContain("sex_unknown");
    expect(result.populationApplicability).not.toBe("matched");
  });
});

describe("suficiencia de la medición corporal — matriz conservadora, 'sufficient' = suficiente para ESTE clasificador (Corrección de revisión #3 y #7)", () => {
  it("dxa es 'sufficient'", () => {
    expect(assessDataSufficiency({ bodyFatPct: 20, bodyFatSource: "dxa" }).dataSufficiency).toBe("sufficient");
  });
  it("bascula domestica (smart_scale) NO se equipara a una medicion fiable -> 'partial', no 'sufficient'", () => {
    expect(assessDataSufficiency({ bodyFatPct: 20, bodyFatSource: "smart_scale" }).dataSufficiency).toBe("partial");
  });
  it("bioimpedancia profesional -> 'partial'", () => {
    expect(assessDataSufficiency({ bodyFatPct: 20, bodyFatSource: "bia_professional" }).dataSufficiency).toBe("partial");
  });
  it("plicometro (skinfold) -> 'partial'", () => {
    expect(assessDataSufficiency({ bodyFatPct: 20, bodyFatSource: "skinfold" }).dataSufficiency).toBe("partial");
  });
  it("estimacion visual -> 'insufficient'", () => {
    expect(assessDataSufficiency({ bodyFatPct: 20, bodyFatSource: "visual_estimate" }).dataSufficiency).toBe("insufficient");
  });
  it("porcentaje valido SIN ningun metodo declarado (ausencia de metodo) -> 'partial', nunca 'sufficient'", () => {
    expect(assessDataSufficiency({ bodyFatPct: 20, bodyFatSource: undefined }).dataSufficiency).toBe("partial");
    expect(assessDataSufficiency({ bodyFatPct: 20, bodyFatSource: null }).dataSufficiency).toBe("partial");
  });
  it("una poblacion coincidente con dato de bascula domestica no llega a evidence_supported", () => {
    const smartScale: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, bodyFatSource: "smart_scale" };
    const result = classifyHelmsProteinEvidence(smartScale);
    expect(result.dataSufficiency).toBe("partial");
    const combined = combineApplicability({ population: result.populationApplicability, interventionContext: result.interventionContextApplicability });
    expect(deriveProteinPolicy(combined, result.dataSufficiency)).not.toBe("evidence_supported");
  });
});

describe("validacion endurecida — dominio matematico abierto (0,100)", () => {
  const invalidValues = [0, 100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -5, 137];
  for (const value of invalidValues) {
    it(`bodyFatPct=${value} degrada a dato insuficiente, nunca lanza`, () => {
      const p = { ...FULLY_MATCHED_REACHABLE, bodyFatPct: value };
      expect(() => classifyHelmsProteinEvidence(p)).not.toThrow();
      expect(classifyHelmsProteinEvidence(p).dataSufficiency).toBe("insufficient");
    });
  }
  it("0% y 100% se rechazan por invalidez matematica, no por ningun limite clinico adicional", () => {
    expect(assessDataSufficiency({ bodyFatPct: 0, bodyFatSource: "dxa" }).dataSufficiency).toBe("insufficient");
    expect(assessDataSufficiency({ bodyFatPct: 100, bodyFatSource: "dxa" }).dataSufficiency).toBe("insufficient");
  });
});

describe("edad", () => {
  it("adulto confirmado (30 anios) no anade motivo de edad", () => {
    expect(classifyHelmsProteinEvidence(FULLY_MATCHED_REACHABLE).reasons).not.toContain("age_unknown_or_minor");
  });
  it("menor de edad (16) siempre anade 'age_unknown_or_minor' y nunca permite 'matched'", () => {
    const minor = { ...FULLY_MATCHED_REACHABLE, age: 16 };
    const result = classifyHelmsProteinEvidence(minor);
    expect(result.reasons).toContain("age_unknown_or_minor");
    expect(result.populationApplicability).not.toBe("matched");
    expect(result.populationApplicability).toBe("partially_matched"); // composición sigue coincidiendo, solo la edad falla
  });
  it("edad invalida (NaN) se trata igual que un menor", () => {
    const missingAge = { ...FULLY_MATCHED_REACHABLE, age: Number.NaN };
    expect(classifyHelmsProteinEvidence(missingAge).reasons).toContain("age_unknown_or_minor");
  });
  it("edad ausente (null) — representable sin cast — se trata igual que un menor", () => {
    const nullAge: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, age: null };
    expect(classifyHelmsProteinEvidence(nullAge).reasons).toContain("age_unknown_or_minor");
  });
});

describe("determinismo", () => {
  it("misma entrada -> misma salida, profundamente identica", () => {
    const p: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, bodyFatPct: null, bodyFatSource: undefined, weightKg: 124, heightCm: 177 };
    const a = classifyHelmsProteinEvidence(p);
    const b = classifyHelmsProteinEvidence({ ...p });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("reasons[] — multiples motivos, sin duplicados, orden estable", () => {
  it("dedupeAndOrderReasons elimina duplicados reales", () => {
    expect(
      dedupeAndOrderReasons(["energy_restriction_absent", "age_unknown_or_minor", "energy_restriction_absent"]),
    ).toEqual(["age_unknown_or_minor", "energy_restriction_absent"]);
  });

  it("un caso con motivos de los tres ejes mantiene el mismo orden en 20 llamadas repetidas", () => {
    const messy: HelmsProteinEvidenceProfile = {
      age: 16, // población: age_unknown_or_minor
      sex: "male",
      heightCm: 177,
      weightKg: 124, // IMC alto
      bodyFatPct: null, // población: body_composition_unknown + bmi proxy
      bodyFatSource: undefined,
      strengthTrainingCurrentStatus: "unknown", // intervención: strength_training_status_unknown
      strengthTrainingExperience: "under_six_months", // intervención: training_experience_insufficient
      energyRestrictionStatus: "not_restricted", // intervención: energy_restriction_absent
    };
    const expected = [
      "body_composition_unknown",
      "bmi_obesity_range_without_body_fat_measurement",
      "age_unknown_or_minor",
      "reliable_ffm_missing",
      "strength_training_status_unknown",
      "training_experience_insufficient",
      "energy_restriction_absent",
    ];
    for (let i = 0; i < 20; i++) {
      expect(classifyHelmsProteinEvidence(messy).reasons).toEqual(expected);
    }
  });
});

describe("ortogonalidad — población coincide, dato no fiable", () => {
  it("matched + insufficient -> unresolved (la población coincidente NO compensa el dato)", () => {
    const p: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, bodyFatSource: "visual_estimate" };
    const result = classifyHelmsProteinEvidence(p);
    expect(result.dataSufficiency).toBe("insufficient");
    const combined = combineApplicability({ population: result.populationApplicability, interventionContext: result.interventionContextApplicability });
    expect(deriveProteinPolicy(combined, result.dataSufficiency)).toBe("unresolved");
  });
});

describe("ninguna rama pública queda inalcanzable — los 4 niveles de cada eje son demostrables (Corrección de revisión #8)", () => {
  it("PopulationApplicability: los 4 niveles son alcanzables", () => {
    expect(classifyPopulationApplicability(FULLY_MATCHED_REACHABLE).populationApplicability).toBe("matched");
    expect(classifyPopulationApplicability({ ...FULLY_MATCHED_REACHABLE, age: 16 }).populationApplicability).toBe("partially_matched");
    expect(classifyPopulationApplicability({ ...FULLY_MATCHED_REACHABLE, weightKg: 124, heightCm: 177, bodyFatPct: 35 }).populationApplicability).toBe("mismatched");
    expect(
      classifyPopulationApplicability({ ...FULLY_MATCHED_REACHABLE, bodyFatPct: null, age: Number.NaN }).populationApplicability,
    ).toBe("unknown");
  });

  it("InterventionContextApplicability: los 4 niveles son alcanzables vía restricción energética", () => {
    expect(classifyInterventionContextApplicability(FULLY_MATCHED_REACHABLE).interventionContextApplicability).toBe("matched");
    expect(
      classifyInterventionContextApplicability({ ...FULLY_MATCHED_REACHABLE, energyRestrictionStatus: "explicitly_planned" }).interventionContextApplicability,
    ).toBe("partially_matched");
    expect(
      classifyInterventionContextApplicability({ ...FULLY_MATCHED_REACHABLE, energyRestrictionStatus: "not_restricted" }).interventionContextApplicability,
    ).toBe("mismatched");
    expect(
      classifyInterventionContextApplicability({ ...FULLY_MATCHED_REACHABLE, energyRestrictionStatus: "unknown" }).interventionContextApplicability,
    ).toBe("unknown");
  });

  it("InterventionContextApplicability: los 4 niveles son alcanzables vía entrenamiento actual", () => {
    expect(
      classifyInterventionContextApplicability({ ...FULLY_MATCHED_REACHABLE, strengthTrainingCurrentStatus: "confirmed_current" }).interventionContextApplicability,
    ).toBe("matched");
    expect(
      classifyInterventionContextApplicability({ ...FULLY_MATCHED_REACHABLE, strengthTrainingCurrentStatus: "explicitly_planned" }).interventionContextApplicability,
    ).toBe("partially_matched");
    expect(
      classifyInterventionContextApplicability({ ...FULLY_MATCHED_REACHABLE, strengthTrainingCurrentStatus: "not_training" }).interventionContextApplicability,
    ).toBe("mismatched");
    expect(
      classifyInterventionContextApplicability({ ...FULLY_MATCHED_REACHABLE, strengthTrainingCurrentStatus: "unknown" }).interventionContextApplicability,
    ).toBe("unknown");
  });
});

describe("combineApplicability — tabla de verdad completa (16 combinaciones)", () => {
  const levels: ApplicabilityLevel[] = ["matched", "partially_matched", "unknown", "mismatched"];
  const expected: Record<string, ApplicabilityLevel> = {
    "matched|matched": "matched",
    "matched|partially_matched": "partially_matched",
    "matched|unknown": "unknown",
    "matched|mismatched": "mismatched",
    "partially_matched|matched": "partially_matched",
    "partially_matched|partially_matched": "partially_matched",
    "partially_matched|unknown": "unknown",
    "partially_matched|mismatched": "mismatched",
    "unknown|matched": "unknown",
    "unknown|partially_matched": "unknown",
    "unknown|unknown": "unknown",
    "unknown|mismatched": "mismatched",
    "mismatched|matched": "mismatched",
    "mismatched|partially_matched": "mismatched",
    "mismatched|unknown": "mismatched",
    "mismatched|mismatched": "mismatched",
  };
  it("coincide para las 16 combinaciones, y nunca lanza", () => {
    for (const a of levels) {
      for (const b of levels) {
        expect(() => combineApplicability({ population: a, interventionContext: b })).not.toThrow();
        expect(combineApplicability({ population: a, interventionContext: b })).toBe(expected[`${a}|${b}`]);
      }
    }
  });
});

describe("exhaustividad de las uniones discriminadas", () => {
  const allApplicability: ApplicabilityLevel[] = ["matched", "partially_matched", "mismatched", "unknown"];
  const allData: DataSufficiency[] = ["sufficient", "partial", "insufficient"];

  it("las 12 combinaciones de (applicability combinado, dataSufficiency) no lanzan", () => {
    for (const level of allApplicability) {
      for (const data of allData) {
        expect(() => deriveEvidenceConfidence(level, data)).not.toThrow();
        expect(() => deriveProteinPolicy(level, data)).not.toThrow();
      }
    }
  });

  it("tabla de verdad completa (applicability combinado x dataSufficiency)", () => {
    const expected: Record<string, { confidence: "moderate" | "low"; policy: ProteinPolicy }> = {
      "matched|sufficient": { confidence: "moderate", policy: "evidence_supported" },
      "matched|partial": { confidence: "low", policy: "provisional" },
      "matched|insufficient": { confidence: "low", policy: "unresolved" },
      "partially_matched|sufficient": { confidence: "low", policy: "provisional" },
      "partially_matched|partial": { confidence: "low", policy: "provisional" },
      "partially_matched|insufficient": { confidence: "low", policy: "unresolved" },
      "mismatched|sufficient": { confidence: "low", policy: "provisional" },
      "mismatched|partial": { confidence: "low", policy: "provisional" },
      "mismatched|insufficient": { confidence: "low", policy: "unresolved" },
      "unknown|sufficient": { confidence: "low", policy: "provisional" },
      "unknown|partial": { confidence: "low", policy: "provisional" },
      "unknown|insufficient": { confidence: "low", policy: "unresolved" },
    };
    for (const level of allApplicability) {
      for (const data of allData) {
        const key = `${level}|${data}`;
        expect(deriveEvidenceConfidence(level, data)).toBe(expected[key].confidence);
        expect(deriveProteinPolicy(level, data)).toBe(expected[key].policy);
      }
    }
  });

  it("EnergyRestrictionStatus x StrengthTrainingCurrentStatus x StrengthTrainingExperience — ninguna combinación lanza (48 combinaciones)", () => {
    const restrictionStates = ["confirmed_current", "explicitly_planned", "not_restricted", "unknown"] as const;
    const currentStates = ["confirmed_current", "explicitly_planned", "not_training", "unknown"] as const;
    const experienceStates = ["confirmed_over_six_months", "under_six_months", "unknown"] as const;
    for (const restriction of restrictionStates) {
      for (const current of currentStates) {
        for (const experience of experienceStates) {
          const p: HelmsProteinEvidenceProfile = {
            ...FULLY_MATCHED_REACHABLE,
            energyRestrictionStatus: restriction,
            strengthTrainingCurrentStatus: current,
            strengthTrainingExperience: experience,
          };
          expect(() => classifyHelmsProteinEvidence(p)).not.toThrow();
        }
      }
    }
  });
});

describe("buildProteinEvidenceNote", () => {
  it("los tres textos son distintos entre si", () => {
    const assessment = classifyHelmsProteinEvidence(FULLY_MATCHED_REACHABLE);
    const supported = buildProteinEvidenceNote(assessment, "evidence_supported");
    const provisional = buildProteinEvidenceNote(assessment, "provisional");
    const unresolved = buildProteinEvidenceNote(assessment, "unresolved");
    expect(new Set([supported, provisional, unresolved]).size).toBe(3);
  });
});

describe("ausencia de datos representable sin casts (Corrección de revisión #1)", () => {
  it("un perfil con age, sex, heightCm y weightKg nulos se construye SIN 'as unknown as' — lo verifica el propio 'satisfies' en tiempo de compilación", () => {
    const allAbsent = {
      age: null,
      sex: null,
      heightCm: null,
      weightKg: null,
      bodyFatPct: null,
      energyRestrictionStatus: "unknown",
      strengthTrainingCurrentStatus: "unknown",
      strengthTrainingExperience: "unknown",
    } satisfies HelmsProteinEvidenceProfile;

    expect(() => classifyHelmsProteinEvidence(allAbsent)).not.toThrow();
    const result = classifyHelmsProteinEvidence(allAbsent);
    expect(result.populationApplicability).not.toBe("matched");
    expect(result.populationApplicability).not.toBe("mismatched"); // sin medición ni proxy de IMC (peso/altura también ausentes) -> "unknown", nunca un falso "mismatched"
    expect(result.reasons).toContain("age_unknown_or_minor");
    // sexo ausente sin % de grasa medido: evaluateBodyComposition nunca
    // llega a mirar el sexo (solo lo hace cuando hay un % de grasa
    // utilizable) — "sex_unknown" se prueba por separado más abajo con un
    // perfil que SÍ tiene una medición válida.
    expect(result.reasons).toContain("body_composition_unknown");
    expect(result.dataSufficiency).toBe("insufficient");
  });

  it("weightKg/heightCm nulos por separado (edad y sexo sí conocidos) degradan el IMC a 'no calculable', nunca a un valor inventado", () => {
    const noBodyMetrics: HelmsProteinEvidenceProfile = { ...FULLY_MATCHED_REACHABLE, bodyFatPct: null, bodyFatSource: undefined, weightKg: null, heightCm: null };
    const result = classifyHelmsProteinEvidence(noBodyMetrics);
    expect(result.reasons).not.toContain("bmi_obesity_range_without_body_fat_measurement");
    expect(result.reasons).toContain("body_composition_unknown");
  });
});

describe("appliedSource — identificador cerrado, nunca un string libre (Corrección de revisión #3)", () => {
  it("classifyHelmsProteinEvidence siempre devuelve 'helms_2014'", () => {
    expect(classifyHelmsProteinEvidence(FULLY_MATCHED_REACHABLE).appliedSource).toBe("helms_2014");
  });

  it("un string libre no es un EvidenceSourceId válido — lo verifica tsc, no este runtime", () => {
    // @ts-expect-error "otro estudio" no pertenece a la unión cerrada EvidenceSourceId.
    // Si en el futuro esa unión se ampliara sin querer a `string`, esta línea
    // dejaría de dar error y `tsc --noEmit` fallaría aquí con
    // "Unused '@ts-expect-error' directive", delatando la regresión.
    const invalidSource: EvidenceSourceId = "otro estudio";
    expect(typeof invalidSource).toBe("string");
  });
});

describe("combineApplicability — API con propiedades nombradas (Corrección de revisión #4)", () => {
  it("acepta un objeto { population, interventionContext }, nunca dos argumentos posicionales", () => {
    expect(combineApplicability({ population: "matched", interventionContext: "mismatched" })).toBe("mismatched");
    expect(combineApplicability({ population: "mismatched", interventionContext: "matched" })).toBe("mismatched");
  });
});

describe("confirmacion estructural — apps/web no llega a @foodos/engine (Corrección de revisión #5)", () => {
  // ALCANCE EXACTO de este test — ni más ni menos de lo siguiente:
  // 1. apps/web/package.json: ninguna entrada de dependencies/devDependencies
  //    llamada "@foodos/engine".
  // 2. apps/web/tsconfig.json: el bloque "paths" no mapea ningún alias hacia
  //    "@foodos/engine" ni hacia una ruta que contenga "packages/engine";
  //    también se busca el texto "packages/engine" en todo el archivo por si
  //    apareciera fuera de "paths".
  // 3. No existe tsconfig raíz ni tsconfig base compartido en este repo hoy
  //    (se comprueba su ausencia explícitamente) — si en el futuro aparece
  //    uno, este test empieza a fallar por "no encontrado" en vez de dar un
  //    falso verde silencioso, así que hará falta añadirlo aquí explícitamente.
  // 4. next.config.mjs: no contiene "@foodos/engine" ni "packages/engine" en
  //    ningún punto del archivo (cubre tanto transpilePackages como
  //    cualquier alias dentro de una función webpack()/turbopack, en la
  //    medida en que ese texto aparezca literalmente en el archivo).
  // 5. Todo archivo fuente (.ts/.tsx/.js/.jsx/.mjs/.cjs) bajo apps/web/src:
  //    se busca "@foodos/engine" (nombre de paquete) y "packages/engine"
  //    (ruta relativa) como subcadenas de texto — cubre imports estáticos,
  //    `import()` dinámico, `require()`, y cualquier alias cuyo destino
  //    real se escriba con una de esas dos cadenas, sin necesitar parsear
  //    cada sintaxis por separado.
  //
  // LÍMITES EXPLÍCITOS — lo que este test NO demuestra:
  // - No ejecuta el resolutor de módulos real de Node/TypeScript/Next ni
  //   simula webpack/Turbopack: un plugin de resolución suficientemente
  //   indirecto (que construya el nombre del paquete dinámicamente, lo lea
  //   de una variable de entorno, o lo resuelva vía un paquete de terceros)
  //   podría escapar a esta búsqueda por texto.
  // - No analiza configuraciones fuera de esta lista (p. ej. un babel.config
  //   o un .swcrc, que este repo no tiene hoy).
  // - Es una fotografía del estado ACTUAL del repositorio, no una frontera
  //   técnica infalible — ver la nota de nutrition-evidence-classifier.ts
  //   sobre por qué "ausente de dependencies" no es una imposibilidad de
  //   resolución en un workspace de npm.
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, "..", "..", "..");
  const webPackageJsonPath = join(repoRoot, "apps", "web", "package.json");
  const webTsconfigPath = join(repoRoot, "apps", "web", "tsconfig.json");
  const webNextConfigPath = join(repoRoot, "apps", "web", "next.config.mjs");
  const webSrcPath = join(repoRoot, "apps", "web", "src");

  function walkSourceFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkSourceFiles(fullPath));
      } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const byPackageName = /@foodos\/engine/;
  const byRelativePath = /packages\/engine/;

  it("apps/web/package.json no depende de @foodos/engine", () => {
    const pkg = JSON.parse(readFileSync(webPackageJsonPath, "utf-8"));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(allDeps["@foodos/engine"]).toBeUndefined();
  });

  it("apps/web/tsconfig.json no define ningún alias hacia @foodos/engine ni packages/engine", () => {
    const tsconfig = readFileSync(webTsconfigPath, "utf-8");
    expect(byPackageName.test(tsconfig)).toBe(false);
    expect(byRelativePath.test(tsconfig)).toBe(false);
  });

  it("no existe tsconfig raíz ni tsconfig base compartido en este repo hoy (documentado explícitamente, no asumido)", () => {
    const rootTsconfigPath = join(repoRoot, "tsconfig.json");
    let rootTsconfigExists = true;
    try {
      readFileSync(rootTsconfigPath, "utf-8");
    } catch {
      rootTsconfigExists = false;
    }
    expect(rootTsconfigExists).toBe(false);
  });

  it("next.config.mjs no incluye @foodos/engine ni packages/engine en ningún punto del archivo", () => {
    const config = readFileSync(webNextConfigPath, "utf-8");
    expect(byPackageName.test(config)).toBe(false);
    expect(byRelativePath.test(config)).toBe(false);
  });

  it("ningún archivo fuente de apps/web/src menciona @foodos/engine ni packages/engine como subcadena de texto", () => {
    const files = walkSourceFiles(webSrcPath);
    expect(files.length).toBeGreaterThan(0); // confirma que de verdad recorrimos algo

    const offenders = files.filter((f) => {
      const content = readFileSync(f, "utf-8");
      return byPackageName.test(content) || byRelativePath.test(content);
    });
    expect(offenders).toEqual([]);
  });
});
