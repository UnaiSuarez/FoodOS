# Decisiones de diseño — Nutrition Engine v3

> Este documento describe **decisiones de modelo**, no constantes científicas
> universales. Cuando una cifra sea una heurística de producto, debe
> identificarse como tal en código, documentación y UI. No es el backlog
> (eso vive en `BACKLOG.md`): este documento dice *por qué* v3 funciona así
> y qué decisiones no deben reinterpretarse a mitad de refactor.

Fuente: sesión de diseño conjunta revisando `nutrition.ts` (motor v2) contra
guías EFSA, OMS, NICE, ESPEN, NIDDK/NIH, ISSN y el Compendium of Physical
Activities 2024, más lectura directa del código real (`nutrition.ts`,
`packages/types/src/index.ts`, `NutritionView.tsx`, `OnboardingFlow.tsx`,
tests y `DECISIONES_PRODUCTO.md`).

---

## 1. Objetivo y alcance de Nutrition v3

### Qué problemas resuelve
- Elimina bugs objetivos de v2 que producen resultados incorrectos (no solo
  "mejorables"): duración de entreno compartida entre fuerza/cardio, edad
  mínima de 14 años, y comparación de cobertura histórica contra el
  objetivo calórico de *hoy* en vez del objetivo vigente en cada fecha.
- Corrige inconsistencias de modelo entre partes del motor que hoy miden lo
  mismo con fórmulas distintas (MET bruto en el TDEE habitual vs. MET neto
  en `estimateWorkoutKcal`), o que aplican el mismo multiplicador de
  proteína a bases fisiológicamente distintas (peso real, peso ajustado,
  masa magra).
- Sustituye una regla estática (`7700 kcal/kg`) que la literatura (NIDDK/
  Hall et al.) considera un modelo simplificado que no representa bien la
  dinámica real del peso, por un controlador basado en si el ritmo
  observado coincide con el ritmo objetivo.
- Corrige una traición semántica: seleccionar "ganancia muscular" nunca
  debe traducirse en un déficit calórico silencioso.

### Qué queda explícitamente fuera de v3
- IMC continuo + perímetro de cintura + evaluación de adiposidad completa
  (fase 2 — ver §9).
- Desagregación del gasto cotidiano por componentes (sueño, trabajo,
  desplazamiento, tareas) — requiere datos que hoy no se capturan
  (wearables, horarios reales).
- Eliminación de `LIFESTYLE_ONLY_FACTORS` / modelo PAL.
- Cualquier intento de convertir el % de compensación metabólica del
  ejercicio (~28% según algunos estudios, con variación individual grande)
  en una constante fija del motor — eso lo aprende el adaptativo, no se
  hardcodea.

### Principio general
**Estimación inicial razonable y auditable → adaptación mediante respuesta
real del usuario.** Ninguna fórmula de v3 pretende conocer el gasto
energético exacto de una persona a partir de un formulario. El objetivo es
que la estimación inicial sea coherente, monótona y sin dobles conteos
obvios, y que el sistema adaptativo la corrija con datos reales de peso e
ingesta a lo largo de semanas — nunca al revés.

---

## 2. Decisiones cerradas

### 2.1 — Modelo de actividad: separar duración de fuerza y cardio

- **Problema actual**: `TrainingActivityProfile.avgSessionDurationMin` es un
  único campo aplicado tanto a `strengthDaysPerWeek` como a
  `cardioDaysPerWeek`. Un usuario que declara "5 días fuerza + 5 días
  cardio + 60 min" es interpretado como 600 min/semana (10h), aunque
  probablemente quería decir sesiones combinadas de 60 min.
- **Decisión**: separar `strength: {daysPerWeek, avgDurationMin,
  intensity}` y `cardio: {daysPerWeek, avgDurationMin, activity,
  intensity}` como sub-objetos independientes.
- **Justificación**: es un bug de interpretación de datos, no una elección
  de modelo — el dato que entra no representa lo que el usuario quiso decir.
- **Alternativa descartada**: preguntar "¿el cardio está incluido en los 60
  min de fuerza?" como checkbox adicional en vez de separar los campos. Se
  descarta porque no resuelve el caso de quien sí entrena fuerza y cardio
  en sesiones distintas — solo parchea un caso concreto.
- **Implicaciones de código**: cambia `TrainingActivityProfile` (tipo
  compartido), `calcHabitualTrainingAllowanceKcal`, el formulario de
  onboarding, y requiere migración de perfiles v2 existentes (ver §10).

### 2.2 — Edad mínima del motor adulto

- **Problema actual**: `OnboardingFlow.tsx` acepta `age >= 14`
  (`min="14"`), pero todas las fórmulas (Mifflin-St Jeor, guardarraíles de
  seguridad, rangos de déficit) están calibradas para adultos.
- **Decisión**: edad mínima 18 en cliente y servidor. No se construye un
  motor pediátrico en v3.
- **Justificación**: el NIH Body Weight Planner, una de las referencias
  utilizadas para diseñar/revisar el enfoque adaptativo (§6), está limitado
  a adultos ≥18 y excluye embarazo/lactancia explícitamente por la misma
  razón — las necesidades de crecimiento y desarrollo no se modelan igual.
- **Alternativa descartada**: motor pediátrico separado. Descartada por
  alcance — no hay evidencia de que sea una prioridad de producto ahora
  mismo, y hacerlo mal es peor que no ofrecerlo.
- **Implicaciones de código**: validación en formulario + validación
  server-side (no confiar solo en `min` del input HTML) + `EligibilityGate`
  (ver §5).

### 2.3 — Cobertura de ingesta histórica: target por fecha, no target de hoy

- **Problema actual**: `calcIntakeCoverage` recibe `targetKcal` como un
  único número (`targetKcalToday`), pero se evalúa contra una ventana de 28
  días. Si hoy es día de gym y el histórico incluye días de descanso (o
  viceversa, o el perfil cambió), la cobertura se calcula mal.
- **Decisión**: pasar un `targetByDate: Map<string, number>` (o el
  histórico ya persistido de objetivos diarios) en vez de un escalar.
- **Justificación**: el bug contamina directamente el motor adaptativo —
  una cobertura mal calculada puede bloquear o desbloquear propuestas de
  ajuste de forma incorrecta, y silenciosa.
- **Alternativa descartada**: recalcular retroactivamente el target de cada
  día histórico con el perfil actual. Descartada porque es incorrecta por
  diseño — si el perfil cambió hace 10 días, el histórico de hace 20 días
  debe compararse contra el objetivo que existía entonces, no contra el de
  hoy.
- **Implicaciones de código**: `calcIntakeCoverage`, `NutritionView.tsx`
  (puntos donde se llama con `targetKcalToday`), y probablemente requiere
  que el objetivo diario histórico esté persistido por fecha (verificar si
  ya existe en snapshots o hay que añadirlo).

### 2.4 — Proteína: regla propia por base de referencia, sin heredar el multiplicador

- **Problema actual**: `calcProteinBase()` devuelve un `number` a partir de
  peso real, peso ajustado (ESPEN) o masa magra (si hay `bodyFatPct`), y
  **el mismo multiplicador** (2.0 g/kg para fat_loss/recomp) se aplica a
  las tres bases indiscriminadamente. Efecto observable: introducir el %
  de grasa (un dato "más preciso") puede **bajar** la proteína recomendada
  bruscamente, porque 2.0 g/kg de masa magra da un número mucho menor que
  2.0 g/kg de peso ajustado.
- **Decisión**: la base FFM (masa magra) tiene su propio rango, no hereda
  el 2.0 g/kg pensado para peso ajustado/real. No se fija todavía
  "2.0–2.4 g/kg FFM" como cifra universal para todos los contextos — se
  trata como estrategia específica según objetivo y, como mínimo,
  experiencia/estado energético (más alto en déficit + entrenado + magro,
  según ISSN).
- **Justificación**: es más simple que levantar un tipo
  `ProteinReference + Confidence + Provenance` completo ahora mismo, y
  arregla el comportamiento contraintuitivo del bug sin sobre-ingeniería.
- **Alternativa descartada**: tipo completo `ProteinReference` con
  confianza y procedencia por caso (`actual_weight` / `adjusted_weight` /
  `fat_free_mass`, cada uno con su `confidence`). Aplazada — no rechazada
  del todo, pero se considera trabajo de fase 2 si hace falta más adelante;
  para v3 basta con reglas distintas por base.
- **Implicaciones de código**: `calcProteinBase` / la función que aplica el
  multiplicador debe ramificar por tipo de base, no aplicar un
  `proteinPerKg` único desde `GOAL_CONFIG`. v3 **sí** añade una procedencia
  mínima (`bodyFatSource`), pero **no** implementa todavía un sistema
  completo de `confidence`/`provenance` ni hace depender automáticamente
  toda la estrategia nutricional de un score de confianza — eso queda
  aplazado a fase 2 (ver §9) si la experiencia real lo justifica.

### 2.5 — Modelo energético del entrenamiento: `replacementIncrementKcal`

- **Problema actual**: el TDEE habitual (`calcHabitualTrainingAllowanceKcal`)
  suma el **MET bruto** del entrenamiento sobre un `lifestyleTdee` que ya
  representa un día completo (24h) de actividad cotidiana sin entrenar.
  Como el entrenamiento sustituye un tramo de ese día (no lo añade sobre un
  día vacío), sumar el bruto cuenta dos veces la energía de esos minutos:
  una vez implícita en `lifestyleTdee`, otra vez explícita en el
  entrenamiento. Además, `estimateWorkoutKcal` (usado para sesiones
  registradas) sí resta reposo (`MET − 1`), así que dos partes del motor
  miden "gasto de ejercicio" con fórmulas distintas.
- **Decisión**: tres conceptos separados y con nombre distinto, para no
  confundirlos:
  - `grossKcal` — estimación MET estándar de la sesión, sin restar nada.
  - `netAboveRestKcal` — gross menos 1 MET (reposo). Es lo que hoy calcula
    `estimateWorkoutKcal`; se conserva para mostrar "cuánto gastaste en la
    sesión" en el módulo de Ejercicios.
  - `replacementIncrementKcal` — gross menos el gasto que el modelo de
    lifestyle **ya había asignado** a esos minutos. Es el único que debe
    modificar el mantenimiento estimado en Nutrición.
- **Justificación**: `netAboveRestKcal` responde exclusivamente a "cuánta
  energía adicional estima el modelo por encima del reposo estándar de 1
  MET". No intenta estimar cuánto añade el entrenamiento respecto al día
  cotidiano modelado por FoodOS — por eso no debe usarse para modificar el
  mantenimiento, independientemente del nivel de lifestyle. Ni siquiera
  para `sedentary` representa el incremento real respecto al lifestyle:
  `sedentary = 1.2 × RMR`, no reposo puro, y el estándar `1 MET = 3.5
  ml/kg/min` no tiene por qué coincidir con el RMR estimado por Mifflin (de
  hecho, en el ejemplo numérico de la sesión de diseño no coincidía).
  Restar el gasto lifestyle desplazado (no el reposo) es la única de las
  opciones consideradas que respeta la propia definición de `lifestyleTdee`
  como "día completo sin entrenar".
- **Alternativa descartada**: usar `TMB/1440` (reposo puro) como baseline
  fijo en vez de `lifestyleTdee/1440`. Descartada porque solo corrige el
  doble conteo del reposo, no el de la actividad cotidiana ya incluida vía
  `LIFESTYLE_ONLY_FACTORS` — seguiría existiendo doble conteo parcial en
  cualquier perfil que no sea sedentario puro.
- **Nota epistémica explícita**: `baselineDisplaced` (= `lifestyleTdee/1440
  × minutos`) es una **convención contable** para evitar doble conteo entre
  el modelo de actividad cotidiana y el ejercicio explícito. No pretende
  estimar el gasto contrafactual real de esa hora concreta — el promedio
  mezcla sueño, trabajo, desplazamientos y tareas repartidos uniformemente
  sobre 1440 min, y una hora de gimnasio normalmente sustituye una hora
  despierta, no una fracción proporcional del día completo. Se acepta como
  aproximación razonable, coherente y auditable — no como medición.
- **Implicaciones de código**: `ExerciseEnergyEstimate { grossKcal,
  netAboveRestKcal, replacementIncrementKcal }` como tipo explícito, con
  semántica fijada para que no se elija uno al azar:

  ```
  grossKcal
  → energía total estimada durante el intervalo de ejercicio.

  netAboveRestKcal
  → energía adicional estimada por encima de 1 MET durante ese intervalo.

  replacementIncrementKcal
  → incremento que Nutrición atribuye al entrenamiento
    respecto al lifestyle que ya estaba modelado.
  ```

  Regla de uso en UI: si el texto dice "calorías de actividad" o "calorías
  extra", usar `netAboveRestKcal`; si dice "energía total estimada durante
  la sesión", puede usar `grossKcal`. Nutrición usa exclusivamente
  `replacementIncrementKcal`. `replacementIncrementKcal` se clampa a `≥ 0`
  (ver invariantes, §8).

### 2.6 — Semántica de objetivos: `muscle_gain` nunca es un déficit encubierto

- **Problema actual**: `kcalFactor("muscle_gain", ...)` devuelve `×0.90`
  (déficit del 10%) cuando `IMC ≥ 27`. Un usuario que selecciona
  explícitamente "ganancia muscular" recibe una estrategia de pérdida de
  peso sin saberlo.
- **Decisión**: `muscle_gain` significa mantenimiento o superávit pequeño,
  siempre. Si el sistema considera que no es la estrategia más apropiada
  para ese perfil (p.ej. adiposidad alta), **recomienda** `recomp` como
  alternativa — nunca sustituye el objetivo por debajo del usuario sin que
  lo vea y lo acepte explícitamente.
- **Justificación**: cambiar el significado de un objetivo seleccionado
  explícitamente rompe la confianza del usuario en lo que la app dice que
  está haciendo, independientemente de si la recomendación subyacente es
  correcta.
- **Alternativa descartada**: mantener el comportamiento actual pero
  renombrar la etiqueta ("ganancia muscular condicionada"). Descartada
  porque no resuelve el problema real — el usuario sigue sin saber que
  seleccionó A y recibió B.
- **Implicaciones de código**: eliminar la rama de `kcalFactor` que aplica
  déficit a `muscle_gain`; añadir el flujo de recomendación/confirmación en
  la UI (`shouldWarnMuscleGain` ya existe como detección — falta que
  además ofrezca la alternativa en vez de solo avisar).
- **Estado (PR4, auditoría final de v3)**: esta decisión quedó documentada
  como cerrada en la primera sesión de diseño de v3, pero **nunca se
  implementó** hasta que la auditoría final de PR4 la encontró todavía
  activa en producción (`kcalFactor` seguía devolviendo `0.90` con
  IMC≥27). PR4 corrige `kcalFactor("muscle_gain")` con IMC≥27 a `1.0`
  (mantenimiento exacto, nunca déficit). **Sigue sin implementarse** el
  flujo real de "usar recomendación" con confirmación explícita del
  banner de `shouldWarnMuscleGain` (solo informa/recomienda en texto —
  mejora futura, no bloqueante).
- **Alcance exacto del invariante (corregido tras una segunda auditoría
  externa del propio commit de PR4, `fdf0f4d`)**: el primer borrador de
  PR4 prometía `goal=muscle_gain → targetKcal >= estimatedTdeeKcal` como
  propiedad de `calcDailyTargets()` sin matizar — **incorrecto**, porque
  `calcDailyTargets` suma `adaptiveKcalOffsetKcal` DESPUÉS de aplicar
  `kcalFactor`, y un offset negativo aceptado explícitamente por el
  usuario (Adaptive v3, §6) sí puede bajar el target final por debajo del
  TDEE de la fórmula. El invariante correcto y ya protegido por test es
  más estrecho:

  ```
  kcalFactor("muscle_gain", ...) >= 1.0   // SIEMPRE, cualquier IMC — el
                                            // factor base nunca decide
                                            // un déficit por sí solo
  ```

  No es una promesa sobre el target final para cualquier entrada de
  `calcDailyTargets`. Un offset adaptativo negativo, una vez aceptado, es
  el controlador corrigiendo el OBJETIVO respecto al modelo estimado con
  datos reales — precisión terminológica: `evaluateAdaptiveState()` no
  recibe ni recalcula el TDEE en sí, así que "corrige el TDEE" es
  impreciso; lo correcto es "corrige el objetivo energético según la
  trayectoria observada", manteniendo la separación estricta entre TDEE
  diagnóstico (`calcAdaptiveTdee`, 7700) y el controlador (§6). No es el
  bug original de §2.6 reapareciendo (ese era la fórmula decidiendo un
  déficit sin que el usuario lo viera ni aceptara).
  Un `Math.max(tdee, rawKcal)` habría "arreglado" esto haciendo que las
  propuestas negativas del adaptativo fueran inertes solo para
  `muscle_gain` — inconsistente con los otros tres objetivos, y por eso
  descartado.

---

## 3. Modelo energético

Variables:

- `RMR` — gasto en reposo estimado (Mifflin-St Jeor). Renombrado desde
  "TMB" para reflejar que es una predicción, no una medición (Mifflin
  estima *resting energy expenditure*).
- `lifestyleTdee` — gasto estimado de un día completo (24h) sin
  entrenamiento: `RMR × lifestyleFactor` (`LIFESTYLE_ONLY_FACTORS`).
- `grossKcal` — estimación MET estándar de una sesión de ejercicio, sin
  ajustar.
- `netAboveRestKcal` — `grossKcal` menos 1 MET de reposo. Uso: mostrar
  gasto estimado de una sesión concreta (módulo Ejercicios).
- `baselineDisplaced` — gasto que `lifestyleTdee` ya asignaba a los
  minutos de la sesión, asumiendo reparto uniforme sobre 1440 min/día.
- `replacementIncrementKcal` — lo único que debe modificar el
  mantenimiento estimado.

Fórmula final:

```
lifestyleTdee = RMR × lifestyleFactor

baselineDisplaced =
  (lifestyleTdee / 1440) × sessionMinutes

replacementIncrement =
  max(0, grossExerciseKcal − baselineDisplaced)

weeklyMaintenance =
  lifestyleTdee × 7
  + Σ replacementIncrement (todas las sesiones de la semana)
```

> `baselineDisplaced` es una convención contable para evitar doble conteo,
> no una medición del gasto contrafactual real de esa hora. Ver
> justificación completa en §2.5.

### 3.1 PR3 — mapeo confirmado, sin reabrir la fórmula

Mapeo completo (código real, no hipótesis) antes de tocar `nutrition.ts`:

- **Dos pipelines ya separadas**, y correctamente — PR3 solo toca la A:
  - **A (Nutrición)**: `STRENGTH_MET`/`CARDIO_MET` (5.0/7.0 fijos) →
    `calcHabitualTrainingAllowanceKcal` (bruto, sin restar nada) →
    `calcTDEE` (rama `lifestyle_plus_training`) → `calcDailyTargets`/
    `calcSummary`. `calcTDEE` no se llama desde ningún sitio fuera de
    `nutrition.ts`.
  - **B (Ejercicios)**: `metForMuscleGroups` (MET contextual 3.5/5.0/6.0)
    → `estimateWorkoutKcal` (ya usa `MET−1`, es decir, ya calcula
    `netAboveRestKcal` aunque no se llame así) → `kcalBurned` por sesión
    logueada → `ExercisesView.tsx`. Confirmado por
    [state.tsx:734-739](../apps/web/src/lib/state.tsx) que `kcalBurned`
    **nunca** se suma de vuelta a `getPendingMacros` — no hay fuga entre
    pipelines hoy.
- **Persistencia**: `nutrition_calculation_snapshots.tdee`/
  `.resting_energy` son `jsonb` sin esquema fijo — sin migración SQL.
  `trainingActivity` y `workoutLog` viven en `extra_state` — tampoco.
- **Tests**: solo un bloque pina la fórmula bruta exacta (`nutrition.test.ts`,
  `describe("calcTDEE")`, caso `"lifestyle_plus_training: suma..."`) — se
  reescribe completo. El resto del `describe` (fallback legacy,
  monotonía) debería sobrevivir, se re-verifica al implementar.

No hay nada en este mapeo que obligue a reabrir
`baselineDisplaced = lifestyleTdee / 1440 × minutos` — se mantiene tal
cual quedó cerrado.

### 3.2 Tres correcciones sobre lo encontrado en el mapeo

1. **El comentario de `state.tsx` queda desactualizado por el modelo v3**
   y debe corregirse en este PR. Dice hoy: *"el PAL/perfil ya se elige en
   función de la actividad habitual, y sumar además el gasto de cada
   sesión concreta duplicaría ese mismo entrenamiento"* — pero
   `LIFESTYLE_ONLY_FACTORS` (vida cotidiana) **no** incluye el
   entrenamiento deliberado; la razón correcta es que el entrenamiento
   habitual ya entra en el TDEE nutricional vía `replacementIncrementKcal`,
   así que sumar además la sesión registrada volvería a contar ese
   componente. Corregir el comentario, no solo el código.

2. **Hacer explícita la semántica de `estimateWorkoutKcal()`** — hoy
   devuelve un `number` cuyo significado real es `netAboveRestKcal`, sin
   decirlo. Se conserva como wrapper de compatibilidad si conviene, pero
   la API interna debe distinguir explícitamente `grossKcal` /
   `netAboveRestKcal` / `replacementIncrementKcal` — para que dentro de
   unos meses nadie reutilice ese número pensando que es gasto bruto o
   incremento de TDEE.

3. **Eliminar la duplicación de cálculo en `NutritionView.tsx`** — el
   panel "Tu plan diario" reconstruye el desglose lifestyle/entreno
   llamando directamente a `LIFESTYLE_ONLY_FACTORS` y
   `calcHabitualTrainingAllowanceKcal` por su cuenta, en vez de leerlo de
   `calcTDEE`. No es scope creep: se está cambiando precisamente cómo se
   compone el TDEE, y dejar una segunda implementación manual del mismo
   desglose es un bug preparado para el día en que una de las dos cambie
   y la otra no. `calcTDEE()` pasa a ser un wrapper delgado:

   ```ts
   interface TdeeBreakdown {
     restingEnergyKcal: number;
     lifestyleTdeeKcal: number;
     habitualTrainingGrossKcalPerDay: number;
     baselineDisplacedKcalPerDay: number;
     replacementIncrementKcalPerDay: number;
     totalTdeeKcal: number;
   }

   function calcTdeeBreakdown(profile, rmr): TdeeBreakdown { ... }

   function calcTDEE(profile, rmr): number {
     return calcTdeeBreakdown(profile, rmr).totalTdeeKcal;
   }
   ```

   La UI consume `calcTdeeBreakdown()` directamente en vez de
   reimplementar la fórmula. Nombres de campos no cerrados al detalle —
   la estructura y el principio (una sola fuente) sí.

### 3.3 Invariantes (a proteger con tests antes de tocar código de producción)

```
grossKcal = MET × 3.5 × weightKg / 200 × minutes
grossKcal → independiente del lifestyle

netAboveRestKcal = max(0, grossKcal − standard1MetKcal)
netAboveRestKcal → independiente del lifestyle

baselineDisplaced = lifestyleTdee / 1440 × minutes

replacementIncrementKcal = max(0, grossKcal − baselineDisplaced)
replacementIncrementKcal → depende del lifestyle
```

Estructurales:

```
mismo ejercicio + mismo peso + misma duración
  → mismo grossKcal aunque cambie lifestyle

mismo ejercicio, lifestyle mayor
  → baselineDisplaced mayor → replacementIncrement menor o igual

replacementIncrement >= 0
replacementIncrement <= grossKcal

sin entrenamiento → replacementIncrement = 0 → TDEE = lifestyleTdee

añadir entrenamiento con incremento > 0 → TDEE no disminuye

cambiar solo duración de cardio → no cambia el componente de fuerza
```

Unidades temporales (para no volver a mezclar semanal/diario, el tipo de
bug que ya nos costó una sesión entera):

```
weeklyTrainingIncrement = Σ replacementIncrement de las sesiones semanales
TDEE = lifestyleTdee + weeklyTrainingIncrement / 7
```

Específico del módulo de Ejercicios (protege la separación de
responsabilidades — cambiar cómo vive alguien fuera del gimnasio no debe
alterar retroactivamente las calorías mostradas de una sesión concreta ya
registrada):

```
cambiar lifestyleActivity → NO cambia grossKcal ni netAboveRestKcal
                              de una sesión registrada
```

### 3.4 Limitación conocida, documentada y explícitamente aplazada

`STRENGTH_MET = 5` y `CARDIO_MET = 7` son heurísticas agregadas, no
valores fisiológicos precisos — el Compendium of Physical Activities 2024
muestra variación real incluso dentro de una misma familia de ejercicios
(p.ej. calistenia moderada ≈3.8 MET, vigorosa ≈7.5 MET) y advierte
explícitamente que el MET estándar no está pensado para estimar con
precisión el gasto individual, y que "1 MET" puede no coincidir con el
RMR real de una persona concreta. PR3 **no** toca estos valores — mezclar
"arreglar el doble conteo" con "mejorar la estimación de intensidad" en
el mismo cambio dificultaría saber qué modificación produjo qué
resultado. Queda como mejora futura, explícitamente no resuelta aquí.

---

## 4. Modelo de proteína

Tres bases de referencia posibles, cada una con su propia regla — **nunca
se reutiliza automáticamente el mismo multiplicador g/kg entre bases
distintas** (ver §2.4):

- **Peso real** — caso por defecto sin obesidad ni % de grasa conocido.
- **Peso ajustado** (aproximación ESPEN, `ideal + 0.33 × exceso`) — cuando
  el peso supera ~1.25× el peso ideal a IMC 25 y no hay % de grasa. Se
  documenta como "aproximación pragmática derivada de guías clínicas de
  obesidad", no como "estándar ISSN de nutrición deportiva" — la
  redacción anterior sobre-vendía la fuente.
- **Masa magra (FFM)** — cuando hay % de grasa corporal disponible. Rango
  propio, no el mismo multiplicador que peso ajustado/real.

Fuente y calidad del % de grasa: los métodos de estimación de grasa
corporal pueden presentar errores individuales suficientemente grandes
como para no tratar cualquier porcentaje introducido como una medición
exacta. Por eso v3 registra de dónde viene el dato (DXA, BIA profesional,
báscula doméstica, plicómetro, estimación visual) mediante un campo mínimo
`bodyFatSource` — sin implementar todavía un sistema completo de
`confidence`/`provenance` (ver §2.4 y §9). La regla de "no heredar el
multiplicador entre bases" ya evita el peor síntoma del bug mientras tanto.

---

## 5. Objetivos corporales

- `fat_loss` — déficit.
- `recomp` — déficit moderado, ciclado gym/descanso.
- `maintain` — mantenimiento.
- `muscle_gain` — mantenimiento o superávit pequeño, **siempre** (ver §2.6).
  Nunca se transforma silenciosamente en déficit. Las recomendaciones
  alternativas (p.ej. sugerir `recomp` según adiposidad) son
  recomendaciones explícitas que el usuario acepta o rechaza — nunca
  sustituciones ocultas del objetivo seleccionado.

`EligibilityGate` (nuevo en v3): antes de calcular un plan automático,
evaluar si el perfil queda fuera del alcance del motor adulto estándar
(menor de 18, embarazo/lactancia, indicios de trastorno alimentario,
contextos clínicos relevantes). En esos casos, el motor no genera un plan
automático y así lo comunica — no intenta diagnosticar nada.

---

## 6. Motor adaptativo (PR2 — Adaptive v3)

Diseño cerrado en sesión dedicada de evidencia + arquitectura, **antes** de
tocar `nutrition.ts`. Sustituye el uso de `7700 kcal/kg` como motor de
decisiones por un controlador de **ritmo observado vs. banda objetivo**.

### 6.1 Principio general

```
NO calcular:
  "tu TDEE real es X → te faltan Y kcal"
SÍ calcular:
  "para tu objetivo esperábamos una trayectoria A;
   tu tendencia observada es B;
   la desviación es suficientemente grande, persistente y respaldada
   por datos buenos como para justificar un pequeño cambio."
```

`7700 kcal/kg` **nunca desaparece** — sigue calculando `observedTdeeKcal`
como diagnóstico/inferencia aproximada (mostrable, persistible en
evidencia), pero deja de tener ninguna vía hacia `suggestedDelta` o
`proposalEligible`. Ver test anti-7700 en §6.6 — es la prueba ejecutable
de que esto se cumple, no solo una declaración de intenciones.

### 6.2 Matriz de evidencia (clasificación cerrada)

| Elemento | Valor | Clasificación |
|---|---:|---|
| Banda `fat_loss` | −1.00 % a −0.50 %/semana | Evidencia específica (Helms 2014, preparación de culturismo natural) → ancla de producto, no ley universal |
| Banda `muscle_gain` | +0.25 % a +0.50 %/semana | Evidencia específica (Iraki et al. 2019, off-season novato/intermedio) → ancla de producto, no ley universal |
| Banda `maintain` | −0.25 % a +0.25 %/semana | Guardarraíl de producto — sin evidencia que fije el ancho |
| Banda `recomp` | −0.50 % a 0.00 %/semana | Heurística de producto informada por la semántica de recomp (admite pérdida lenta, no ganancia sostenida ni pérdida ya agresiva) y por evidencia de que el entrenamiento de fuerza en déficit puede preservar/mejorar composición corporal aunque el peso baje — **no** es una cifra prescrita por ninguna guía |
| Ventana mínima para proponer (21 vs. 28 días) | — | **Sin evidencia que decida entre las dos** — pendiente, ver §6.7 |
| Relación glucógeno-agua | ~2.7–4 g agua/g glucógeno | Evidencia fisiológica de dirección — magnitud variable, no una constante de controlador |
| Sodio → ruido de báscula | Dirección sí (regulación de agua) | DASH-Sodium mantenía el peso deliberadamente estable durante el ensayo — **no sirve** para cuantificar fluctuación libre de peso por sodio |
| Zona muerta / paso / cooldown | — | Guardarraíles de producto — no hay literatura que prescriba deadband ni step size |

`muscle_gain` modulado por `experienceLevel` (Iraki recomienda más
conservadurismo en avanzados) queda **fuera de PR2** — cuantificar "más
conservador" en una banda concreta sería inventar precisión, y añade un
input subjetivo nuevo al motor/fingerprint/tests sin necesidad inmediata.
Mejora futura documentada, no decisión de PR2.

### 6.3 Bandas (congeladas)

```
fat_loss:    [-1.00, -0.50] %/semana
muscle_gain: [+0.25, +0.50] %/semana
maintain:    [-0.25, +0.25] %/semana
recomp:      [-0.50,  0.00] %/semana
```

Bordes **inclusivos** en los cuatro casos — estar exactamente en el borde
cuenta como "dentro de la banda" (sin acción), para no disparar una
propuesta por un error de redondeo de una centésima. `recomp` es
deliberadamente **asimétrica** — ningún código ni test debe asumir que las
bandas son simétricas alrededor de 0.

### 6.4 Variable decisoria

```
La decisión adaptativa por ritmo usa EXCLUSIVAMENTE weeklyChangePercent.
slopeKgPerDay puede mostrarse/persistirse como diagnóstico, pero NUNCA
determina la banda ni el delta.
```

Razón: las bandas están definidas en % del peso corporal — usar
`slopeKgPerDay` directamente haría que 0.5 kg/semana significara lo mismo
para alguien de 55 kg que para alguien de 130 kg, contradiciendo el propio
diseño de la banda.

### 6.5 Arquitectura en tres capas

```
1. trajectoryAssessment: "inside" | "below" | "above"
   (weeklyChangePercent contra la banda del goal)

2. suggestedDelta: -100 | 0 | +100
   (depende SOLO de goal + weeklyChangePercent)

3. proposalEligibility: boolean + blockingReasons[]
   (depende de suggestedDelta != 0 + gates de calidad + cooldown)
```

`proposedDelta` y `proposalEligible` **no dependen de los mismos inputs**
— es una distinción deliberada, no una simplificación. Debe poder ocurrir
esto sin perder información:

```
fat_loss, ritmo = -0.2%/sem → suggestedDelta = -100
pero cooldown activo        → proposalEligible = false
```

El controlador detecta la desviación aunque temporalmente no esté
autorizado a proponer — la UI puede mostrar "detectamos algo, pero toca
esperar" en vez de "todo bien" (a decidir en implementación, no aquí).

**Fuente única**: una sola función `evaluateAdaptiveState()` produce las
tres capas. `generateProposal()` (UI) y el panel de diagnóstico consumen
el mismo resultado — elimina la duplicación detectada en el mapeo previo
(dos llamadas independientes a la lógica de decisión con inputs
potencialmente distintos).

### 6.6 Gates de calidad (léxico corregido)

```
weightTrend.confidence === "high"   (gate semántico directo — NO vía
                                      ADAPTIVE_CONFIDENCE_WEIGHTS, que
                                      pertenece al blending de v2/diagnóstico
                                      y no debe colarse en la decisión v3)
coverage >= 85%                     (gate de INTERPRETABILIDAD del registro,
                                      no de "adherencia" — cobertura alta con
                                      ingesta sistemáticamente desviada del
                                      objetivo pasa este gate igual; un gate
                                      de adherencia real queda fuera de PR2,
                                      sin diseñar todavía)
ventana mínima = PENDIENTE (§6.7)
cooldown inactivo
```

`ADAPTIVE_CONFIDENCE_WEIGHTS` se conserva en el código mientras
`calcAdaptiveTdee()` siga existiendo para el diagnóstico — deja de
formar parte de cualquier gate o cálculo de la decisión.

**Test anti-7700 (obligatorio)**:

```
mismo weightTrend, mismo goal, misma confidence, misma coverage
avgIntakeKcal A ≠ avgIntakeKcal B  (manteniendo la MISMA coverage —
                                     coverage se deriva de los registros de
                                     ingesta, así que el test cambia el
                                     promedio sin cambiar cuántos días
                                     cuentan como fiables)
observedTdeeKcal A ≠ observedTdeeKcal B  (por construcción, al cambiar avgIntakeKcal)
→ mismo suggestedDelta
→ misma proposalEligibility
```

Esta es la prueba ejecutable de que el objetivo arquitectónico de PR2 se
cumplió — no una declaración de intenciones en un comentario.

### 6.7 Ventana mínima para proponer — cerrado en implementación (PR2)

**21 días** (`ADJUSTMENT_MIN_EVALUATION_DAYS` en `nutrition.ts`). No hay
evidencia que decida entre 21 y 28 — ninguna app comparable investigada
(MacroFactor) publica ni justifica su ventana con estudios. 21 no es "más
científico" que 28; se eligió para equilibrar estabilidad de la tendencia
y capacidad de respuesta del controlador, y queda documentado como
**guardarraíl de producto, no hallazgo científico**, en el propio código.

En cuanto se mergea, deja de ser solo una cifra "provisional en el papel"
— empieza a decidir propuestas reales, así que código y documentación
tienen que coincidir. Revisable con datos de producción; si cambia,
actualizar esta sección y el comentario de `ADJUSTMENT_MIN_EVALUATION_DAYS`
en el mismo commit.

### 6.8 Magnitud del ajuste

```
DEFAULT_ADJUSTMENT_STEP_KCAL = 100   // el único valor que el controlador
                                      // normal puede seleccionar
MAX_ADJUSTMENT_STEP_KCAL     = 150   // hard cap de esquema/seguridad —
                                      // NO un segundo escalón automático
                                      // ("si te sales mucho, 150"); el
                                      // controlador nunca lo alcanza por
                                      // sí mismo en v3
COOLDOWN_DAYS = 14
```

Paso fijo, no proporcional a cuánto se sale de la banda — proporcional
introduciría una superficie de diseño nueva (¿proporcional a qué
constante?) sin respaldo de evidencia.

### 6.9 Invariantes de dirección (el contrato más importante)

```
fat_loss    + ritmo menos negativo que la banda (pierde despacio) → delta < 0
fat_loss    + ritmo más negativo que la banda (pierde rápido)      → delta > 0
muscle_gain + ritmo menos positivo que la banda (gana despacio)    → delta > 0
muscle_gain + ritmo más positivo que la banda (gana rápido)        → delta < 0
maintain    + ritmo por encima de la banda (gana)                  → delta < 0
maintain    + ritmo por debajo de la banda (pierde)                → delta > 0
recomp      + ritmo por encima de la banda (gana, >0%)              → delta < 0
recomp      + ritmo por debajo de la banda (pierde más de -0.5%)   → delta > 0
dentro de la banda (cualquier objetivo)                             → delta = 0
```

Casos obligatorios de test para la asimetría de `recomp`:

```
-0.50% → dentro
-0.25% → dentro
 0.00% → dentro
-0.51% → fuera por abajo (delta > 0)
+0.01% → fuera por arriba (delta < 0)
```

### 6.10 Lo que se conserva sin tocar

- Cooldown de 14 días entre decisiones (aceptar/rechazar).
- Aceptación siempre explícita por el usuario — el motor nunca aplica un
  ajuste por sí solo.
- `evaluateNutritionSafety` y demás guardarraíles de `calcDailyTargets` —
  sin relación con este cambio, no se tocan.

### 6.11 Fingerprint — completado en PR4 (auditoría final de v3)

El fingerprint de propuesta (`AdjustmentProfileFingerprint`) debe seguir
invalidando una propuesta pendiente si cambia cualquier input capaz de
alterar materialmente el plan contra el que se generó:

```
Invariante a preservar/completar: cualquier cambio en un input que pueda
alterar materialmente el plan contra el que se generó una propuesta debe
hacerla stale.
```

**Cerrado en PR4** tras comparar contra las dependencias reales de
`calcDailyTargets` post-PR1/2/3. Campos añadidos: `age`, `sex`,
`heightCm`, `bodyFatPct` — los cuatro cambian RMR, IMC y/o la base de
proteína. Deliberadamente **excluidos**, con justificación, no por
omisión:

- **`bodyFatSource`** — en v3 la procedencia del % graso es solo
  informativa/UX (§2.4/§9), no cambia ningún target. Incluirla en el
  fingerprint sería ruido — si algún día la fuente empieza a modificar
  confianza o macros, entra entonces.
- **`gymDays`** — `evaluateAdaptiveState()` ni siquiera recibe `gymDay`
  como input: el offset adaptativo se suma como término plano en
  `calcDailyTargets`, independiente del tipo de día. `gymDays` sí cambia
  qué target concreto ve el usuario cada día, pero eso se recalcula en
  vivo en la UI — no es parte de lo que este fingerprint protege (si la
  *decisión* de ajuste sigue siendo válida).

Nota deliberada, no fusionada con lo anterior: `isRelevantCalibrationChange()`
(qué invalida el HISTÓRICO de calibración adaptativa) y el fingerprint de
propuesta (qué invalida una PROPUESTA PENDIENTE concreta) son preguntas
distintas — un input puede justificar que una propuesta quede stale sin
necesariamente justificar borrar semanas de calibración de peso/ingesta
ya acumulada. `isRelevantCalibrationChange()` no se tocó en PR4; sigue
cubriendo solo `goal`/`activityLevel`/`activityModelVersion`/
`trainingActivity`, revisión pendiente y separada si hiciera falta.

**Compatibilidad con propuestas persistidas entre PR9 y PR4** (señalado en
la auditoría externa del commit): una propuesta guardada en ese rango
tiene un `AdjustmentProfileFingerprint` real (no `undefined` — ese caso
ya lo cubre "sin fingerprint original, nunca obsoleta"), pero sin las
claves `age`/`sex`/`heightCm`/`bodyFatPct`. Al comparar, `undefined !==
valor actual` es siempre `true`, así que **cualquier propuesta pendiente
de ese rango se trata como obsoleta al primer intento de aceptarla tras
desplegar PR4** — degradación segura (bloquea aceptar sobre datos
incompletos en vez de asumir que sigue siendo válida), no un crash.
Impacto esperado bajo (pocos usuarios, propuestas pendientes raras en la
práctica), pero documentado explícitamente y cubierto por test para que
no sorprenda si aparece en producción.

---

## 7. Bugs obligatorios de v3

Los tres cambios sin debate, primeros en implementarse (ver §2.1-§2.3):

1. Separar duración de fuerza y cardio en `TrainingActivityProfile`.
2. Edad mínima 18, cliente y servidor.
3. Cobertura de ingesta histórica evaluada contra el objetivo vigente en
   cada fecha, no el objetivo de hoy.

---

## 8. Invariantes de tests

Más importantes que las fórmulas exactas — protegen el *comportamiento*
del modelo, no un número concreto que puede volverse obsoleto sin que el
modelo esté roto:

```
grossKcal                      independiente del lifestyle
netAboveRestKcal                independiente del lifestyle
replacementIncrementKcal        depende del lifestyle
replacementIncrementKcal       <= grossKcal

sin sesiones de entrenamiento  → weeklyMaintenance = lifestyleTdee × 7

lifestyle mayor                 → replacementIncrement menor o igual
replacementIncrement            → siempre >= 0
cambiar duración de cardio      → no cambia la energía calculada de fuerza
Σ targets diarios                = presupuesto semanal

goal = muscle_gain             → estrategia energética nunca tiene déficit

ningún plan inseguro             se corrige silenciosamente (nunca clamp mudo)
datos insuficientes             ⇒ ningún ajuste adaptativo se propone
<18 años                        nunca entra en el cálculo del motor adulto
cambiar cualquier input relevante del cálculo → invalida propuestas pendientes (fingerprint)
```

---

## 9. Decisiones aplazadas

Explícitamente pospuestas — y explícitamente el motivo, para que dentro de
unos meses no reaparezcan disfrazadas de "TODO pequeño":

- **Perímetro de cintura / adiposidad más allá del IMC** — mejora real
  (EASO 2024 recomienda no reducir la valoración de obesidad al IMC), pero
  implica UX nueva, un dato adicional que puede faltar, y más estados
  incompletos que gestionar. Se aplaza a fase 2 de v3; mientras tanto,
  sustituir el corte duro IMC 27/30 por interpolación suave en la banda
  27-32 ya elimina el precipicio 29.9→30.0 sin necesitar cintura.
- **Modelo continuo completo de adiposidad** (mismo motivo que arriba).
- **Eliminación de `LIFESTYLE_ONLY_FACTORS` / modelo PAL** — solo tendría
  sentido si el gasto cotidiano se reconstruye por componentes reales
  (pasos, horarios, wearables). Sin esos datos, sustituir una heurística
  agregada por otra no aporta precisión real, solo aparenta hacerlo.
- **Integración de wearables / pasos en el cálculo directo** — los pasos
  ya se capturan mediante formulario pero no afectan al cálculo (`N8` en
  `REVISION_NUTRICION_PR48-52.md`). Integrarlos bien requiere resolver
  primero el doble conteo con cardio declarado ("¿tu cardio va incluido en
  esos pasos?") — no es solo sumar un término más.
- **Gasto cotidiano por componentes** (sueño/trabajo/desplazamiento/tareas
  desagregados) — requiere datos que hoy no existen en el producto.
- **Tipo completo `ProteinReference { kind, confidence, provenance }`** —
  la versión mínima (regla propia por base, sin heredar multiplicador) ya
  resuelve el bug observable; el tipo completo se revisará si hace falta
  más granularidad más adelante.

---

## 10. Plan de migración `nutrition-v2 → nutrition-v3`

*(Pendiente de detallar en la sesión de diseño técnico — apuntado aquí como
placeholder para que no se pierda como paso explícito del refactor)*

- Qué datos de `PhysicalProfile`/`TrainingActivityProfile` v2 son
  compatibles tal cual con v3, y cuáles requieren migración (p.ej.
  `avgSessionDurationMin` único → `strength.avgDurationMin` +
  `cardio.avgDurationMin`: decidir si se asume "mismo valor para ambos" o
  se fuerza a los usuarios existentes a revisar su perfil).
- Qué perfiles necesitan volver a completar información (edad <18
  existente, si los hay; % de grasa sin fuente registrada).
- Qué histórico del motor adaptativo queda invalidado por el cambio de
  fórmula de `replacementIncrementKcal` (un TDEE inicial recalculado con
  fórmula distinta rompe la comparación con el TDEE observado acumulado).
- Cómo se conservan snapshots anteriores para auditoría sin que se
  interpreten como calculados con las reglas de v3 (versión de motor en
  cada snapshot — ya existe `NUTRITION_ENGINE_VERSION`, subir a
  `nutrition-v3` cuando se implemente).

---

## Orden de implementación acordado

1. **PR1** — ✅ **Implementado** (4 commits: migraciones SQL, contrato de
   datos, bugs obligatorios, proteína por base). Bugs obligatorios (§7) +
   modelo de proteína (§2.4) + soporte de targets históricos por fecha en
   el adaptativo (§2.3). No tocó MET ni sustituyó `7700` en la misma
   entrega — ambos cambian la interpretación del mantenimiento y
   complicarían diagnosticar qué cambio produjo qué resultado.
2. **PR2** — ✅ **Implementado.** Adaptive v3: controlador de ritmo
   observado vs. banda objetivo, manteniendo TDEE inferido (7700) como
   diagnóstico puro (garantizado por tipo — `evaluateAdaptiveState()` ni
   siquiera acepta `avgIntakeKcal`), arquitectura de tres capas
   (trajectory/suggestedDelta/eligibility) y fuente única. Ventana mínima
   cerrada en 21 días (§6.7), guardarraíl de producto explícito, no
   hallazgo científico.
3. **PR3** — ✅ **Implementado.** Actividad/TDEE v3: `calcTdeeBreakdown`
   como fuente única (`grossExerciseKcal`/`baselineDisplacedKcal`/
   `replacementIncrementKcal`, clampados por sesión antes de sumar —
   §2.5, §3.3), `calcTDEE()` reducido a wrapper delgado sobre
   `.totalTdeeKcal`, `estimateWorkoutKcal` con semántica explícita de
   `netAboveRestKcal` (pipeline B, Ejercicios, sin tocar su
   comportamiento), duplicación eliminada en `NutritionView.tsx`
   (`ProfileSummary` consume `calcTdeeBreakdown` en vez de reimplementar
   el desglose), comentario de `state.tsx` corregido para citar
   `replacementIncrementKcal` como razón real de no sumar `kcalBurned` de
   vuelta al presupuesto. `STRENGTH_MET=5`/`CARDIO_MET=7` quedan sin
   tocar, limitación conocida explícitamente aplazada (§3.4).
   **`NUTRITION_ENGINE_VERSION` sube a `nutrition-v3`** — los tres PR
   quedan cubiertos por el identificador, tal como prometía el documento.
4. **PR4** — ✅ **Implementado.** Cierre/auditoría final de v3, tras una
   revisión completa de la rama `d5cb696..7feba76` (7700/combinedKcal
   fuera de la decisión, sin gross sumado directo, sin duplicación de
   desglose, sin residuos de campos legacy — todo confirmado limpio). Dos
   hallazgos reales corregidos:
   - `kcalFactor("muscle_gain")` con IMC≥27 seguía devolviendo `0.90`
     (déficit real) pese a que §2.6 lo daba por cerrado desde la primera
     sesión de diseño — nunca se había implementado. Corregido a `1.0`;
     invariante protegido por test es sobre el **factor base**
     (`kcalFactor("muscle_gain", ...) >= 1.0` siempre), no una promesa
     sin matizar sobre el target final — una segunda auditoría externa
     del propio commit de PR4 encontró que el primer borrador prometía
     de más (`adaptiveKcalOffsetKcal` negativo y aceptado sí puede bajar
     el target final del TDEE, intencionalmente — ver §2.6, corregido en
     el mismo PR4). Banner de aviso actualizado para no prometer "sin
     déficit" de forma absoluta.
   - Fingerprint de propuesta completado (§6.11): `age`/`sex`/`heightCm`/
     `bodyFatPct` añadidos; `bodyFatSource`/`gymDays` excluidos con
     justificación explícita, no por omisión.
   - **Bloqueante de despliegue, fuera de este PR**: las dos migraciones
     de PR1 (`age >= 18`, `body_fat_source`) siguen sin aplicar en la
     base de datos real — confirmado por auditoría directa. El código ya
     asume la columna `body_fat_source`; desplegar sin aplicar antes las
     migraciones rompería la sincronización de perfil.
