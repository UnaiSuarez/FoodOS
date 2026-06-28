import type { FoodOSState } from "@foodos/types";

function download(filename: string, content: string, mimeType = "text/csv;charset=utf-8;") {
  const blob = new Blob(["﻿" + content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function esc(v: string | number) {
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n")
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

function row(...cols: (string | number)[]) {
  return cols.map(esc).join(",");
}

export function exportFoodDiaryCSV(state: FoodOSState, year: number, month: number) {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const entries = state.foodLog.filter((e) => e.date.startsWith(prefix));

  const lines = [
    row("Fecha", "Alimento", "kcal", "Proteína (g)", "Carbos (g)", "Grasa (g)"),
    ...entries.map((e) =>
      row(e.date, e.name, e.kcal, e.protein, e.carbs ?? 0, e.fat ?? 0)
    ),
  ];

  const monthStr = String(month).padStart(2, "0");
  download(`foodOS-diario-${year}-${monthStr}.csv`, lines.join("\n"));
}

export function exportWeightCSV(state: FoodOSState) {
  const entries = [...(state.weightLog ?? [])].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  const lines = [
    row("Fecha", "Peso (kg)"),
    ...entries.map((e) => row(e.date, e.kg)),
  ];

  download(`foodOS-peso.csv`, lines.join("\n"));
}

export function exportFinancesCSV(state: FoodOSState, year: number, month: number) {
  const prefix = `${year}-${String(month).padStart(2, "0")}`;
  const expenses = state.expenses.filter(
    (e) => e.type === "expense" && e.date.startsWith(prefix)
  );

  const lines = [
    row("Fecha", "Descripción", "Categoría", "Importe (€)"),
    ...expenses.map((e) => row(e.date, e.description ?? "", e.category, e.amount)),
  ];

  const monthStr = String(month).padStart(2, "0");
  download(`foodOS-finanzas-${year}-${monthStr}.csv`, lines.join("\n"));
}

export function exportFullCSV(state: FoodOSState, year: number, month: number) {
  exportFoodDiaryCSV(state, year, month);
  exportFinancesCSV(state, year, month);
  exportWeightCSV(state);
}
