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

## Arquitectura de cuatro piezas

```
Nutrition Engine v4 (PR1–PR3) ──┐
Exercise Engine v2 (PR4)      ──┼──▶ Adaptive Coordinator (PR5B) ──▶ propuesta auditable,
Núcleos de trayectoria (PR5A) ──┘                                    nunca aplicación automática
```

- **Nutrition Engine v4**: decide política nutricional (evidencia, macros
  diarios, reparto semanal, estrategia) a partir de un TDEE y un objetivo ya
  resueltos.
- **Exercise Engine v2**: produce observaciones y cobertura de rendimiento
  de entrenamiento a partir de sesiones registradas normalizadas.
- **Núcleos de trayectoria (PR5A)**: dos kernels matemáticos independientes
  —tendencia de peso estimada y cobertura del registro de ingesta— que
  producen las señales de trayectoria que el Coordinator consumirá. Se
  fusionan **antes** que el Coordinator y no conocen nada de él.
- **Adaptive Coordinator (PR5B)**: consumidor de ambos motores — combina sus
  salidas tipadas junto con las señales de trayectoria de PR5A (peso,
  cobertura de ingesta) y autoinformes en una propuesta auditable. Se diseña
  **después** de conocer los contratos de salida reales de PR3, PR4 y PR5A,
  precisamente para no fijar una frontera incompleta contra interfaces que
  todavía no existen.

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
  PR5B o para quien consuma estos datos.
- Prohibido explícitamente: sumar kcal de entrenamiento al presupuesto
  alimentario; estimar diagnósticos médicos (RED-S, lesión,
  sobreentrenamiento); declarar ganancia/pérdida muscular; inventar
  RPE/RIR/frecuencia cardiaca/1RM/gasto energético ausentes; modificar
  planes nutricionales directamente; conocer nada de Nutrition Engine v4;
  I/O, Supabase, reloj de sistema.

**Adaptive Coordinator (PR5B)**
- Responsable de: combinar salidas tipadas de ambos motores + señales de
  trayectoria en una propuesta auditable de ajuste.
- Prohibido: aplicar ningún cambio automáticamente (requiere aceptación
  explícita, igual que `nutrition_adjustment_proposals` en v3.1);
  diagnosticar clínicamente.
- **No se identifica automáticamente con el controlador adaptativo actual
  de v3.1** (`evaluateAdaptiveState`/`calcAdaptiveTdee`). Ese controlador es
  una referencia y una posible fuente de funciones puras a portar
  (`calcWeightTrend` y `calcIntakeCoverage`, portadas como heurísticas
  heredadas en PR5A), no un boceto ya aprobado del futuro Coordinator — fue
  diseñado antes de que existiera
  Exercise Engine v2 y antes del selector de prioridad de 5 niveles de
  Nutrition Engine v4, y no tiene ningún concepto de ninguno de los dos.

### Regla absoluta — sin devolución automática de calorías de ejercicio

Ningún motor ni el Coordinator suma calorías de entrenamiento al presupuesto
alimentario de forma automática. **Esto ya es la política de v3.1 hoy**: el
gasto de entrenamiento habitual entra en `calcTdeeBreakdown` vía
`replacementIncrementKcal`; sumar además el `kcalBurned` de una sesión
registrada duplicaría ese componente (`getPendingMacros`,
`apps/web/src/lib/state.tsx:2162-2172`). PR4/PR5A/PR5B heredan esta regla, no
la reinventan.

### Nutrition y Exercise no se conocen entre sí

Confirmado como comportamiento ya existente en v3.1: `isGymDay(profile,
date)` decide el factor gym/descanso a partir de un patrón de horario
declarado en el perfil, nunca de `workoutLog` real. Nutrition Engine v4 y
Exercise Engine v2 mantienen esa misma separación: ninguno importa tipos ni
funciones del otro. Solo el Coordinator (PR5B) importa de ambos; los núcleos
de PR5A no importan de ninguno de los dos.

### Restricciones comunes de motor puro

Ninguna de las cuatro piezas realiza I/O, consulta Supabase, usa `Date`/
`Date.now`/reloj global, red, ni muta sus entradas — mismo estándar que
PR1–PR3, verificado en PR4 y PR5A con el mismo test de pureza AST.

### Carácter inerte

`packages/engine` y las 4 señales/contratos nuevos de v4 no se importan
desde ningún archivo de `apps/web` (verificado por grep repo-wide en la
suite de PR3, que cubre cualquier import de `@foodos/engine`). PR4 y PR5A no
cambian esto: son tan inertes como PR1–PR3.

## Estado de implementación

| Pieza | PR | Tip de `main` tras fusionar |
|---|---|---|
| PR1 — clasificador de evidencia | [#134](https://github.com/UnaiSuarez/FoodOS/pull/134) | `5f0f114` |
| PR2A — kernel de asignación diaria | [#135](https://github.com/UnaiSuarez/FoodOS/pull/135) | `7c67424` |
| PR2B — kernel de plan semanal | [#136](https://github.com/UnaiSuarez/FoodOS/pull/136) | `3fd4e38` |
| PR3 — estrategia nutricional semanal | [#137](https://github.com/UnaiSuarez/FoodOS/pull/137) | `db9a9b8` |
| PR4 — Exercise Engine v2 | [#138](https://github.com/UnaiSuarez/FoodOS/pull/138) | `099978d` |
| PR5A — kernels de tendencia de peso y cobertura de registro | 🔲 implementación local, inerte y todavía no fusionada | — |
| PR5B — Adaptive Coordinator | 🔲 no iniciado; requiere PR5A fusionado | — |
| Integración en producción | 🔲 iniciativa separada y posterior, no uno de los PRs numerados | — |

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
sesiones / progreso / tendencia (se difiere a PR5B, que decide qué
observaciones son comparables); cardio por modalidad/intensidad (no existe
ese dato por sesión real hoy, solo como patrón de perfil para TDEE);
gasto energético; adherencia a rutina; frecuencia por patrón de movimiento;
fatiga/recuperación no autoinformada; "series efectivas"; cualquier
puntuación compuesta; diagnóstico o recomendación; modificación del plan
nutricional; el adaptador desde `WorkoutSession[]`; cualquier cambio en
`apps/web`, persistencia o Supabase.

## Alcance de PR5A

PR5A es un PR **independiente** de PR5B: dos núcleos matemáticos puros, sin
ningún consumidor todavía. No conoce sesiones de entrenamiento, calibración,
persistencia, Supabase ni el Coordinator (una prueba lo verifica sobre el
código fuente de los kernels y de sus contratos).

**Incluido**
- `calculateWeightTrend` — tendencia de peso **estimada**: mediana móvil de 3,
  EWMA con α = 0,2 y regresión por mínimos cuadrados sobre días de calendario
  reales, con cuatro componentes de calidad auditables.
- `calculateIntakeLoggingCoverage` — cobertura del **registro** de ingesta:
  presencia de registro y plausibilidad heredada sobre una ventana explícita.
- Contratos en `packages/types` (`weight-trend.ts`,
  `intake-logging-coverage.ts`) con nombres `WeightTrendEstimate*` e
  `IntakeLoggingCoverage*`, deliberadamente distintos de `WeightTrendResult`
  e `IntakeCoverageResult` de v3.1, que ya cuelgan del mismo barrel (una
  redeclaración local con ese nombre taparía en silencio el `export *`; una
  prueba de tipos lo vigila).

**Explícitamente fuera de alcance**: cualquier decisión de ajustar o no, TDEE
observado, propuesta, aceptación o rechazo, calibración, sesiones o ejercicio,
PR3, PR4, y cualquier cambio en `apps/web`, persistencia o Supabase.

### Contratos

- Ambas funciones son **totales sobre datos ordinarios de tipo JSON**: ante
  cualquier valor JSON-like (objetos, arrays, primitivos, `null`, campos
  ausentes), incluidos los estructuralmente inválidos y aunque el tipo declare
  otra cosa, validan en tiempo de ejecución y devuelven una unión discriminada
  sin lanzar. Los objetos hostiles (getters que lanzan, proxies revocados,
  prototipos manipulados) quedan fuera del contrato, y no se añade un `catch`
  global que ocultaría errores de programación.
  `calculateWeightTrend` → `evaluated` | `insufficient_data` (menos de 3
  mediciones en la ventana) | `invalid_input`;
  `calculateIntakeLoggingCoverage` → `evaluated` (también con cero días
  plausibles) | `invalid_input`.
- La ventana es **explícita e inclusiva** (`startDateKey`, `endDateKey`) y la
  construye el llamador. Los kernels no codifican ninguna longitud de ventana.
- Fechas `YYYY-MM-DD` estrictas, año 0001–9999, calendario gregoriano
  proléptico, **sin `Date`**: la diferencia de días usa aritmética entera
  (`days_from_civil`, Hinnant). Durante el diseño se contrastó de forma
  exhaustiva contra `Date` sobre las 3.652.059 fechas del dominio (0
  discrepancias) mediante un script temporal que **no está incluido en el
  repositorio**: no es una prueba reproducible de este PR. En la suite quedan
  la longitud de cada año de 1 a 9999, los cambios de año, transiciones
  mensuales representativas (febrero bisiesto y no bisiesto, regla del siglo)
  y los extremos del dominio.
- Validación por fases con cortocircuito determinista: forma superior y
  ventana → cada fila es un objeto con `dateKey` real (una fecha inválida
  invalida siempre la petición y no se evalúa ningún otro campo de esa fila)
  → selección por ventana → valores, objetivo y duplicados **solo dentro de la
  ventana** → cálculo. `reasons` va deduplicada y en **orden canónico**,
  independiente del orden de entrada.
- Seguridad numérica: cualquier valor derivado que pueda dar `NaN`, `±Infinity`
  o un entero inseguro termina en `invalid_input` con
  `derived_numeric_result_invalid`; un `evaluated` nunca contiene números no
  finitos. PR5A no añade ningún rango de plausibilidad fisiológica: solo exige
  peso > 0 (la misma restricción `check (kg > 0)` de `weight_log`, necesaria
  además para la variación porcentual), kcal ≥ 0 y objetivo de día > 0 o
  `null`.
- Los resultados científicos **no se redondean** en el kernel; el redondeo es
  presentación y pertenece a quien lo muestre.

### Cobertura de registro no es exactitud de ingesta

`intakeAccuracy` es siempre el literal `"unknown"`, también con cobertura
completa y plausible: PR5A mide **si y cuánto se registró**, no si lo
registrado es correcto. Antecedentes cualitativos (sin cifras en ningún
contrato de runtime), cada uno con lo que respalda y nada más:

- [Frontiers in Endocrinology, 2019](https://www.frontiersin.org/journals/endocrinology/articles/10.3389/fendo.2019.00850/full):
  revisión sistemática de métodos de evaluación dietética frente a agua
  doblemente marcada (DLW). La ingesta autoinformada tiende a subestimarse; la
  mayoría de los métodos y estudios revisados mostraron subestimación.
- [Nature Food, 2024](https://www.nature.com/articles/s43016-024-01089-5):
  existe un desajuste frecuente y detectable entre la ingesta autoinformada y
  el gasto medido. No se le atribuye aquí una dirección de subestimación, que
  no se ha podido verificar en esta fuente.

PR5A no corrige, estima ni cuantifica ninguno de los dos fenómenos.

### Heurísticas heredadas, no evidencia

Todas las constantes proceden de v3.1 y el resultado las declara con
`provenance: "heuristic_inherited_from_v3_1"`:
mínimo de 3 mediciones; mediana móvil de 3; EWMA α = 0,2; objetivo de
cantidad 14 y de amplitud 21 días; umbrales de nivel 0,85 (`high`) y 0,65
(`moderate`), inclusivos por paridad con v3.1 (no se ha encontrado ninguna
serie que dé exactamente 0,85 ni 0,65, así que con el dominio alcanzable `>=`
y `>` son observacionalmente equivalentes desde la API pública); épsilon de
serie plana 1e-6 kg²; suelo de ingesta
de 500 kcal **y** 0,6 × objetivo del día (ambos inclusivos; el relativo no
se aplica sin objetivo). El nivel se llama `trendQualityLevel`, no
`confidence`: describe la calidad de la serie, no la confianza en una
conclusión.

### Divergencias deliberadas respecto a v3.1

Los valores de v3.1 se capturaron durante el diseño ejecutando sus funciones
reales (referencia 2026-09-28) con scripts temporales que no forman parte del
repositorio; en la suite solo quedan como literales, en las pruebas de
«paridad con v3.1» (donde coinciden, tras aplicar en la prueba el redondeo
legacy) y de «divergencia deliberada» (donde no).

| # | Cambio | Legacy | PR5A | Motivo |
|---|---|---|---|---|
| D1 | Fecha duplicada (peso) | acepta; P2 + duplicado en 2026-09-20 → n=16, `qualityScore=0.842473239175989`, "moderate" (sin duplicado: n=15, 0.9094919135528291, "high") | `invalid_input` / `measurement_date_key_duplicate` | Un solo duplicado voltea la calidad y no aporta información temporal |
| D2 | Fecha duplicada (ingesta) | dos filas en 2026-09-27 → `daysWithData=2`, `coverageFraction=0.07` | `invalid_input` / `record_date_key_duplicate` | Infla la cobertura de presencia |
| D3 | `trendWeightKg` sin redondeo previo | P2: 79.4 | 79.3834917805261 | Redondeo solo en el borde de presentación |
| D4 | `weeklyChangePercent` sin doble redondeo | fixture de 21 mediciones: **0.1** | **0.049432773355047865** | Legacy divide `0.04` (kg/semana ya redondeado a 2 decimales) entre `72.3` (tendencia redondeada a 1); los valores sin redondear son 0.0357363… y 72.2928… |
| D5 | Fracciones y promedio sin redondear | 24/28 → 0.86; 23/28 → 0.82; promedio 1737 | 0.8571428571428571; 0.8214285714285714; 1737.375 | Igual criterio de un solo redondeo |
| D6 | Cero días plausibles | `null` | `evaluated` con `plausibleDays: 0` y promedio `null` | Estado tipado en vez de `null` |
| D7 | Orden de suma de ingesta | orden de entrada | ascendente por `dateKey` (comparación ordinal explícita) | Determinismo ante permutaciones; con los seis valores del fixture la suma ascendente es 13890.210000000001 y la descendente 13890.21 |
| D8 | Fechas sin `Date`, dominio 0001–9999 | `new Date(...T12:00:00)` sin validar formato | aritmética entera y validación estricta | Independencia de huso/DST |
| D9 | Validación runtime y seguridad numérica | ninguna: acepta `kcal: Infinity` (1 día, promedio no finito) y objetivo 0 o negativo (sin suelo relativo); descarta en silencio `NaN` y kcal negativas | razones cerradas y `derived_numeric_result_invalid` | Mismo estándar que PR4 |
| D10 | Ventanas | `referenceDate + windowDays` (asimétrica 29/28) | dos ventanas explícitas | Las construye la integración |
| D11 | Nombres | `confidence`, `daysWithData`, `coverageFraction` | `trendQualityLevel`, `loggedDays` y `plausibleDays`, dos fracciones | Sin ambigüedad |

### Asimetría histórica de ventanas (documentada, no codificada)

v3.1 usa dos ventanas distintas con el mismo parámetro `windowDays = 28`:
- **Peso**: acepta `0 <= referencia − fecha <= 28` → **29 fechas** inclusivas.
- **Ingesta**: acepta `referencia − fecha < 28` → **28 fechas** inclusivas, y el
  denominador de la cobertura es `windowDays`.

Verificado con las funciones reales (fixtures P5 e I3: la medición de
referencia−29 queda fuera y la de referencia−28 entra; en ingesta,
referencia−28 queda fuera y referencia−27 entra). Los kernels de PR5A solo
reciben fechas explícitas y **no codifican ninguno de esos dos números**: si la
integración quiere reproducir v3.1 pasa `referencia−28…referencia` al peso
(`windowCalendarDays = 29`) y `referencia−27…referencia` a la ingesta
(`eligibleCalendarDays = 28`).

### Política decidida para la futura integración (PR5B)

Decisión cerrada, **solo documentada aquí**; PR5A no conoce la calibración:

- El denominador de la cobertura **no** se reduce al intervalo posterior a la
  calibración: se conserva la ventana completa prevista.
- Los registros anteriores a `calibrationStartedAt` se excluyen (los filtra el
  llamador antes de invocar el kernel).
- Los días excluidos siguen contando como ausencia dentro de la ventana.
- Consecuencia: una calibración reciente no puede alcanzar cobertura
  suficiente de forma artificial. Ocho días plausibles de diez no son un 80 %
  de una ventana completa: son 8/28. Es la política compatible con v3.1, donde
  los llamadores prefiltran por calibración sin reducir el denominador. Una
  prueba fija que el kernel obedece la ventana recibida y no la reescribe.

### Hallazgos de la auditoría de v3.1 para PR5B

- La puerta de «21 días» del controlador adaptativo compara
  `weightTrend.validMeasurements` (número de mediciones), no la amplitud de
  calendario. PR5B debe decidir explícitamente cuál de las dos cosas quiere
  (`coverage.measurementsInWindow` o `measurementSpanDays`).
- La cobertura **decisional** (sin mapa de objetivos por día) difiere de la
  cobertura del **panel** (con mapa) en v3.1. PR5A recibe el objetivo de cada
  registro de forma explícita; PR5B elige cuál de las dos políticas alimenta.
- Duplicados de fecha. La ruta normal de escritura de peso evita duplicados con
  `upsert` por fecha (`state.tsx:3101-3105`), la sincronización en tiempo real
  reemplaza por fecha (`state.tsx:1271-1272`) y `weight_log` tiene clave
  primaria `(user_id, log_date)` (`20260629213827_sync_v2.sql:25`). Los
  llamadores de ingesta agregan por fecha con un `Map`
  (`NutritionView.tsx:1236-1241` y `1334-1339`). Aun así, estados locales
  heredados o entradas externas todavía podrían contenerlos (`normalizeState`,
  `state.tsx:80-90`, no deduplica), y PR5A los rechaza defensivamente (D1/D2).

### Notas para PR5B (no implementadas aquí)

- PR3 no tiene canal de desplazamiento (solo `tdeeKcal`); el objetivo vigente
  es `weeklyPlan.energy.roundedWeeklyKcalTarget` y
  `audit.desiredObservedRateBandPctPerWeek` ya expone la banda por objetivo.
  PR5B **no** debe llamar a PR3 de forma artificial.
- El ejercicio entra como contexto **no decisional**.
- Nunca emitir `confidence: "high"`; estados upstream tipados; sin campos de
  texto libre.
- La propuesta se expresa en términos de promedio diario y emite
  `requiresNutritionReplan: true`; sin estados aceptada/rechazada (la
  aceptación explícita es de la integración).

## Integración posterior

No es uno de los PRs numerados. Es una iniciativa explícita y separada,
posterior a PR5B, que decide cómo (y si) v3.1 se sustituye gradualmente.
**v3.1 sigue siendo la única lógica en producción hasta esa transición
explícita** — nada en PR1–PR5B cambia el comportamiento que ve un usuario
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
| Mediana móvil de 3, EWMA α = 0,2, mínimo de 3 mediciones, objetivos de calidad 14 mediciones / 21 días y umbrales 0,85 / 0,65 (PR5A) | Heurística de producto heredada de v3.1, portada sin cambios y marcada `heuristic_inherited_from_v3_1` en el resultado; no es evidencia |
| Suelo de plausibilidad de ingesta: 500 kcal y 0,6 × objetivo del día (PR5A) | Heurística de producto heredada de v3.1, no un umbral clínico ni una corrección del subregistro |
| Tendencia de la ingesta autoinformada a subestimarse frente a DLW | Antecedente cualitativo citado: Frontiers in Endocrinology 2019 (la mayoría de los métodos y estudios revisados mostraron subestimación); PR5A no lo cuantifica ni lo corrige |
| Desajuste frecuente y detectable entre ingesta autoinformada y gasto medido | Antecedente cualitativo citado: Nature Food 2024, sin atribuirle una dirección de subestimación que no se pudo verificar; PR5A no lo detecta ni lo corrige |
| Aritmética de fechas `days_from_civil` (PR5A) | Derivación matemática publicada (Hinnant). Contrastada de forma exhaustiva contra `Date` en todo el dominio 0001–9999 durante el diseño con un script temporal no incluido en el repositorio (no reproducible desde este PR); en la suite hay comprobaciones parciales: longitud de cada año, transiciones mensuales y extremos |

## Deudas y decisiones abiertas

- Normalización de nombres de músculo (mayúsculas/acentos) — PR4 los trata
  como strings opacos, comparación exacta, sin recorte de espacios
  silencioso.
- Si Adaptive Coordinator (PR5B) reutiliza tipos existentes de v3.1 en
  `packages/types` (`AdjustmentDecision`, ya productivo) o define
  equivalentes propios. Para peso e ingesta PR5A ya decidió definir los
  suyos (`WeightTrendEstimate*`, `IntakeLoggingCoverage*`) en lugar de
  reutilizar `WeightTrendResult` e `IntakeCoverageResult`.
- Qué mínimo de sesiones o distancia temporal hace comparable una
  observación de rendimiento entre sesiones — decisión de PR5B, no de PR4.
- El validador de fechas de PR4 acepta el año 0000, mientras que PR5A
  restringe el dominio a 0001–9999. Deuda registrada, sin cambiar PR4 aquí.
- Los helpers de fechas están duplicados a propósito: la validación de
  calendario en los dos kernels de PR5A y en PR4, y `days_from_civil` en los
  dos de PR5A y en PR2B (`daysFromCivil`). PR5A no crea utilidades
  compartidas; consolidarlas es una decisión de un PR posterior.
- Duplicación de la tabla de fiabilidad de medición de %grasa entre PR1 y
  PR3 (deuda registrada en el diseño de PR3, no relacionada con PR4).
- Ciclo de tipos vía el barrel de `packages/types` (deuda registrada en el
  diseño de PR3).
- Números de PR de GitHub reales para PR1/PR2A/PR2B — verificados vía
  `gh pr view` antes de escribir esta tabla, no asumidos.

No se añade en PR4 ninguna validación de plausibilidad antropométrica ni
ningún límite fisiológico inventado — la seguridad numérica de PR4 se basa
exclusivamente en el rango seguro de IEEE754, nunca en umbrales biológicos.
Lo mismo vale para PR5A: la única «plausibilidad» es el suelo de ingesta
heredado de v3.1, declarado como heurística de producto.
