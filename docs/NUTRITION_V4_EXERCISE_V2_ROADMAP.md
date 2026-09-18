# Roadmap — Nutrition Engine v4 + Exercise Engine v2 + Adaptive Coordinator

Este documento describe una **arquitectura de motores puros y sus contratos**,
y registra decisiones ya cerradas de secuenciación. No es un documento de
evidencia científica: cada afirmación de este texto está etiquetada como
arquitectura, regla de producto, heurística heredada o evidencia citada, y
esas etiquetas no cambian por el hecho de estar aquí escritas. Convertir una
heurística de producto en "conclusión validada" solo por aparecer en este
documento sería exactamente el error que este proyecto ha intentado evitar
en cada PR anterior.

Este documento es distinto de `docs/NUTRITION_V3_DECISIONES.md`, que
describe el motor v3.1 en producción con su **propia numeración interna
PR1–PR10+** (rollout ya cerrado de `apps/web/src/lib/nutrition.ts`). Esa
numeración no tiene relación con la de este documento — un "PR4" en aquel
documento (auditoría final de v3) y el "PR4" de aquí (Exercise Engine v2)
son cosas distintas que comparten número por coincidencia de dos proyectos
separados.

## Arquitectura de tres piezas

```
Nutrition Engine v4 (PR1–PR3) ──┐
                                  ├──▶ Adaptive Coordinator (PR5) ──▶ propuesta auditable,
Exercise Engine v2 (PR4)      ──┘                                    nunca aplicación automática
```

- **Nutrition Engine v4**: decide política nutricional (evidencia, macros
  diarios, reparto semanal, estrategia) a partir de un TDEE y un objetivo ya
  resueltos.
- **Exercise Engine v2**: produce observaciones y cobertura de rendimiento
  de entrenamiento a partir de sesiones registradas normalizadas.
- **Adaptive Coordinator**: consumidor de ambos motores — combina sus
  salidas tipadas junto con señales de trayectoria (peso, cobertura de
  ingesta, autoinformes) en una propuesta auditable. Se diseña **después**
  de conocer el contrato de salida real de Exercise Engine v2, precisamente
  para no fijar una frontera incompleta contra una interfaz que todavía no
  existe.

### Responsabilidades y prohibiciones

**Nutrition Engine v4**
- Responsable de: clasificación de evidencia, asignación diaria de macros,
  reparto semanal, política de objetivo/prioridad/proteína/grasa/energía.
- Prohibido: calcular TMB/TDEE (se recibe ya resuelto); conocer nada de
  Exercise Engine v2; I/O, Supabase, reloj de sistema.

**Exercise Engine v2**
- Responsable de: observaciones auditables y cobertura por señal a partir
  de un contrato de entrada normalizado propio — nunca `WorkoutSession` de
  v3.1 (ver §"Modelo legacy diagnosticado").
- **PR4 produce observaciones auditables y cobertura, nunca una conclusión
  de rendimiento**: ninguna noción de progreso, tendencia, adherencia o
  calidad se calcula aquí. Esa interpretación queda, en su totalidad, para
  PR5 o para quien consuma estos datos.
- Prohibido explícitamente: sumar kcal de entrenamiento al presupuesto
  alimentario; estimar diagnósticos médicos (RED-S, lesión,
  sobreentrenamiento); declarar ganancia/pérdida muscular; inventar
  RPE/RIR/frecuencia cardiaca/1RM/gasto energético ausentes; modificar
  planes nutricionales directamente; conocer nada de Nutrition Engine v4;
  I/O, Supabase, reloj de sistema.

**Adaptive Coordinator**
- Responsable de: combinar salidas tipadas de ambos motores + señales de
  trayectoria en una propuesta auditable de ajuste.
- Prohibido: aplicar ningún cambio automáticamente (requiere aceptación
  explícita, igual que `nutrition_adjustment_proposals` en v3.1);
  diagnosticar clínicamente.
- **No se identifica automáticamente con el controlador adaptativo actual
  de v3.1** (`evaluateAdaptiveState`/`calcAdaptiveTdee`). Ese controlador es
  una referencia y una posible fuente de funciones puras a portar
  (`calcWeightTrend`, `calcIntakeCoverage` en particular), no un boceto ya
  aprobado del futuro Coordinator — fue diseñado antes de que existiera
  Exercise Engine v2 y antes del selector de prioridad de 5 niveles de
  Nutrition Engine v4, y no tiene ningún concepto de ninguno de los dos.

### Regla absoluta — sin devolución automática de calorías de ejercicio

Ningún motor ni el Coordinator suma calorías de entrenamiento al presupuesto
alimentario de forma automática. **Esto ya es la política de v3.1 hoy**: el
gasto de entrenamiento habitual entra en `calcTdeeBreakdown` vía
`replacementIncrementKcal`; sumar además el `kcalBurned` de una sesión
registrada duplicaría ese componente (`getPendingMacros`,
`apps/web/src/lib/state.tsx:2162-2172`). PR4/PR5 heredan esta regla, no la
reinventan.

### Nutrition y Exercise no se conocen entre sí

Confirmado como comportamiento ya existente en v3.1: `isGymDay(profile,
date)` decide el factor gym/descanso a partir de un patrón de horario
declarado en el perfil, nunca de `workoutLog` real. Nutrition Engine v4 y
Exercise Engine v2 mantienen esa misma separación: ninguno importa tipos ni
funciones del otro. Solo el Coordinator (PR5) importa de ambos.

### Restricciones comunes de motor puro

Ninguno de los tres realiza I/O, consulta Supabase, usa `Date`/`Date.now`/
reloj global, red, ni muta sus entradas — mismo estándar que PR1–PR3,
verificado en PR4 con el mismo test de pureza AST.

### Carácter inerte

`packages/engine` y las 4 señales/contratos nuevos de v4 no se importan
desde ningún archivo de `apps/web` (verificado por grep repo-wide en la
suite de PR3, que cubre cualquier import de `@foodos/engine`). PR4 no
cambia esto: es tan inerte como PR1–PR3.

## Estado de implementación

| Pieza | PR | Tip de `main` tras fusionar |
|---|---|---|
| PR1 — clasificador de evidencia | [#134](https://github.com/UnaiSuarez/FoodOS/pull/134) | `5f0f114` |
| PR2A — kernel de asignación diaria | [#135](https://github.com/UnaiSuarez/FoodOS/pull/135) | `7c67424` |
| PR2B — kernel de plan semanal | [#136](https://github.com/UnaiSuarez/FoodOS/pull/136) | `3fd4e38` |
| PR3 — estrategia nutricional semanal | [#137](https://github.com/UnaiSuarez/FoodOS/pull/137) | `db9a9b8` |
| PR4 — Exercise Engine v2 | 🔲 en implementación | — |
| PR5 — Adaptive Coordinator | 🔲 no iniciado | — |
| Integración en producción | 🔲 iniciativa separada y posterior, no uno de los cinco PRs | — |

## Modelo legacy diagnosticado (evidencia, `apps/web`)

Releído el flujo completo de `ExercisesView.tsx`/`strength.ts`/
`packages/types/src/index.ts` antes de diseñar PR4:

- `WorkoutSession.completedExercises` es opcional; una sesión sin ejercicios
  es un caso normal (`ExercisesView.tsx:898`).
- `CompletedExercise.sets[]` contiene **todas** las series planeadas, cada
  una con su `done` real — no solo las completadas. Todas arrancan
  `done: true` y el usuario desmarca las que no hizo
  (`ExercisesView.tsx:757-781`).
- `sets.length === totalSets` es una convención de la única vía de
  escritura actual, no una invariante universal del tipo.
- Series `done:false`, `warmup` (excluida de e1RM y de tonelaje) y
  `dropset` (excluida solo de e1RM) tienen tratamiento ya establecido en
  `strength.ts`, heredado sin cambios en PR4.
- `exerciseId` es obligatorio y estable dentro del linaje de una misma
  rutina; **no** garantizado estable entre rutinas distintas para
  ejercicios personalizados (cada `custom-${uid()}` es nuevo).
- Peso corporal se representa como `weight: null`; `weight: 0` explícito
  recibe hoy el mismo tratamiento que `null` en `strength.ts`.
- Varias sesiones el mismo día son válidas: nada en el modelo ni en la UI
  lo impide (`ExercisesView.tsx:359`, `push` sin comprobación de fecha).
- `kcalBurned` es una **estimación MET autorrellenada** según el grupo
  muscular de la sesión (`estimateWorkoutKcal`/`metForMuscleGroups`,
  `ExercisesView.tsx:801-811`), que el usuario puede editar libremente — no
  un valor exclusivamente manual. Sigue completamente fuera del alcance de
  PR4 en cualquier caso.
- El adaptador desde este modelo legacy hacia el contrato normalizado de
  PR4 **se difiere explícitamente a la futura PR de integración** — PR4
  nunca importa `WorkoutSession`.

## Alcance de PR4

**Incluido**: número de sesiones y cobertura de duración; serie temporal de
e1RM estimado (Epley, con y sin ajuste por RIR, con procedencia completa por
índices); tonelaje externo (`externalLoadKg × reps`) agregado por
sesión+ejercicio; conteo de series por músculo (primario y secundario por
separado, con cobertura honesta); observaciones de RIR con procedencia
completa.

**Explícitamente fuera de alcance de PR4**: series temporales entre
sesiones / progreso / tendencia (se difiere a PR5, que decide qué
observaciones son comparables); cardio por modalidad/intensidad (no existe
ese dato por sesión real hoy, solo como patrón de perfil para TDEE);
gasto energético; adherencia a rutina; frecuencia por patrón de movimiento;
fatiga/recuperación no autoinformada; "series efectivas"; cualquier
puntuación compuesta; diagnóstico o recomendación; modificación del plan
nutricional; el adaptador desde `WorkoutSession[]`; cualquier cambio en
`apps/web`, persistencia o Supabase.

## Integración posterior

No es uno de los cinco PRs. Es una iniciativa explícita y separada,
posterior a PR5, que decide cómo (y si) v3.1 se sustituye gradualmente.
**v3.1 sigue siendo la única lógica en producción hasta esa transición
explícita** — nada en PR1–PR5 cambia el comportamiento que ve un usuario
real.

## Separación entre arquitectura, heurísticas y evidencia

| Elemento | Categoría |
|---|---|
| Delegación exclusiva de PR2B/PR3 en capas inferiores, sin duplicar aritmética | Decisión de arquitectura |
| Fórmula de Epley (e1RM) | Derivación matemática publicada (1985), ya citada en `strength.ts` |
| Ajuste de e1RM por RIR (`reps + rir`) | Regla de producto, no una corrección validada externamente |
| Rango de RIR [0, 10] | Heurística de producto, tomada de la investigación de mercado ya citada en el proyecto (`docs/INVESTIGACION_VISION_Y_ENTRENAMIENTO.md`), no un umbral clínico |
| 10-20 series/músculo/semana | Antecedente de investigación ya citado, usado por OTRA función de v3.1 (`weeklySetsByMuscle`, en producción) — no una política que PR4 implemente o decida |
| Bandas de ritmo semanal / paso de 100 kcal / mínimo de 21 días del controlador adaptativo v3.1 | Heurística de producto, etiquetada como tal en el propio código de v3.1 ("no es una cifra científica") |

## Deudas y decisiones abiertas

- Normalización de nombres de músculo (mayúsculas/acentos) — PR4 los trata
  como strings opacos, comparación exacta, sin recorte de espacios
  silencioso.
- Si Adaptive Coordinator (PR5) reutiliza tipos existentes de v3.1 en
  `packages/types` (`WeightTrendResult`, `AdjustmentDecision`, ya
  productivos) o define equivalentes propios.
- Qué mínimo de sesiones o distancia temporal hace comparable una
  observación de rendimiento entre sesiones — decisión de PR5, no de PR4.
- Duplicación de la tabla de fiabilidad de medición de %grasa entre PR1 y
  PR3 (deuda registrada en el diseño de PR3, no relacionada con PR4).
- Ciclo de tipos vía el barrel de `packages/types` (deuda registrada en el
  diseño de PR3).
- Números de PR de GitHub reales para PR1/PR2A/PR2B — verificados vía
  `gh pr view` antes de escribir esta tabla, no asumidos.

No se añade en PR4 ninguna validación de plausibilidad antropométrica ni
ningún límite fisiológico inventado — la seguridad numérica de PR4 se basa
exclusivamente en el rango seguro de IEEE754, nunca en umbrales biológicos.
