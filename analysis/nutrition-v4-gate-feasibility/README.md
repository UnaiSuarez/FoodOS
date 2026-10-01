# Nutrition v4 — análisis de viabilidad del gate

Script de **solo lectura**, fuera del workspace de npm (carpeta `analysis/`,
no `apps/*` ni `packages/*`): no se ejecuta como parte de ningún build ni
test de `apps/web` ni de `packages/engine`, y no cruza la frontera
arquitectónica actual (vive fuera de `apps/web/src`, así que las pruebas
estructurales que impiden a ese árbol mencionar el paquete de kernels no lo
alcanzan ni falsean).

Recorre el camino real completo con datos **sintéticos** (nunca se lee
`food_log` de producción ni se toca Supabase):

```
escritor real (food-log-provenance.ts / nutrient-provenance.ts)
  -> FoodLogEntry real
  -> buildDiaryIntegrityInput (apps/web/src/lib/nutrition-v4-adapter.ts, sin modificar)
  -> evaluateNutrientCoverage (packages/engine, sin modificar)
```

## Ejecutar

```bash
npm install
npx tsx run.ts
```

## Qué construye

Una ventana de 28 días (2026-02-01 → 2026-02-28) con un día por cada perfil
de escritor real: consumo de inventario OFF/USDA (con y sin palabra de
estado que permita `foodStateConfidence:"confirmed"`), producto escaneado
por código de barras, catálogo local, receta cocinada (con y sin
`qtyOverrides` ignorados), comida estimada por IA, plato/plan manual, dos
días mixtos (una entrada fiable + una estimada, por encima y por debajo del
umbral diario de ejemplo), un día con una entrada no ponderable (kcal
corrupto/negativo) junto a una perfecta, y un día con solo una entrada
sintética (debe comportarse como no registrado).

Ejecuta la misma ventana con tres calibraciones de umbral distintas para
mostrar cómo cambia el resultado — este script no decide ni recomienda
ningún umbral "correcto".
