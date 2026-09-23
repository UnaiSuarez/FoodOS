# Base mínima de integridad de datos para Nutrition v4

**Rama de diseño:** `design/nutrition-v4-data-integrity`
**Base:** `origin/main@82a581c02bac2802dd4aec863c22a21f76fd755f` (confirmado sin mover)
**Naturaleza de esta ronda:** exclusivamente auditoría y diseño. Cero código de producción, cero commits, cero PR, cero SQL ejecutado, cero operaciones contra Supabase, cero cambios de producción.

**v7 de este documento — última corrección antes de cerrar la ronda.** La v6 asignaba `foodStateConfidence:"not_applicable"` a todo lo que viniera de código de barras o de entrada manual, por origen. Incorrecto: un producto escaneado puede declarar valores sin preparar mientras el usuario registra lo preparado (sopas/purés con base `*_prepared_100g`), y una entrada manual puede portar una referencia por 100g con estado ambiguo. Corregido en §1.6: `not_applicable` se reserva para cuando el número YA es el total consumido (sin una referencia por 100g detrás), nunca por el origen del dato — ver §1.6, §4, §9, §10 para el detalle completo. Cierra esta ronda de diseño; sigue una conclusión breve (ver el final del documento).

**v6 de este documento — corrección sobre la propia v5.** La v5 clasificaba el problema de estado del alimento (crudo/cocido, §13.2) como "recomendado, no bloqueante" con el argumento de que un valor `known_nonzero` mal referenciado sigue siendo un dato "honesto", solo sesgado. Esa distinción es incorrecta para los efectos de esta fase: que un valor sea fiel a su fuente no implica que sea aplicable a la ingesta registrada, y un sesgo sistemático puede corromper una propuesta adaptativa exactamente igual que un cero inventado — la pregunta central de esta fase no distingue "dato inventado" de "dato mal aplicado" como riesgos de gravedad distinta. Se revierte esa clasificación: la salvaguarda mínima de estado pasa a **Nivel 2, bloqueante para la activación** (no el clasificador completo genérico/producto/plato, que sigue fuera de alcance). Ver §1.7 (nuevo) y la reescritura de §13.2.

**v5 de este documento.** Añadió §13: contraste requisito-por-requisito con el documento externo «FoodOS · Comida, nutrientes y finanzas v2» (41 apartados, facilitado por el usuario), con una tensión real identificada (estado del alimento crudo/cocido, §13.2) y el resto de requisitos clasificados en cubierto / requisito de activación / aplazado, sin contradicciones adicionales de fondo con la ruta crítica.

**v4 de este documento — tercera corrección tras revisión.** Dos correcciones más:
1. **`seedHistorico()` deja de ser un riesgo hipotético**: se confirma que es un botón sin ninguna restricción (`SettingsView.tsx:680`, `📊 Sembrar 7 días de historial`, sin `isDev`/flag alrededor — grep dedicado sin resultados), alcanzable por cualquier usuario real. Se trata en consecuencia como un hallazgo cerrado, no una pregunta abierta, y se añade un PR de mitigación en el propio producto (§9, PR11).
2. **El gate de datos sintéticos estaba mal definido**: la v3 decía que un día `synthetic` "no cuenta en el denominador" — eso es exactamente lo que NO debe pasar, porque encoge la ventana exigida y hace más fácil superar el umbral (una ventana de 7 días con 1 sintético y 6 buenos pasaría de 6/7 a un falso 6/6). Se corrige a: la ventana (`windowDays`) nunca cambia; las entradas `synthetic:true` se filtran ANTES de sumar cualquier día (a nivel de entrada individual, no de día completo, para no penalizar un día real que por coincidencia comparta fecha con una entrada sembrada), y el día resultante se reevalúa con las reglas normales — si al quitar lo sintético no queda nada real ese día, cuenta como `unlogedDays` (ocupa un lugar en el denominador, no lo reduce), nunca como una categoría que reduce `windowDays`.

**v3 de este documento — segunda corrección tras revisión.** La v2 resolvía cinco imprecisiones (ver historial abajo) pero dejaba una contradicción real: reconocía que un `?? 0` de OFF/USDA podía colarse como `known_zero` en `macrosForQuantity`, y sin embargo definía "PR4 — corregir P2" como un parche cosmético de dos líneas en `food-lookup.ts`, sin tocar los otros puntos donde ocurre exactamente el mismo colapso. Esta ronda:

1. **Audita TODOS los caminos de captura real** (no solo `food-lookup.ts`) y confirma que hay más colapsos `?? 0` de los documentados, y **más escritores de `foodLog` de los que la v2 afirmaba** (la v2 decía "solo 2" — grep ampliado a todo `apps/web/src` encuentra 8 sitios reales, ver §1.4).
2. Define **dónde exactamente** debe preservarse la distinción presente/ausente para cada fuente (OFF, USDA, IA, catálogo local, manual), con la regla de que un valor de IA nunca es `known_*` aunque el campo esté presente en su respuesta.
3. Mueve el trabajo necesario para que eso sea cierto de "recomendado" a **bloqueante para la activación** (Nivel 2), porque sin él PR3 puede etiquetar como fiable un dato que nunca lo fue — la contradicción exacta que motivó esta ronda.
4. Amplía la ruta bloqueante, los archivos por PR y los casos de aceptación en consecuencia.

**Historial de correcciones**:
- v1→v2: (1) un valor histórico numérico no implica `known_*` — se introdujo `legacy_unlabeled`; (2) se separó "seguro" de "activable"; (3) se explicó cómo el gate neutraliza el bug de `CookModal`/`qtyOverrides`; (4) se sustituyó el `disabled` de UI por un guard síncrono real (`IntentGuard`); (5) se especificó la restricción persistente para propuestas pendientes.
- v2→v3 (esta ronda): (6) se identifican y corrigen los puntos de captura (no solo de consumo) donde un cero declarado y un campo ausente pueden confundirse antes de llegar siquiera a `macrosForQuantity`; (7) se corrige el inventario de escritores reales de `foodLog` (8 sitios, no 2); (8) se añade el caso de datos sintéticos de demo (`seedHistorico`) como un riesgo de integridad distinto que el gate debe excluir por completo, no solo tratar con baja confianza.

---

## 0. Sobre el documento de requisitos citado

Se buscó el documento **"FoodOS · Comida, nutrientes y finanzas v2"** en todo el repositorio (los 15 `docs/*.md`, `README.md`, `supabase/schema.sql`, y el texto completo de los dos PDFs vía `pdftotext`). No existe. Este diseño trata las secciones A–G especificadas por el usuario como el requisito autoritativo, verificado contra el código real con cita `archivo:línea`. Donde el código y la documentación discrepan, gana el código.

---

## 1. Ruta crítica — corregida por segunda vez

### 1.1 La contradicción identificada y su causa raíz

La v2 definía `NutrientStatus` correctamente (§4) y decía, en la sección A: *"Ningún consumidor puede leer un `number` de nutriente sin leer también su `status`."* Pero **nunca especificaba en qué punto exacto se decide ese `status` para un valor que llega de OFF, USDA o una respuesta de IA** — asumía implícitamente que bastaba con arreglar `macrosForQuantity` (PR3) para que la cadena entera quedara honesta. Es falso: `macrosForQuantity` solo ve `item.fat` como `number | undefined` — si `item.fat` ya es `0` porque el parser de OFF hizo `n.fat_100g ?? 0` **antes** de que el valor llegara al `InventoryItem`, `macrosForQuantity` no tiene ninguna forma de saber que ese `0` no es un dato conocido. El problema no está en el punto de consumo (diario); está en el **punto de captura** (búsqueda externa, escáner, IA, lookup de ingrediente de receta) — y ese punto de captura no es uno solo.

### 1.2 Todos los caminos de captura, auditados de nuevo

Grep ampliado a `apps/web/src/components/dashboard/*.tsx` (no solo `food-lookup.ts`) confirma que el patrón `?? 0` sobre un campo de OFF/USDA/IA aparece en **cuatro lugares independientes**, y que dos de ellos tienen además un **segundo punto de colapso** al guardar:

| Archivo:línea | Qué hace | ¿Colapsa ausencia→0? |
|---|---|---|
| `food-lookup.ts:65-68` (`parseOFFProduct`) | Mapeo OFF→macros, usado por `searchOFF`/`searchOFFSuggestions` | Sí |
| `food-lookup.ts:237-239` (`searchUSDA`) | Mapeo USDA→macros | Sí |
| `BarcodeScannerModal.tsx:161-164` (`fetchProduct`) | Reimplementación propia de OFF→macros, llamada directa a `world.openfoodfacts.org`, NO reutiliza `parseOFFProduct` | Sí |
| `CreateRecipeModal.tsx:143-146` y `EditRecipeModal.tsx:132-135` (`lookupIngredient`) | Reimplementación propia de OFF→macros, vía proxy | Sí — **primer colapso** |
| `CreateRecipeModal.tsx:48-51` y `EditRecipeModal.tsx:33-36` (`ingToRecord`, el mapeo que construye el `RecipeIngredient` final a partir del estado de trabajo del formulario) | Serializa el ingrediente antes de guardarlo en la receta | Sí — **segundo colapso, independiente del primero**: aunque `lookupIngredient` preservara la ausencia, `ingToRecord` la borra otra vez con su propio `?? 0` al guardar |
| `CreateRecipeModal.tsx:119,128` y `EditRecipeModal.tsx:110,118` (ramas de catálogo local / inventario dentro de `lookupIngredient`) | `local.carbs ?? 0`, `invMatch.carbs ?? 0` | Sí — aplica incluso cuando la fuente es el catálogo local o un item de inventario, no solo OFF |
| `ai-inventory.ts:183` (`fillFoodData`, rama IA) y el resto de funciones de IA (`scanTicketImage`, `identifyFoodFromPhoto`, `estimateMealMacros`, `estimateMealFromPhoto`) | `Number(parsed.kcal ?? 0)` | Sí, y además — corrección nueva — **un valor de IA presente tampoco es `known_*`**: es una estimación de un modelo de lenguaje, nunca una medición, independientemente de si el campo vino en el JSON o no |

**Conclusión**: arreglar solo `food-lookup.ts` (como decía "PR4" en la v2) deja intactos `BarcodeScannerModal.tsx`, `CreateRecipeModal.tsx`/`EditRecipeModal.tsx` (con su doble colapso) y toda la familia de funciones de IA. Cualquiera de esos caminos puede seguir produciendo un `InventoryItem`/`RecipeIngredient` con un `0` indistinguible de un cero real, que PR3 (que solo mira si el campo es `undefined`) etiquetaría como `known_zero` sin ninguna base real. **Esto es exactamente la contradicción señalada.**

### 1.3 La corrección: un único punto de verdad por formato de fuente, no un parche por archivo

En vez de siete parches locales (uno por línea de la tabla de arriba), la corrección estructural es una **función compartida por formato de origen**, que cada uno de esos siete sitios debe llamar en vez de escribir su propio `?? 0`:

- `nutrientValueFromOff(raw: number | null | undefined): NutrientValue` — presente y numérico → `known_nonzero`/`known_zero` según el valor; ausente (`undefined`/`null`) → `unknown`.
- `nutrientValueFromUsda(raw: number | null | undefined): NutrientValue` — misma regla.
- `nutrientValueFromAi(raw: number | null | undefined): NutrientValue` — **regla distinta, nueva en esta ronda**: presente → `estimated` (nunca `known_*`, porque una IA no mide, infiere); ausente → `unknown`.
- `nutrientValueFromLocalCatalog(raw: number): NutrientValue` — **CORREGIDO en la auditoría de PR3a (ver §15): siempre `legacy_unlabeled`**, nunca `known_*`. La decisión original de esta fila ("siempre `known_nonzero`/`known_zero`, dataset curado a mano") confundía quién escribió el número con si se puede verificar de qué ficha de qué fuente salió — el catálogo atribuye sus ~200 filas EN CONJUNTO a "BEDCA / USDA / valores estándar" sin identificar la procedencia por fila, así que ningún valor individual es verificable. Ver §15 para el razonamiento completo.
- `nutrientValueFromManual(raw: number | undefined): NutrientValue` — presente → `known_*`; ausente → `unknown`.

Esta función vive en un archivo nuevo y pequeño (`apps/web/src/lib/nutrient-provenance.ts`, PR3a, §9) y **cada uno de los siete sitios de la tabla de 1.2 se reescribe para llamarla**, sin cambiar el número que ya calculan hoy (el `?? 0` puede seguir existiendo para el valor NUMÉRICO mostrado en pantalla — esto no es una migración de UI) — lo único que cambia es que, en el mismo sitio, **antes** de aplicar el `?? 0`, se captura también el `NutrientValue` real y se adjunta a un campo nuevo y aditivo (`nutrientStatus`) en `InventoryItem`/`RecipeIngredient`. El número que el usuario ve no cambia; lo que cambia es que ahora existe, junto a él, la verdad sobre si ese número es real.

### 1.4 Escritores reales de `foodLog` — inventario corregido

La v2 afirmaba "solo 2 escritores" basándose en un grep limitado a `state.tsx`. Un grep de `foodLog.push` en **todo** `apps/web/src` encuentra 8 sitios de producción (más uno de test, excluido):

| Archivo:línea | Qué registra | Origen de los macros | Tratamiento necesario |
|---|---|---|---|
| `state.tsx:2988` (`cookRecipe`) | Receta cocinada | `recipe.kcal * ratio` (incluye el bug P11 de `qtyOverrides`, v2 §1.1) | PR3: etiquetar desde `recipe.nutrientStatus` (nuevo campo) + marcar `overrides_ignored` si aplica |
| `state.tsx:3013` (`consumeInventoryItem`) | Consumo directo de inventario | `macrosForQuantity(item, qty)` | PR3: etiquetar desde `item.nutrientStatus` (nuevo campo, poblado por PR3a en el momento de captura) |
| `LogMealModal.tsx:354` | "Quick add" desde inventario con posible descuento de varios ingredientes | Igual que `consumeInventoryItem` — **reimplementación paralela de la misma lógica**, no reutiliza `actions.consumeInventoryItem` | PR3: mismo tratamiento que la fila anterior; se documenta como duplicación de lógica (mismo patrón que las 4 reimplementaciones de OFF) — no se unifica en esta fase para no ampliar el alcance, pero queda anotado como riesgo de mantenimiento en §11 |
| `LogMealModal.tsx:505` (`confirmExternal`) | Comida estimada por IA (foto/texto) — `source` forzado a `"manual"` (P6) | `estimateMealMacros`/`estimateMealFromPhoto` | PR3: **todos** los nutrientes `"estimated"`, nunca `known_*` (regla de IA de §1.3) |
| `HomeView.tsx:108` (`logPlanEntry`) | Registrar una entrada ya planificada desde el widget "Plan de hoy" | Copiado literal de `PlanEntry.kcal/protein/carbs/fat` | PR3: heredar el `nutrientStatus` de la receta/ingrediente de origen del `PlanEntry` si existe; si el `PlanEntry` es un "plato rápido" con macros tecleados a mano, `known_*`/`unknown` según si el campo se rellenó |
| `PlannerView.tsx:114` (`logEntry`, rama "plato rápido") | Igual que la fila anterior, desde la vista de planificación completa | Igual | Mismo tratamiento |
| `SettingsView.tsx:169` (`seedHistorico`) | **Genera 7 días de historial FICTICIO** con macros hardcodeados, para demo/QA | Valores inventados en el propio código (380/28/52/8 kcal, etc.) | **No es un caso de confianza baja — es un caso de EXCLUSIÓN TOTAL.** Ver §1.5, nuevo. |
| `state.tsx:110` (dentro de `normalizeState`) | Migración de una forma de datos AÚN más antigua (`consumedMeals[]` sin fecha) al `foodLog` datado actual | Copiado literal de los macros ya guardados en esa forma antigua | Mismo tratamiento que la migración de `food_log` de §7: `legacy_unlabeled` |

### 1.5 Datos sintéticos (`seedHistorico`) — confirmado como riesgo real, no hipotético

`SettingsView.tsx:155-178` (`seedHistorico`) escribe 7 días de comidas **inventadas por el propio código fuente** (nombres y macros fijos: "Avena con proteína" 380/28/52/8, etc.) directamente en `foodLog`, con una guarda de deduplicación por `(fecha, nombre)` pero sin ningún marcador que distinga esas filas de una comida real. **Confirmado en esta ronda** (grep dedicado de `isDev`/`debugMode`/`NODE_ENV`/cualquier flag en `SettingsView.tsx` → sin resultados): el botón que la dispara (`SettingsView.tsx:679-682`, `📊 Sembrar 7 días de historial`) está en el pie de Ajustes, sin ninguna restricción de acceso, junto a botones de uso normal como "Limpiar registro del día actual" — **cualquier usuario autenticado puede pulsarlo**. Esto deja de ser una hipótesis: es un hallazgo cerrado. Si un usuario real lo pulsa, Nutrition v4 podría leer una semana de "adherencia perfecta" completamente fabricada y tratarla como la dieta real del usuario.

Esto es cualitativamente distinto de `legacy_unlabeled` (dato REAL de origen incierto) — es un dato que **no representa ninguna ingesta real en absoluto**.

Regla dura: `FoodLogEntry` gana un campo aditivo `synthetic?: true`, escrito únicamente por `seedHistorico()`. **Ninguna entrada `synthetic:true` puede aportar nutrientes ni señal a `evaluateAdaptiveState`/`planWeeklyStrategy` bajo ninguna circunstancia.**

**Corrección del mecanismo de exclusión (importante, ver también §6)**: la exclusión se aplica **a nivel de entrada individual, filtrada antes de agregar por día — nunca a nivel de día completo eliminado de la ventana**. Si un día contiene una entrada sintética, esa entrada concreta se descarta de la suma; el resto de entradas reales de ese mismo día (si las hay) se conservan y se evalúan con las reglas normales. Si al descartar lo sintético no queda nada real ese día, el día pasa a contar como `unlogedDays` — **sigue ocupando un lugar en `windowDays`**, nunca se resta de él. Encoger la ventana (como decía la versión anterior de este documento) sería exactamente el error que había que evitar: convertiría, por ejemplo, una ventana de 7 días con 1 sintético y 6 reales fiables en un falso "6/6 = 100%" en vez del correcto "6/7 ≈ 0.86".

**Mitigación de producto añadida (no bloqueante para v4, ver PR11 en §9)**: dado que la función es alcanzable por cualquier usuario, se recomienda además restringir su acceso en producción (build de desarrollo únicamente, o un flag explícito), independientemente de que el filtrado de PR2/PR3 ya neutralice su efecto sobre las decisiones de v4.

### 1.6 Salvaguarda mínima de estado del alimento (crudo/cocido) — corregida por segunda vez

**No se diseña aquí un clasificador genérico/producto/plato** (eso sigue fuera de alcance). Se diseña únicamente una salvaguarda en la frontera de captura: **conservar el estado que la propia referencia ya declara cuando lo declara, y no tratar una coincidencia sin esa confirmación como si fuera fiable.**

**Corrección sobre la versión anterior de esta misma sección**: la primera versión asignaba `"not_applicable"` a todo lo que viniera de código de barras o de entrada manual, razonando que "no hay una referencia genérica alternativa con la que confundirse" (barcode) o "el usuario es su propia referencia" (manual). Es incorrecto en ambos casos:

- **Un producto identificado por código de barras SÍ puede tener una ambigüedad de estado real**: OFF declara, cuando existen, valores separados "tal como se vende" (`*_100g`) y "preparado" (`*_prepared_100g`) — un sobre de puré o una sopa en polvo declara su composición en polvo, mientras el usuario puede estar registrando la cantidad ya reconstituida con agua/leche. Marcarlo `not_applicable` habría ocultado exactamente ese caso.
- **Una entrada manual también puede portar una referencia de estado ambiguo**: si el usuario teclea "165 kcal/100g" para "Pollo" al dar de alta un ingrediente genérico (no el total de lo que comió), ese número sigue siendo una referencia por 100g sujeta a la misma ambigüedad crudo/cocido que una búsqueda externa — el hecho de haberlo escrito a mano no lo hace correcto ni resuelve el estado.

**El criterio correcto no es "de dónde vino el dato" sino "qué tipo de número es"**: `not_applicable` se reserva, exclusivamente, para cuando el valor capturado **ya representa la cantidad total tal como se consumió, y no un valor por 100 g/ración que se vaya a escalar por una cantidad después** — en ese caso no existe ninguna referencia externa con estado propio contra la que pueda haber una incompatibilidad, sea cual sea el origen del número. En todos los demás casos (cualquier referencia por 100 g/ración, venga de OFF, USDA, catálogo local, un producto escaneado o una entrada manual), el estado sí puede importar y se resuelve con las mismas reglas, nunca por defecto.

```
DeclaredFoodState = "raw" | "cooked" | "dry" | "reconstituted" | "drained" | "unspecified" | "ambiguous"
  // "ambiguous" — CORREGIDO en la auditoría de PR3a (ver §16): el texto declara
  // DOS O MÁS de estos estados a la vez (ej. "sopa deshidratada para preparar"
  // declara "dry" Y "reconstituted") — sin una regla de reducción calibrada,
  // no es seguro elegir una sobre la otra. Se trata como "unspecified" en los
  // tres resolutores de abajo (nunca "confirmed").

extractDeclaredState(text: string): DeclaredFoodState
  // léxico fijo, español + inglés (crudo/raw, cocido·cocinado·asado·frito·hervido/cooked,
  // seco·deshidratado·instantáneo·en polvo/dry, reconstituido·hidratado·para preparar/reconstituted,
  // escurrido/drained), por PALABRA/FRASE COMPLETA — CORREGIDO en la auditoría
  // de PR3a: la versión original usaba subcadena (`.includes`), así que "raw"
  // se leía dentro de "strawberry". Ahora usa límites Unicode (`\p{L}`/`\p{N}`,
  // no `\b` ASCII, para no romper tildes/ñ). Sin coincidencia → "unspecified".
  // Dos o más categorías a la vez → "ambiguous". No infiere sinónimos no listados.

FoodStateConfidence = "confirmed" | "unknown" | "incompatible" | "not_applicable"

// 1) Búsqueda genérica por texto (OFF, USDA, catálogo local):
resolveFoodStateConfidenceForGenericMatch(queryText: string, referenceText: string): FoodStateConfidence
  // cualquiera de los dos "unspecified" o "ambiguous" → "unknown"; iguales (y
  // no ambiguos) → "confirmed"; distintos → "incompatible"

// 2) Producto identificado (código de barras) — CORREGIDA por segunda vez (PR3a, ver §16):
resolveFoodStateConfidenceForProduct(): FoodStateConfidence
  return "unknown"
    // El valor que llega aquí es SIEMPRE una referencia por 100g (los sitios
    // de captura solo extraen campos "_100g") — nunca representa ya el total
    // consumido, así que "not_applicable" no es alcanzable con las señales
    // disponibles hoy. La versión anterior (primera corrección de esta
    // sección) devolvía "not_applicable" cuando NO encontraba evidencia de
    // preparación (ni *_prepared_100g ni palabras en el nombre) — error:
    // ausencia de evidencia no es evidencia de ausencia; un producto puede
    // requerir cocción sin que OFF tenga cargado ese campo. "not_applicable"
    // exigiría una señal estructural VERIFICABLE de que el número es un total
    // cerrado (p. ej. `nutrition_data_per: "serving"` con una ración = el
    // envase entero), que ningún sitio de captura actual extrae todavía.

// 3) Entrada directa (manual, o IA de comida completa):
resolveFoodStateConfidenceForDirectEntry(
  kind: "whole_intake_total" | "per_unit_reference", // ¿el número YA es el total consumido, o es un valor por 100g/ración?
  nameText?: string, // solo aplica si kind === "per_unit_reference"
): FoodStateConfidence
  if (kind === "whole_intake_total") return "not_applicable"
    // señal VERIFICABLE por construcción: el prompt de estimateMealMacros/
    // estimateMealFromPhoto pide expresamente un total de la comida completa,
    // no una composición por 100g — no hay una referencia externa por 100g
    // detrás, el número YA describe lo consumido
  return extractDeclaredState(nameText ?? "") ∈ {"unspecified","ambiguous"} ? "unknown" : "confirmed"
    // "confirmed" aquí es más débil que en (1): solo un lado (el propio usuario) declara el estado,
    // no hay una segunda fuente independiente con la que contrastarlo — se documenta como
    // una aproximación deliberada, no como una confirmación tan fuerte como la de (1)
```

**Dónde se aplica cada función**: (1) en `food-lookup.ts` (OFF/USDA) y en el catálogo local dentro de `CreateRecipeModal.tsx`/`EditRecipeModal.tsx`; (2) en `BarcodeScannerModal.tsx` — siempre `"unknown"`, ver la corrección de §16; (3) en `ai-inventory.ts` (`fillFoodData`/`scanTicketImage`/`identifyFoodFromPhoto` son `per_unit_reference` sobre el nombre identificado; `estimateMealMacros`/`estimateMealFromPhoto` son `whole_intake_total`) y en cualquier edición manual de un campo por-100g de `InventoryItem`/`RecipeIngredient` (`per_unit_reference` sobre el nombre tecleado).

**Regla dura, sin cambios**: `foodStateConfidence ∈ {"unknown","incompatible"}` nunca cuenta como fiable, sin importar que el `NutrientStatus` sea `known_nonzero`. Es un eje independiente, no un sustituto.

**Consecuencia honesta, con números — respuesta directa a "¿permitiría el gate activar v4 en la práctica?"**: la corrección de esta ronda, y la segunda corrección de §16, hacen la regla más estricta para código de barras (ya no hay ningún caso `not_applicable`, ver §16) y para manual/IA-por-100g (depende de si el nombre declara un único estado sin ambigüedad). Ventana de 7 días, dieta mixta realista:

| Día | Origen | Texto disponible | `foodStateConfidence` | ¿Fiable? |
|---|---|---|---|---|
| Lun | Búsqueda genérica | "pollo" vs "Chicken, raw" | `unknown` | No |
| Mar | Búsqueda genérica | "lentejas cocidas" vs "Lentejas cocidas" | `confirmed` | Sí |
| Mié | Código de barras | "Refresco de cola" (lata) | `unknown` | **No** — corregido en §16: ausencia de indicios de preparación no es prueba de `not_applicable` |
| Jue | Código de barras | "Sopa de sobre, sabor pollo" (`*_prepared_100g` existe) | `unknown` | No |
| Vie | Manual, ingrediente genérico | usuario teclea "Pollo" (sin estado) a 165 kcal/100g | `unknown` | No |
| Sáb | Manual, ingrediente genérico | usuario teclea "Pollo cocido" a 239 kcal/100g | `confirmed` (débil, un solo lado) | Sí |
| Dom | IA, comida completa | `estimateMealFromPhoto` da un total de 600 kcal para el plato entero | `not_applicable` (señal verificable: el prompt pide expresamente un total, no una composición por 100g) | No — sigue excluido por `NutrientStatus:"estimated"`, con independencia del estado |

De 7 días con número `known_nonzero` (Dom queda fuera por `estimated`, no por estado), cuentan como fiables: Mar, Sáb — 2 de 6. Tras la corrección de §16, código de barras deja de aportar NINGÚN día fiable por sí solo salvo que, en el futuro, exista una señal estructural verificable de "total cerrado" (hoy no existe). La conclusión práctica no cambia (una dieta de cocina casera con ingredientes genéricos sigue pudiendo quedar permanentemente por debajo del umbral) pero es ahora, de verdad, **honestamente restrictiva**: ninguna categoría deja pasar sin comprobación un caso que no puede verificar.

**Dónde queda esto en la ruta**: sigue sin proponerse relajar la regla estricta (`unknown`/`incompatible` nunca fiables) sin datos reales de calibración — se mantiene como decisión provisional en §11.

### 1.7 Ruta bloqueante corregida

**Nivel 1 — bloqueante para la SEGURIDAD** (v4 nunca decide mal; puede quedarse permanentemente inactivo):
- **PR1** — tipos puros: `NutrientStatus` (con `legacy_unlabeled`), `FoodStateConfidence` (§1.6, nuevo), `DailyIntegrityReport`, kernel de cobertura por nutriente cuya regla de "día fiable" exige AMBOS: `NutrientStatus ∈ {known_nonzero,known_zero}` Y `FoodStateConfidence ∈ {confirmed, not_applicable}` — nunca uno sin el otro. El nuevo campo `synthetic` sigue excluido por regla dura del kernel.
- **PR2** — adaptador de lectura (regla: sin metadato de PR3 → `legacy_unlabeled`; con `synthetic:true` → excluido del todo) + gate + `IntentGuard` síncrono real.

**Nivel 2 — bloqueante para la ACTIVACIÓN REAL** (ampliado en esta ronda):
- **PR3a — provenance en el punto de captura (nuevo, prerrequisito de PR3)**: función compartida `nutrientValueFrom{Off,Usda,Ai,LocalCatalog,Manual}` (§1.3) + campo aditivo `nutrientStatus` en `InventoryItem`/`RecipeIngredient` + reescritura de los 7 sitios de captura de §1.2 (incluidos los dos colapsos independientes de `CreateRecipeModal.tsx`/`EditRecipeModal.tsx`) para poblarlo. **Ampliado en esta corrección**: el mismo sitio calcula también `foodStateConfidence` (§1.6) mediante `extractDeclaredState`/`resolveFoodStateConfidence` — comparación de palabras clave entre el texto de búsqueda del usuario y el nombre/descripción de la referencia encontrada, nunca una clasificación semántica nueva. Sin esto, PR3 etiquetaría con datos ya mentirosos o mal referenciados — la contradicción que motivó esta ronda y su corrección posterior.
- **PR3 — etiquetado en el momento de escribir el diario (ampliado)**: los **8** sitios reales de §1.4, no 2. Incluye la marca `overrides_ignored` (v2, corrección 3), la exclusión `synthetic` (§1.5), y ahora también la propagación de `foodStateConfidence` a `FoodLogEntry` (§1.6).

Con Nivel 1 + Nivel 2 completos: un valor histórico o capturado antes de esta fase es `legacy_unlabeled`; un valor capturado después, si su fuente declaró explícitamente el campo (con un número, incluido cero), es `known_*`; si la fuente omitió el campo, es `unknown`; si la fuente es una IA, es como mucho `estimated`; si la fila es de demostración, queda excluida por completo; y si el estado del alimento (crudo/cocido) no puede confirmarse entre lo buscado y lo encontrado, el día no cuenta como fiable aunque el número sea `known_*` (§1.6). Ningún camino de captura auditado en esta ronda puede ya producir un `known_zero` a partir de una ausencia, ni un día "fiable" a partir de una coincidencia de identidad sin confirmar.

**Prerrequisito duro de PR9**: restricción única de propuesta pendiente (sin cambios respecto a v2, §1.5 de esa versión, renumerado aquí como parte de PR8 adelantado).

**Recomendado, no bloqueante:**
- PR4 (ahora reducido en alcance real: una vez que PR3a unifica los parsers, "corregir P2" — el `if (macros.kcal<=0) continue` de `searchOFF` que descarta un cero real como "no encontrado" — es un cambio de UX de búsqueda, no de integridad; la integridad ya la garantiza PR3a).
- PR5 (idempotencia de intención persistida entre dispositivos).
- PR10 (arreglar la aritmética de `qtyOverrides` en `cookRecipe`, no solo marcarla de baja confianza).

**Evolución posterior:** PR6, PR7, resto de PR8, resto de PR9 — sin cambios respecto a v2.

---

## 2. Diagrama del flujo actual y puntos de pérdida de información — actualizado

```
CAPTURA (siete sitios que hoy colapsan ausencia→0, uno de ellos por partida doble)
──────────────────────────────────────────────────────────────────────────────
food-lookup.ts:65-68 parseOFFProduct ─┐
food-lookup.ts:237-239 searchUSDA ────┤
BarcodeScannerModal.tsx:161-164 ──────┼──▶ [P2] Cada uno con su propio "?? 0".
CreateRecipeModal.tsx:143-146 ────────┤     PR3a: sustituir los 7 por llamadas
EditRecipeModal.tsx:132-135 ──────────┤     a nutrientValueFrom{Off,Usda}(),
CreateRecipeModal.tsx:119,128 ────────┤     preservando el NutrientValue ANTES
EditRecipeModal.tsx:110,118 ──────────┘     del "?? 0" que sigue existiendo
                                             para el número mostrado.
CreateRecipeModal.tsx:48-51 ingToRecord ──▶ [P2b] SEGUNDO colapso independiente
EditRecipeModal.tsx:33-36 ingToRecord ────▶      al serializar — PR3a debe
                                                  arreglar ESTE también, no solo
                                                  el lookup, o el primero se
                                                  deshace al guardar.
ai-inventory.ts (fillFoodData, scanTicketImage,
identifyFoodFromPhoto, estimateMealMacros,        [P4] Además: un valor de IA
estimateMealFromPhoto) ────────────────────────▶  PRESENTE tampoco es known_* —
                                                    es estimated SIEMPRE (nuevo).

RESULTADO DE LA CAPTURA
───────────────────────
InventoryItem.{kcal,protein,carbs,fat} (number, sin status)
RecipeIngredient.{kcalPer100,...} (number, sin status)
                    │
                    ▼  PR3a añade, en PARALELO, sin tocar los números:
InventoryItem.nutrientStatus? / RecipeIngredient.nutrientStatus?
   Partial<Record<NutrientKey, NutrientStatus>>

CONSUMO (8 escritores reales de foodLog, no 2 — ver §1.4)
──────────────────────────────────────────────────────────
state.tsx:2988 cookRecipe ─────────────┐
state.tsx:3013 consumeInventoryItem ───┤
LogMealModal.tsx:354 (quick add) ──────┤──▶ PR3: cada uno lee nutrientStatus
LogMealModal.tsx:505 (IA) ─────────────┤     (o "estimated" fijo si es IA, o
HomeView.tsx:108 (plan de hoy) ────────┤     "legacy_unlabeled" si no existe
PlannerView.tsx:114 (plato rápido) ────┤     el campo) y lo adjunta al
state.tsx:110 (migración consumedMeals)┘     FoodLogEntry vía client_meta.
SettingsView.tsx:169 seedHistorico ────────▶ [NUEVO] synthetic:true — EXCLUIDO
                                              por completo del gate, no solo
                                              de baja confianza (§1.5).

┌─ CONVERSIÓN DE CANTIDAD (utils.ts) ─────────────────┐
│ toGrams(): 1 mL = 1 g siempre, sin densidad.         │──▶ [P7] Sin cambios vs v2.
│ macrosForQuantity: fat=25%kcal/9 si falta.           │──▶ [P9] PR3 marca "estimated"
└────────────────────────────────────────────────────────┘     Y quantityConfidence:low.

CookModal.tsx:114 pasa qtyOverrides, state.tsx:2988   ──▶ [P11] Sin cambios vs v2 —
los ignora al calcular kcal/protein/carbs/fat.             mitigado en PR3 (overrides_ignored).

Ningún botón (CookModal.tsx:234, ConsumeModal.tsx:110-121) ──▶ [P13] Sin cambios vs v2 —
tiene guard síncrono real contra doble-submit.                mitigado en PR2 (IntentGuard).

nutrition_adjustment_proposals: sin índice único de "pending". ──▶ [P19] Sin cambios vs v2 —
                                                                     prerrequisito de PR9.
```

---

## 3. Matriz requisito → estado actual → riesgo → cambio mínimo — filas nuevas o corregidas

| # | Requisito | Estado actual (evidencia) | Riesgo para v4 | Cambio mínimo | Nivel |
|---|---|---|---|---|---|
| A1-cap | Preservar presente/ausente en el punto de CAPTURA, no solo en el de consumo | 7 sitios de `?? 0` confirmados (§1.2), 2 de ellos con doble colapso | PR3 etiquetaría como `known_*` un dato que en origen ya era una mentira silenciosa — la contradicción de esta ronda | Funciones compartidas `nutrientValueFrom*` + campo `nutrientStatus` en `InventoryItem`/`RecipeIngredient` (PR3a) | **Bloqueante — activación** |
| A1-ia | Un valor de IA nunca es `known_*` | Hoy no hay ninguna distinción — `fillFoodData`/`estimateMealMacros`/etc. producen números indistinguibles de "medidos" | v4 trataría una estimación de un modelo de lenguaje como un hecho verificado | `nutrientValueFromAi` siempre devuelve `estimated` o `unknown`, nunca `known_*` | **Bloqueante — activación** (parte de PR3a) |
| D2-escritores | Cubrir TODOS los escritores reales de `foodLog` | 8 sitios confirmados (§1.4), no 2 como decía la v2 | Cualquier sitio no cubierto seguiría produciendo entradas sin `nutrientStatus`, indistinguibles de datos reales sin etiquetar salvo por el fallback `legacy_unlabeled` (que sí las protege, pero solo si el adaptador realmente los reconoce a todos) | Ampliar PR3 a los 8 sitios | **Bloqueante — activación** |
| D2-sintético | Excluir datos de demo/QA fabricados | `seedHistorico()` (`SettingsView.tsx:169`) escribe macros inventados sin marcar | v4 podría leer una semana de adherencia perfecta fabricada como si fuera real | Campo `synthetic:true`, exclusión total (no solo baja confianza) en el kernel | **Bloqueante — seguridad** (PR1/PR2) |

*(el resto de filas de la matriz de la v2 no cambia — ver el documento completo más abajo para el conjunto íntegro.)*

---

## Secciones A–G — diseño detallado (actualizado solo en A)

### A. Valores nutricionales — regla de IA añadida

```
NutrientStatus =
  | "known_nonzero"     // medido/declarado por una fuente NO-IA, > 0
  | "known_zero"        // medido/declarado por una fuente NO-IA, exactamente 0
  | "estimated"         // derivado de otro dato conocido de la MISMA fila, O CUALQUIER valor de IA presente
  | "recipe_derived"
  | "imputed"           // prohibido en v1
  | "unknown"           // el dato no existe (value: null) — incluye un campo ausente de la fuente
  | "legacy_unlabeled"  // número presente, procedencia no verificable (anterior a PR3a/PR3)
```

**Regla dura nueva**: ninguna fuente `provider:"ai"` puede producir jamás `known_nonzero`/`known_zero`, sin excepción — ni siquiera cuando la IA declara explícitamente el campo. Esto se aplica en el punto de captura (`nutrientValueFromAi`, PR3a), no en el de consumo, precisamente para que no dependa de que cada escritor de `foodLog` se acuerde de comprobarlo.

**CORREGIDO en la auditoría de PR3a (ver §15)**: el catálogo local (`food-db.ts`) se trata como `legacy_unlabeled`, no como `known_*` — no distingue, fila por fila, un valor real de BEDCA de un "valor estándar" aproximado, y esa es precisamente la información que `known_*` estaría afirmando sin base. Decisión revertida y justificada en §15.

*(B, C, D, E, F, G sin cambios respecto a v2 — ver contratos completos en §4.)*

---

## 4. Contratos TypeScript propuestos — ampliados

```typescript
// packages/types/src/nutrient-value.ts — PROPUESTO, PR1 (bloqueante — seguridad)
// (sin cambios respecto a v2, incluye legacy_unlabeled)

export type NutrientKey = "kcal" | "protein" | "carbs" | "fat" | "fiber" | "sugars" | "salt";

export type NutrientStatus =
  | "known_nonzero" | "known_zero" | "estimated" | "recipe_derived"
  | "imputed" | "unknown" | "legacy_unlabeled";

export interface NutrientValue {
  status: NutrientStatus;
  value: number | null; // null si y solo si status === "unknown"
}

export type EnergyConsistency = "match" | "mismatch" | "not_evaluable";

export type QuantityLowConfidenceReason =
  | "missing_density" | "missing_unit_size" | "overrides_ignored" | "legacy_unlabeled";

export type QuantityResolution =
  | { status: "resolved"; grams: number }
  | { status: "unresolved"; reason: QuantityLowConfidenceReason };

// apps/web/src/lib/nutrient-provenance.ts — PROPUESTO, PR3a (bloqueante — activación, NUEVO en esta ronda)
// Un único punto de verdad por formato de fuente. Cada uno de los 7 sitios
// de §1.2 debe llamar a la función correspondiente ANTES de aplicar su
// propio "?? 0" para el número mostrado — el número no cambia, lo que se
// añade es el NutrientValue real, capturado antes de que se pierda.
//
// export function nutrientValueFromOff(raw: number | null | undefined): NutrientValue;
// export function nutrientValueFromUsda(raw: number | null | undefined): NutrientValue;
// export function nutrientValueFromAi(raw: number | null | undefined): NutrientValue;
//   // presente → "estimated" SIEMPRE (nunca known_*); ausente → "unknown"
// export function nutrientValueFromLocalCatalog(raw: number): NutrientValue;
//   // CORREGIDO en la auditoría de PR3a: siempre "legacy_unlabeled", nunca
//   // known_*. Ver §15.
// export function nutrientValueFromManual(raw: number | undefined): NutrientValue;

// apps/web/src/lib/nutrient-provenance.ts — AMPLIACIÓN, PR3a (bloqueante — activación,
// corrección sobre §13.2, corregida por segunda vez en §1.6 — salvaguarda mínima de
// estado del alimento, NO un clasificador; el criterio es "¿es una referencia por
// 100g/ración escalable, o ya es el total consumido?", nunca "de qué fuente vino")
//
// export type DeclaredFoodState =
//   | "raw" | "cooked" | "dry" | "reconstituted" | "drained" | "unspecified" | "ambiguous";
//   // "ambiguous" — CORREGIDO en la auditoría de PR3a (§16): dos o más estados
//   // declarados a la vez, sin regla segura de reducción a uno solo.
//
// export function extractDeclaredState(text: string): DeclaredFoodState;
//   // léxico fijo español+inglés, incluye señales de preparación de producto
//   // (instantáneo/en polvo/para preparar), por PALABRA/FRASE COMPLETA — CORREGIDO
//   // en la auditoría de PR3a (§16): la versión original usaba subcadena, "raw"
//   // se leía dentro de "strawberry". Sin coincidencia → "unspecified". Dos o
//   // más categorías → "ambiguous".
//
// export type FoodStateConfidence =
//   | "confirmed" | "unknown" | "incompatible" | "not_applicable";
//
// export function resolveFoodStateConfidenceForGenericMatch(
//   queryText: string, referenceText: string,
// ): FoodStateConfidence;
//   // cualquiera "unspecified"/"ambiguous" → "unknown"; iguales (únicos) → "confirmed"; distintos → "incompatible"
//
// export function resolveFoodStateConfidenceForProduct(): FoodStateConfidence;
//   // CORREGIDA por segunda vez (PR3a, §16): siempre "unknown". El valor de un
//   // producto escaneado es siempre una referencia por 100g — "not_applicable"
//   // exigiría una señal estructural verificable de "total cerrado" que ningún
//   // sitio de captura actual extrae. Ya no toma parámetros: la ausencia de
//   // evidencia de preparación NO es evidencia de "not_applicable".
//
// export function resolveFoodStateConfidenceForDirectEntry(
//   kind: "whole_intake_total" | "per_unit_reference", nameText?: string,
// ): FoodStateConfidence;
//   // "whole_intake_total" (IA de comida completa, total tecleado a mano) → "not_applicable"
//   //   (señal verificable por construcción: el prompt pide expresamente un total)
//   // "per_unit_reference" (manual/IA de un alimento por 100g) → según extractDeclaredState(nameText),
//   //   "unspecified"/"ambiguous" → "unknown"

// packages/types/src/index.ts — AMPLIACIÓN aditiva a InventoryItem/RecipeIngredient, PR3a

// InventoryItem gana:
//   nutrientStatus?: Partial<Record<NutrientKey, NutrientStatus>>
//   foodStateConfidence?: FoodStateConfidence
// RecipeIngredient gana:
//   nutrientStatus?: Partial<Record<NutrientKey, NutrientStatus>>
//   foodStateConfidence?: FoodStateConfidence
// Recipe.kcal/protein/carbs/fat — SIN nutrientStatus propio en PR3a. La
// propuesta original de esta fila ("agregado = el peor status entre sus
// ingredientes") queda RETIRADA tras la revisión: Recipe.kcal/etc pueden
// venir de un macroOverride manual que ningún RecipeIngredient refleja, o
// de una suma con ingredientes en estado idle/omitidos — combinar los
// nutrientStatus de los ingredientes ignorando esos dos casos produciría
// una confianza injustificada. Ver §16 para la clasificación conservadora
// que PR3 debe usar en su lugar.

// packages/types/src/index.ts — FoodLogEntry, ampliación PR3

// FoodLogEntry gana:
//   nutrientStatus?: Partial<Record<NutrientKey, NutrientValue>>
//   quantityConfidence?: { level: "high" | "low"; reason?: QuantityLowConfidenceReason }
//   foodStateConfidence?: FoodStateConfidence   // NUEVO — corrección sobre §13.2, ver arriba
//   synthetic?: true   // NUEVO — exclusivo de seedHistorico(), nunca presente en una ingesta real

// packages/types/src/nutrient-coverage.ts — PROPUESTO, PR1 (bloqueante — seguridad)

export interface NutrientCoverageResult {
  nutrient: NutrientKey;
  windowDays: number;
  daysWithReliableData: number;
  coverageFraction: number;
}

export interface DailyIntegrityReport {
  /** NUNCA se reduce por la presencia de entradas sintéticas — es siempre
   *  el tamaño de ventana solicitado por el caller (p.ej. 7). */
  windowDays: number;
  perNutrient: NutrientCoverageResult[];
  aggregateCoverageFraction: number;
  /** Incluye cualquier día que, TRAS filtrar sus entradas synthetic:true,
   *  se queda sin ninguna entrada real — un día 100% sintético cae aquí,
   *  no en un bucket aparte que reduzca windowDays. */
  unlogedDays: number;
  legacyUnlabeledDays: number;
  /** Puramente diagnóstico — NUNCA participa en ningún cociente. Cuenta
   *  cuántos días tuvieron al menos una entrada synthetic:true descartada
   *  durante el filtrado (independientemente de si ese día terminó siendo
   *  unlogedDays, legacyUnlabeledDays o fiable gracias a otras entradas
   *  reales del mismo día). Sirve solo para que un panel de soporte pueda
   *  explicar por qué la cobertura es la que es — no para el cálculo. */
  daysWithSyntheticEntriesFiltered: number;
}

// packages/engine/src/nutrient-coverage-kernel.ts — PROPUESTO, PR1 (bloqueante — seguridad)
// Regla dura corregida (v4 de este documento): las entradas synthetic:true
// se filtran ANTES de que el kernel reciba los datos (responsabilidad del
// adaptador de PR2, no del kernel) — el kernel en sí nunca ve una entrada
// synthetic. windowDays es siempre el solicitado por el caller, nunca se
// recalcula ni se reduce dentro del kernel. Un día que se queda sin
// entradas tras el filtrado externo se cuenta como cualquier otro día sin
// entradas (unlogedDays) — el kernel no distingue "nunca hubo nada" de
// "había algo pero era sintético"; esa distinción vive solo en el campo
// diagnóstico daysWithSyntheticEntriesFiltered, que calcula el ADAPTADOR
// (PR2), no el kernel.
//
// Regla dura AÑADIDA (v6, corrección sobre §13.2): un día cuenta como
// fiable para un nutriente solo si, ADEMÁS de NutrientStatus known_*, cada
// entrada que contribuye a ese nutriente tiene
// foodStateConfidence ∈ {"confirmed","not_applicable"} — "unknown" e
// "incompatible" nunca cuentan como fiables, sin excepción, aunque el
// número sea known_nonzero. Ver §1.6 para la consecuencia numérica de
// esta regla con las capacidades de captura de hoy.

// packages/types/src/intent-guard.ts — PROPUESTO, PR2 (bloqueante — seguridad, sin cambios vs v2)

export interface IntentGuard {
  claim(intentId: string): boolean;
  release(intentId: string): void;
}
```

*(El resto de contratos — `CompositionSnapshot`, `IntakeEvent`, `ContextualEvent`, `ActiveSubstance` — quedan sin cambios respecto a v2, PR6, evolución.)*

---

## 5. Reglas e invariantes — ampliadas

1. **Ausencia ≠ cero**, verificado en runtime.
2. **Un número guardado sin etiqueta de procedencia nunca es `known_*`** — es `legacy_unlabeled`.
3. **NUEVO — la etiqueta de procedencia se decide en el punto de captura, no en el de consumo.** `macrosForQuantity`/cualquier escritor de `foodLog` lee un `nutrientStatus` ya calculado; ninguno de ellos vuelve a mirar el número crudo para adivinar si es conocido.
4. **NUEVO — ninguna fuente de tipo IA produce `known_*`, nunca**, sin excepción, sin importar si el campo estaba presente en la respuesta.
5. **NUEVO — una entrada con `synthetic:true` queda excluida de todo cálculo de cobertura y de todo gate**, no solo tratada con baja confianza.
6. Solo `consume` escribe nutrientes (aplicable a los 8 sitios reales de §1.4, no a una lista incompleta).
7. Solo `buy` origina gasto.
8. Snapshots nunca se editan.
9. **Conversión sin inventar** — incluye la marca `overrides_ignored`.
10. **Idempotencia de intención, no de renderizado** (`IntentGuard`, no `disabled`).
11. Reconciliación de energía, nunca sustitución silenciosa fuera del caso de receta-IA-recién-generada.
12. Derivación explícita, nunca heurística.
13. Activos y nutrientes son dimensiones distintas y no convertibles.
14. El motor adaptativo nunca lee texto libre para decidir.
15. Ninguna propuesta adaptativa se genera ni acepta en producción sin la restricción persistente de unicidad.
16. Ningún reducer puede mutar `foodLog[i].kcal/protein/carbs/fat` fuera de borrado/devolución de stock.
17. **NUEVO (v6, corrección sobre §13.2) — un `NutrientStatus` conocido no implica un estado del alimento confirmado.** Una coincidencia con `foodStateConfidence ∈ {"unknown","incompatible"}` nunca cuenta como fiable en el kernel de cobertura, aunque el nutriente en sí sea `known_nonzero`/`known_zero` — son dos ejes independientes; ninguno sustituye al otro.

---

## 6. Modelo de cobertura — corregido para entradas sintéticas

**Corrección respecto a v3 (esta era la imprecisión señalada)**: v3 decía que un día `synthetic` reducía `windowDays` (de 7 a 6, en el ejemplo). Eso es exactamente lo que no debe pasar: encoger la ventana exigida hace más fácil superar el umbral de cobertura (6/6 = 100% en vez del correcto 6/7 ≈ 0.86), que es lo opuesto de lo que un dato fabricado debería producir.

**Regla corregida**: `windowDays` es siempre el tamaño de ventana solicitado (p. ej. 7) y nunca cambia. El filtrado de entradas `synthetic:true` ocurre **a nivel de entrada, no de día**, antes de agrupar por fecha:

- Ventana de 7 días: 6 días con al menos una entrada real (3 `known_*` que superan el 80%, 3 `legacy_unlabeled`), 1 día donde `seedHistorico` escribió 3 comidas fabricadas y el usuario no registró nada real ese día.
- El adaptador (PR2) descarta las 3 entradas sintéticas de ese día antes de sumar. Al quedarse sin ninguna entrada real, ese día se clasifica como `unlogedDays` — exactamente igual que si el usuario nunca hubiera abierto la app ese día.
- **Resultado correcto**: `windowDays = 7`, `unlogedDays = 1`, `legacyUnlabeledDays = 3`, cobertura fiable = 3/7 ≈ 0.43 (no 3/6 ≈ 0.50). `daysWithSyntheticEntriesFiltered = 1`, expuesto solo como dato de diagnóstico, sin participar en el cociente.

**Caso mixto (día con una entrada real y una sintética el mismo día)**: si ese mismo día el usuario SÍ registró un desayuno real de 400 kcal `known_nonzero` antes de pulsar "Sembrar historial", y `seedHistorico` no escribió una entrada duplicada por su propia guarda de `(fecha, nombre)` pero sí otras comidas distintas ese mismo día, el adaptador conserva el desayuno real (contribuye a la suma del día) y descarta solo las entradas sintéticas — el día se evalúa con el desayuno real únicamente, nunca se marca como "sintético" ni se excluye por completo solo porque comparta fecha con datos fabricados. Este caso tiene su propio test (AC20, §10) precisamente para que la implementación no colapse a "excluir el día entero" por simplicidad, que sería una regresión silenciosa de datos reales del usuario.

---

## 7. Estrategia de migración de datos existentes — ampliada

Sin cambios en los puntos 1-5 de la v2 (todo lo pre-existente en `food_log`/`inventory_items`/`recipes` se marca `legacy_unlabeled`, nunca `known_*`, nunca backfill especulativo). Se añade:

6. **La migración `consumedMeals[]→foodLog` de `state.tsx:110`** (dentro de `normalizeState`) es en sí misma una migración de datos legacy, no una captura nueva — sus entradas se marcan `legacy_unlabeled` igual que cualquier fila `food_log` anterior a PR3, con independencia de cuándo se ejecute esa migración en el cliente.
7. **`seedHistorico()` no se migra — se excluye.** No aplica ninguna regla de "confianza baja"; si alguna vez se detecta una fila con el patrón de nombres/macros hardcodeados de `SettingsView.tsx:157-160` en datos de producción, debe tratarse como lo que es (dato de demostración, no ingesta real), nunca como histórico legítimo de baja confianza.

---

## 8. Puertas obligatorias antes de activar Nutrition v4 — ampliadas

1. Gate de cobertura: `aggregateCoverageFraction ≥ 0.85` Y cobertura por nutriente por encima de umbral, calculados siempre sobre `windowDays` completo (nunca reducido) — ninguno alcanzable sobre `legacy_unlabeled`, y **una entrada `synthetic` nunca aporta al numerador, pero su día sigue contando en el denominador** (corregido — ver §6, un día sintético no debe facilitar superar el umbral). **Ampliado (v6)**: tampoco alcanzable con `foodStateConfidence ∈ {"unknown","incompatible"}` — ver §1.6 para la consecuencia práctica de esta condición adicional.
2. Gate de snapshot/confianza: `legacy_unlabeled` y ausencia de dato cuentan como `quantityConfidence:"low"` automáticamente.
3. Gate de propuesta única: restricción persistente antes de PR9 (sin cambios).
4. Gate de evento contextual sin resolver.
5. Gate de reconciliación energética.
6. Gate de idempotencia de intención (`IntentGuard`, no `disabled`).
7. **Gate de procedencia en captura — nuevo**: ningún dato con `dataSource:"ai"` puede llegar al kernel de cobertura marcado como `known_*` — verificado por test (AC14, §10), no solo por el tipo.
8. **Gate de exclusión sintética — corregido**: ninguna entrada `synthetic:true` puede contribuir a `aggregateCoverageFraction` ni a ningún `NutrientCoverageResult`, pero el día que la contenía sigue contando en `windowDays` (como `unlogedDays` si no queda nada real, o evaluado solo sobre sus entradas reales restantes si las hay) — nunca se reduce la ventana exigida.
9. **Gate de estado del alimento — nuevo (v6)**: ninguna entrada con `foodStateConfidence` distinto de `"confirmed"`/`"not_applicable"` puede contribuir a `known_*` a efectos de cobertura, aunque su `NutrientStatus` sea `known_nonzero`/`known_zero` — verificado por AC22-AC26 (§10), no solo por el tipo. Dado que hoy la mayoría de las coincidencias genéricas caen en `"unknown"` (§1.6), este gate puede mantener permanentemente "no evaluable" a un usuario cuya dieta es mayoritariamente cocina casera con ingredientes genéricos — es una consecuencia aceptada de la regla estricta pedida, no un error del diseño.
9. Gate de esquema: los tipos y el adaptador deben existir y estar probados antes de que producción los lea.

---

## 9. Secuencia de PRs — corregida con el alcance real

### Nivel 1 — Bloqueante para la seguridad

**PR1 — Tipos puros + kernel de integridad**
- Archivos: `packages/types/src/nutrient-value.ts` (incluye ahora `DeclaredFoodState`/`FoodStateConfidence`, §4), `packages/types/src/nutrient-coverage.ts` (incluye `daysWithSyntheticEntriesFiltered`, puramente diagnóstico), `packages/types/src/index.ts` (barrel), `packages/engine/src/nutrient-coverage-kernel.ts` (el kernel NUNCA ve `synthetic` — recibe entradas ya filtradas por el adaptador de PR2 y trata cualquier día vacío como `unlogedDays`, sin distinguir por qué está vacío; `windowDays` es siempre el solicitado, nunca se recalcula dentro del kernel; la regla de "día fiable" exige `NutrientStatus known_*` Y `FoodStateConfidence ∈ {confirmed, not_applicable}` simultáneamente), `packages/engine/src/nutrient-coverage-kernel.test.ts` (incluye el fixture de §1.6: mismo nutriente `known_nonzero`, distinto `foodStateConfidence`, distinto resultado de fiabilidad), `packages/engine/src/index.ts`.
- Dependencias: ninguna.

**PR2 — Adaptador de lectura + gate + guard real de intención**
- Archivos: `apps/web/src/lib/nutrition-v4-adapter.ts` (nuevo — dos responsabilidades nuevas respecto a v3: (a) sin `nutrientStatus` de PR3 → `legacy_unlabeled`; (b) **filtrar toda entrada `synthetic:true` de `foodLog` a nivel de ENTRADA, antes de agrupar por día, antes de llamar al kernel de PR1 o a `calcIntakeCoverage` v3.1 — nunca eliminar un día completo de `windowDays`**, y calcular `daysWithSyntheticEntriesFiltered` como conteo diagnóstico aparte), `apps/web/src/lib/nutrition-v4-adapter.test.ts` (incluye el caso "ventana de 7 días, 1 día 100% sintético → 6 reales + 1 unlogedDays, `windowDays` sigue siendo 7" y el caso "día con una entrada real + una sintética → solo la real cuenta, el día no se marca unloged"), `apps/web/src/lib/intent-guard.ts` (nuevo), `apps/web/src/components/dashboard/CookModal.tsx` (editar), `apps/web/src/components/dashboard/ConsumeModal.tsx` (editar).
- Dependencias: PR1.

### Nivel 2 — Bloqueante para la activación real (ampliado)

**PR3a — Provenance en el punto de captura (NUEVO en esta ronda, prerrequisito de PR3)**
- Archivos:
  - `apps/web/src/lib/nutrient-provenance.ts` (nuevo — las 5 funciones compartidas de §4, **más `extractDeclaredState` y las tres funciones `resolveFoodStateConfidenceFor{GenericMatch,Product,DirectEntry}`**, corregidas en §1.6/§4 — no una sola función genérica por "origen").
  - `apps/web/src/lib/food-lookup.ts` (editar `parseOFFProduct` líneas 65-68 y `searchUSDA` líneas 237-239 para llamar a las funciones compartidas de `NutrientValue`; **búsqueda genérica de texto → `resolveFoodStateConfidenceForGenericMatch`**; **resultado identificado por código → `resolveFoodStateConfidenceForProduct`, comprobando además si `nutriments` contiene alguna clave `*_prepared_100g`**).
  - `apps/web/src/components/dashboard/BarcodeScannerModal.tsx` (editar `fetchProduct`, líneas 161-164 — sustituir su mapeo propio por `nutrientValueFromOff` + `resolveFoodStateConfidenceForProduct`, matando de paso la duplicación P3 para este archivo; **ya no fija `"not_applicable"` a ciegas** — y tras la corrección de §16, tampoco lo infiere de la ausencia de indicios: siempre `"unknown"`).
  - `apps/web/src/components/dashboard/CreateRecipeModal.tsx` (editar `lookupIngredient`, líneas 112-155, Y `ingToRecord`, líneas 45-51 — **los dos puntos de colapso**, no solo uno; la rama de búsqueda genérica usa `resolveFoodStateConfidenceForGenericMatch`; la rama de edición manual de un ingrediente usa `resolveFoodStateConfidenceForDirectEntry("per_unit_reference", nombre)`).
  - `apps/web/src/components/dashboard/EditRecipeModal.tsx` (mismo par de ediciones, líneas 104-135 y 28-36).
  - `apps/web/src/components/dashboard/views/InventoryView.tsx` (`handleFill`, para persistir `nutrientStatus`/`foodStateConfidence`; edición manual de un `InventoryItem` existente usa `resolveFoodStateConfidenceForDirectEntry("per_unit_reference", ...)`, no `"not_applicable"` fijo).
  - `apps/web/src/lib/ai-inventory.ts` (`fillFoodData`, `scanTicketImage`, `identifyFoodFromPhoto` — todas por-100g, usan `nutrientValueFromAi` + `resolveFoodStateConfidenceForDirectEntry("per_unit_reference", nombre identificado)`; `estimateMealMacros`/`estimateMealFromPhoto` — total de la comida completa, usan `resolveFoodStateConfidenceForDirectEntry("whole_intake_total")`, `"not_applicable"` correctamente, no por defecto sino porque no hay referencia por 100g detrás).
  - `packages/types/src/index.ts` (`InventoryItem.nutrientStatus?`/`.foodStateConfidence?`, `RecipeIngredient.nutrientStatus?`/`.foodStateConfidence?`, `Recipe.nutrientStatus?`/`.foodStateConfidence?` agregado como el peor de sus ingredientes, todos aditivos).
- Dependencias: ninguna técnica (puede ir antes o en paralelo a PR1/PR2, aunque conceptualmente es parte del Nivel 2). No depende de PR3.
- Tests: por cada uno de los 7 sitios de captura, un par de casos de `NutrientValue` (campo ausente → `unknown`; campo presente con valor 0 → `known_zero`, AC14-AC17) **más** los casos de `foodStateConfidence` por las tres funciones (AC22-AC27, §10) — incluido explícitamente el caso "producto con base preparada declarada → `unknown`, nunca `not_applicable`" que motivó esta corrección.

**PR3 — Etiquetado en el momento de escribir el diario (ampliado a los 8 escritores reales)**
- Archivos:
  - `apps/web/src/lib/state.tsx` — `macrosForQuantity` (líneas 2185-2201, ahora lee `item.nutrientStatus` de PR3a en vez de inferir de `item.fat != null`), `actions.cookRecipe` (líneas 2968-3003, lee `recipe.nutrientStatus` + marca `overrides_ignored`), `actions.consumeInventoryItem` (líneas 3007-3043), y la migración `consumedMeals→foodLog` dentro de `normalizeState` (línea ~110, marca `legacy_unlabeled` sin excepción).
  - `apps/web/src/components/dashboard/LogMealModal.tsx` — el sitio de "quick add" (línea 354, lee `item.nutrientStatus` igual que `consumeInventoryItem`) y el de `confirmExternal` (línea 505, todo `"estimated"` fijo, sin leer nada de PR3a porque es directamente de IA).
  - `apps/web/src/components/dashboard/views/HomeView.tsx` — `logPlanEntry` (línea 108, hereda `nutrientStatus` del `PlanEntry` de origen).
  - `apps/web/src/components/dashboard/views/PlannerView.tsx` — `logEntry` rama "plato rápido" (línea 114, mismo tratamiento).
  - `apps/web/src/components/dashboard/views/SettingsView.tsx` — `seedHistorico` (línea 169, marca `synthetic:true` explícitamente, nunca `nutrientStatus` real).
  - `packages/types/src/index.ts` — `FoodLogEntry.nutrientStatus?`, `.quantityConfidence?`, `.foodStateConfidence?`, `.synthetic?`, todos aditivos.
- Dependencias: PR1, PR3a.

### Prerrequisito duro de PR9 — sin cambios respecto a v2

Restricción única de propuesta pendiente (índice parcial en Postgres, especificación en v2 §1.5).

### Recomendado, no bloqueante

- **PR4 (alcance reducido)** — corregir `searchOFF`'s `if (macros.kcal<=0) continue`: una vez que PR3a existe, este bug ya no compromete la integridad de datos (un cero real ya se distinguiría de una ausencia en el `nutrientStatus` capturado); lo que queda es un problema de UX de búsqueda (un alimento con 0 kcal reales no aparece en los resultados). Archivos: `food-lookup.ts:116-123`.
- **PR5** — idempotencia de intención persistida entre dispositivos.
- **PR10** — arreglar la aritmética de `qtyOverrides` en `cookRecipe`.
- **PR11 — nuevo, confirmado (ya no es una verificación pendiente)** — restringir el acceso a `seedHistorico()` (`SettingsView.tsx:155-178,679-682`) a un modo de desarrollo/QA explícito, dado que hoy es alcanzable por cualquier usuario real sin ninguna restricción. No bloqueante para v4 (el filtrado de entrada de PR2/§6 ya neutraliza su efecto sobre las decisiones de v4), pero es un hallazgo de higiene de producto independiente que conviene no dejar pendiente indefinidamente.

### Evolución posterior — sin cambios respecto a v2

PR6, PR7, resto de PR8, resto de PR9.

---

## 10. Casos de aceptación y tests necesarios — ampliados

- **AC1-AC13** — sin cambios respecto a v2 (ver historial), salvo AC10, que se generaliza: una fila `food_log` pre-existente **o migrada desde `consumedMeals[]`** se traduce a `legacy_unlabeled` en todos sus nutrientes.
- **AC14 — nuevo** — `nutrientValueFromOff(undefined)` produce `{status:"unknown", value:null}`; `nutrientValueFromOff(0)` produce `{status:"known_zero", value:0}`. Repetir para `nutrientValueFromUsda`. (PR3a)
- **AC15 — nuevo** — `nutrientValueFromAi(150)` produce `{status:"estimated", value:150}`, **nunca** `known_nonzero`, aunque el campo estuviera presente en la respuesta de la IA. `nutrientValueFromAi(undefined)` produce `unknown`. (PR3a)
- **AC16 — nuevo** — Guardar una receta donde `lookupIngredient` encontró un ingrediente con `fatPer100` ausente en OFF, y el usuario no lo corrige a mano: el `RecipeIngredient` final (después de `ingToRecord`) conserva `nutrientStatus.fat === "unknown"`, no `"known_zero"` — test específico para el segundo punto de colapso de `CreateRecipeModal.tsx`/`EditRecipeModal.tsx`. (PR3a)
- **AC17 — nuevo** — Los 8 sitios de §1.4, uno por uno: cada `foodLog.push` real (no el de test) produce una entrada con `nutrientStatus` no vacío, salvo `seedHistorico`, que produce `synthetic:true` sin `nutrientStatus`. (PR3)
- **AC18 — corregido** — Una ventana de 7 días con 1 día donde TODAS las entradas son `synthetic:true` y 6 días reales (3 `known_*` fiables, 3 `legacy_unlabeled`) produce `windowDays === 7` (nunca 6), `unlogedDays === 1` (el día sintético, tras filtrarse, se queda sin entradas reales), y `coverageFraction` por nutriente `=== 3/7`, nunca `3/6`. Este test reemplaza al AC18 original de la v3, que afirmaba lo contrario (`windowDays` efectivo de 6) — se conserva la numeración para dejar constancia del error corregido. (PR1/PR2)
- **AC19 — nuevo** — Un `InventoryItem` con `dataSource:"ai"` nunca produce, en ningún `FoodLogEntry` derivado de él, un `nutrientStatus` con valor `known_nonzero`/`known_zero` para ningún campo. (PR3a + PR3, test de extremo a extremo)
- **AC20 — nuevo** — Un día con una entrada real (`known_nonzero`, 400 kcal) y una entrada `synthetic:true` distinta ese mismo día conserva la entrada real en la suma del día (400 kcal, evaluado con las reglas normales de fiabilidad) y descarta solo la sintética — el día NO se marca `unlogedDays` ni se excluye por completo solo por compartir fecha con un dato fabricado. (PR2, caso mixto de §6)
- **AC21 — nuevo** — El botón "📊 Sembrar 7 días de historial" (`SettingsView.tsx:680`) sigue siendo visible/funcional tras PR3 (no se elimina en esta fase), pero toda entrada que produce lleva `synthetic:true` y ninguna de ellas aparece jamás con `nutrientStatus` real. (PR3)
- **AC22 — nuevo** — Buscar "pollo" (sin declarar estado) y encontrar "Chicken, raw" (USDA, declara "raw") produce `foodStateConfidence:"unknown"` — ni `"confirmed"` ni `"incompatible"`, porque solo un lado declara estado. (PR3a)
- **AC23 — nuevo** — Buscar "lentejas cocidas" (declara "cooked") y encontrar "Lentejas cocidas" en el catálogo local (declara "cooked") produce `foodStateConfidence:"confirmed"`. (PR3a)
- **AC24 — nuevo** — Buscar "pollo asado" (declara "cooked") y encontrar "Chicken, raw" (declara "raw") produce `foodStateConfidence:"incompatible"` — y ese resultado, aunque su `NutrientStatus` sea `known_nonzero`, nunca cuenta como fiable en el kernel de cobertura (PR1). Este es el caso de prueba central de la corrección de §13.2/§1.6.
- **AC25 — corregido por segunda vez (§16)** — Un producto escaneado por código de barras llamado «Pechuga de pollo», SIN base `*_prepared_100g` en la fuente y sin ninguna palabra de preparación en el nombre, produce `foodStateConfidence:"unknown"`, **nunca** `"not_applicable"` — la ausencia de indicios de preparación no es una prueba de que no haga falta preparación. (PR3a, `resolveFoodStateConfidenceForProduct`; este AC sustituye a la versión anterior, que exigía exactamente lo contrario)
- **AC25b — corregido (§16)** — Un producto escaneado CON base `*_prepared_100g` declarada en la fuente (p. ej. una sopa de sobre) produce `foodStateConfidence:"unknown"` — igual que sin ella (AC25): ambos casos son `"unknown"` hoy, no hay una tercera categoría que los distinga con las señales disponibles.
- **AC25c — corregido (§16)** — Un producto escaneado sin base `*_prepared_100g` pero cuyo propio nombre contiene una palabra de preparación (p. ej. "puré instantáneo") produce `foodStateConfidence:"unknown"`, nunca `"confirmed"` — no hay un segundo lado independiente con el que contrastar el nombre del propio producto.
- **AC25d — nuevo** — Una entrada manual de un ingrediente genérico (`per_unit_reference`) sin estado en el nombre tecleado (p. ej. "Pollo") produce `"unknown"`; con un ÚNICO estado tecleado sin ambigüedad (p. ej. "Pollo cocido") produce `"confirmed"`; con dos estados en conflicto (p. ej. "Pollo crudo o cocido") produce `"unknown"`, no elige uno. (PR3a, `resolveFoodStateConfidenceForDirectEntry`)
- **AC25f — nuevo (§16)** — `extractDeclaredState("strawberry")` produce `"unspecified"`, no `"raw"` — coincidencia de palabra completa, no de subcadena. `extractDeclaredState("sopa deshidratada para preparar")` produce `"ambiguous"` (declara "dry" y "reconstituted" a la vez) y ese resultado se trata como `"unspecified"` en los tres resolutores de `foodStateConfidence` — nunca `"confirmed"`. (PR3a)
- **AC25e — nuevo** — Una estimación de IA para una comida completa (`estimateMealMacros`/`estimateMealFromPhoto`, `whole_intake_total`) produce `foodStateConfidence:"not_applicable"` — correcto porque no hay una referencia por 100g detrás, no por defecto de origen; sigue excluida de "fiable" por su `NutrientStatus:"estimated"`, con independencia de este resultado. (PR3a)
- **AC26 — nuevo, prueba de la consecuencia documentada en §1.6** — Una ventana de 7 días compuesta enteramente por coincidencias genéricas donde ninguna de las dos partes (búsqueda del usuario, referencia encontrada) declara estado produce `coverageFraction = 0` para todos los nutrientes pese a que las 7 entradas son `known_nonzero` — demuestra en forma de test, no solo en prosa, que el gate puede dejar a un usuario de cocina casera permanentemente en "no evaluable" bajo la regla estricta pedida. (PR1, fixture de calibración — no es un fallo del kernel, es el comportamiento especificado)

---

## 11. Decisiones cerradas, provisionales y abiertas — ampliadas

**Cerradas (además de las cinco de v2):**
- **Nueva** — la procedencia se decide en el punto de captura (PR3a), no se infiere en el punto de consumo (PR3) a partir del valor numérico ya colapsado.
- **Nueva** — ninguna fuente de IA produce jamás `known_*`, sin excepción.
- **Nueva** — hay 8 escritores reales de `foodLog`, no 2; los 8 quedan enumerados y cubiertos en PR3.
- **Nueva** — un dato sintético de demo (`seedHistorico`) se filtra a nivel de entrada (nunca de día completo) y nunca reduce `windowDays` — un día sintético no debe facilitar superar el umbral de cobertura.
- **Nueva (v4)** — `seedHistorico()` es confirmadamente alcanzable por cualquier usuario real en producción, sin restricción — ya no es una pregunta abierta. Se añade PR11 (recomendado, no bloqueante) para restringir su acceso en el producto.
- **Corregida (PR3a, ver §15)** — el catálogo local (`food-db.ts`) se trata como `legacy_unlabeled`, no como `known_*`. La v6 lo cerraba como `known_*` razonando que es "un dataset curado a mano, no una API que pueda omitir un campo" — ese razonamiento confundía quién escribió el número con si se puede verificar de qué ficha de qué fuente salió; como el catálogo atribuye sus filas a "BEDCA / USDA / valores estándar" EN CONJUNTO, sin procedencia por fila, ningún valor individual es verificable. Revertido con la auditoría de PR3a.

**Provisionales:** sin cambios respecto a v2 (umbrales de 80%, 1/7, 10%).

**Abiertas (además de las de v2):**
- **Nueva** — si merece la pena, en una fase posterior, unificar las reimplementaciones paralelas detectadas (`LogMealModal.tsx:354` vs `actions.consumeInventoryItem`; los 4 parsers de OFF) en una sola función, más allá de lo mínimo necesario para la integridad de datos que resuelve esta fase.
- **Corregida (v6)** — el estado del alimento (`foodState`: crudo/cocido/escurrido) como fuente de sesgo sistemático: la v5 lo dejaba como limitación aceptada, no bloqueante. Corregido: la **salvaguarda mínima** (`foodStateConfidence`, §1.6) es ahora **Nivel 2, bloqueante para la activación** (PR3a/PR3) — un `known_nonzero` con estado `"unknown"`/`"incompatible"` nunca cuenta como fiable. Lo que sigue genuinamente aplazado, sin diseñar, es el **clasificador completo** genérico/producto/plato con desambiguación semántica (más allá de la comparación de palabras clave) — eso sí excede el mandato de esta fase.
- **Provisional (nueva, v6)** — si, con datos reales de uso, conviene sustituir el corte binario de `foodStateConfidence` (`"unknown"`/`"incompatible"` nunca fiables) por una tolerancia proporcional (análoga al 25% ya usado para `energyConsistency:mismatch`), dado que la regla estricta puede dejar permanentemente "no evaluable" a usuarios de cocina casera con ingredientes genéricos (consecuencia numérica en §1.6). No se resuelve en esta ronda porque inventar un umbral sin datos de calibración sería tan arbitrario como el problema que se corrige.

*(La pregunta sobre el alcance de `seedHistorico()` ya no está abierta — confirmada en §1.5 como alcanzable por cualquier usuario real, con PR11 como mitigación recomendada.)*

---

## 12. Clasificación: bloqueante / recomendado / evolución posterior — corregida

**Bloqueante — seguridad:**
- PR1 (con exclusión total de `synthetic`), PR2.

**Bloqueante — activación real (ampliado en esta ronda):**
- PR3a (provenance en los 7 puntos de captura, incluida la regla de IA **y la salvaguarda mínima de estado del alimento — corregido en v6, ver §1.6**) + PR3 (etiquetado en los 8 escritores reales de diario, incluida la propagación de `foodStateConfidence`).

**Prerrequisito duro de PR9:**
- Restricción única de propuesta pendiente.

**Recomendado, no bloqueante:**
- PR4 (alcance reducido tras PR3a), PR5, PR10, PR11 (restringir acceso a `seedHistorico()`, confirmado alcanzable en producción).
- **Clasificador completo genérico/producto/plato (documento externo §6, §13 P1)** — sin diseñar, sin numerar como PR, deliberadamente: excede el mandato de esta fase (clasificar antes de puntuar similitud, diccionario de conceptos en español, restricciones de estado). Distinto de la salvaguarda mínima (`foodStateConfidence`, ahora bloqueante) — este ítem es la resolución de identidad completa que la salvaguarda mínima explícitamente NO intenta construir.

**Evolución posterior:**
- PR6, PR7, resto de PR8, resto de PR9, unificación de las reimplementaciones paralelas (nueva, opcional), modelo de sobras/suplementos/finanzas completo, multipack, provenance por-campo.

---

## 13. Contraste con el documento de requisitos «FoodOS · Comida, nutrientes y finanzas v2»

El usuario facilitó el documento completo (41 apartados, actualizado 21/09/2026, auditoría estática sobre los commits `5f0f1143292d90c078c00fc4bdfe4eb92b5afb7b` y `099978d96c2219f9fecf5aafbc5c749d1329e57d`). Confirmado: se ha leído íntegro. No es el documento buscado sin éxito en §0 (que no existía en el repositorio); es un documento externo que el usuario adjuntó directamente en esta ronda.

**Primer hallazgo relevante**: el documento converge de forma independiente con partes sustanciales de este diseño, sin que haya habido contacto entre ambos hasta ahora — su propio §9 propone una `FoodReference`/instantánea con `source, sourceFoodId, sourceVersion, retrievedAt, license, foodState, edibleBasis, nutrients: valor+estado del dato`, prácticamente mi `CompositionSnapshot` (§4); su §39 propone literalmente una entidad `IntakeEvent` ("una ingesta con alimento/preparación/producto, cantidad, hora, stock y coste vinculados") y un `ContextEvent` ("inicio/cambio de rutina como anotación, sin alterar automáticamente mediciones") — coincidiendo, hasta en el nombre, con mi `IntakeEvent`/`ContextualEvent` (§D, §E) y con la regla dura de que un evento contextual nunca corrige automáticamente peso/gasto/rendimiento. Su §8 exige textualmente "null/desconocido, nunca cero automático. Cero explícito de la fuente sigue siendo cero" — es mi invariante 1 de §5, palabra por palabra. Esto no demuestra que el diseño sea correcto, pero sí que dos análisis independientes del mismo código llegaron a la misma estructura.

### 13.1 Matriz requisito → estado en esta base mínima

| Requisito del documento (apartado) | Cubierto por la base mínima | Requisito para activar Nutrition v4 (Nivel 1/2) | Aplazado |
|---|---|---|---|
| "Ausencia de un nutriente: null/desconocido, nunca cero automático" (§8) | — | **Sí — PR1 (`NutrientStatus`) + PR3a (captura)** | — |
| "fillFoodData... pierde carbohidratos y grasa" (§2) | — | **Sí — PR3a corrige los 7 puntos de captura, incluido `fillFoodData`** | — |
| "Parser OFF... convierte ausencias en cero" (§2) | — | **Sí — PR3a (`nutrientValueFromOff`)** | — |
| "macrosForQuantity puede imputar grasa como 25% sin marcar" (§2) | — | **Sí — PR3 (`estimated` + `quantityConfidence`)** | — |
| "Unificar parser de texto y escáner... mismo cálculo por ambos caminos" (§13, P0) | — | **Sí — PR3a, mismo cambio, ya lo cubre** | — |
| "Registro con instantánea de cálculo... actualizar fuente no altera consumos anteriores" (§13, P1) | **Sí — ya es cierto en el código actual (hallazgo B1, §3)** | (solo falta el test de regresión, PR2) | — |
| "Distinguir desconocido, cero declarado y estimado" en USDA/IA (§2, §35–37) | — | **Sí — PR3a, incluida la regla nueva de que la IA nunca es `known_*`** | — |
| Un `IntakeEvent` con vínculo alimento/stock/coste, sin duplicar ingesta | — | Parcial: la **frontera** (qué acción escribe qué) es PR2/PR3 (bloqueante); el **modelo completo persistido** es PR6 | Modelo completo `IntakeEvent`/`CompositionSnapshot` en Supabase (PR6/PR7) |
| Suplementos: proteína cuenta una vez, activos nunca se convierten en macros/kcal (§35, §37) | **Sí — principio ya incorporado en F (`ActiveSubstance` nunca compatible con `MacroTotals`)** | El tipo mínimo es Nivel 2 si se activa antes de tener suplementos reales; hoy no hay suplementos con macros reales en producción, así que no bloquea nada existente | Jerarquía completa `SubstanceDefinition` (padre/subcomponente, EPA/DHA dentro de grasa, forma elemental de minerales) — ver 13.2 |
| Evento contextual de creatina como anotación, nunca autocorrección (§35, §38) | **Sí — regla ya incorporada en E (`ContextualEvent`)** | Nivel 2 en la práctica (sin datos reales que anotar, el mecanismo no tiene qué proteger) | Rutinas confirmables, recordatorios, cálculo de mg/kg (§38) |
| Sobras: no asumir raciones homogéneas; `Modo A` (mezcla) / `Modo B` (componentes) (§32–34) | **La frontera que impide doble conteo es la misma, independiente del modo de reparto** | No — la frontera (D, PR6) ya es agnóstica al modo de reparto | El modelo completo de `PreparedBatch`/`PreparedComponent`/`PortionAllocation` — ver 13.2 |
| Cadena compra→lote→receta→consumo con coste transferido, no reescrito (§21, §26, §39) | Principio ya incorporado en G (`linkedExpenseId`/`costCarriedForward`/`costSnapshot`) | El vínculo mínimo es Nivel evolución (PR6), no bloqueante para v4 porque v4 no consume datos financieros | Modelo financiero completo (`Transaction`, `BudgetPeriod`, `PriceObservation`, etc., §20, §26) |
| Catálogo Ciqual/USDA con clave propia, FNDDS, CoFID, importadores (§3, §13 P1–P2) | — | No — v4 no exige un catálogo más rico para ser seguro, solo exige que lo que YA hay declare su estado honestamente | **Sí — módulos de catálogo, explícitamente fuera de esta fase desde el encargo original** |
| Cuotas, caché, proxy de búsqueda, `search-a-licious` (§5) | — | No — es una preocupación operativa/de coste, no de confianza del dato para v4 | **Sí — fuera de alcance de esta fase, ni siquiera es "evolución de v4", es infraestructura de búsqueda** |
| Finanzas completas: presupuesto único, periodos, proyecciones, importación bancaria (§17–29) | — | No — Nutrition v4 (Fase A/B, `WeeklyStrategyInput`) no tiene ningún campo financiero, ni lo tendrá con este diseño | **Sí — fuera de alcance, orthogonal a v4, no es "aplazado para v4" sino un eje de trabajo distinto** |
| Comparativa de apps de mercado y rediseño de UI de finanzas (§17–19, §24) | — | No | **Sí — diseño de producto, no de integridad de datos** |
| Estado crudo/cocido: no contar como fiable una coincidencia ambigua/incompatible (§6, §13 P0) | — | **Sí (corregido en v6) — PR3a/PR3, `foodStateConfidence`, ver §1.6** | La resolución de identidad completa (clasificador semántico genérico/producto/plato) sigue aplazada, ver 13.2 |
| DSLD como fuente de suplementos (§36) | — | No | **Sí — ya estaba explícitamente fuera de alcance en el encargo original** |
| Validación con casos de referencia (§14, §28) | Metodología ya reflejada en mis AC1–AC21 (§10), con cita archivo:línea en vez de casos genéricos | — | — |

### 13.2 Corrección posterior — la salvaguarda mínima de estado pasó a bloqueante (v6)

Esta sección documentaba originalmente (v5) una tensión sin resolver: el documento externo clasifica "Estados y cantidades explícitos" (crudo/cocido, ml/g, escurrido, multipack) como **P0**, mientras esta base dejaba el campo `foodState` completo en `CompositionSnapshot` como evolución posterior. La v5 argumentaba que un valor `known_nonzero` mal referenciado seguía siendo "honesto", solo sesgado, y por tanto no bloqueante.

**Esa distinción era incorrecta y se revierte en v6**: que un valor sea fiel a su fuente no implica que sea aplicable a la ingesta registrada, y un sesgo sistemático (pollo crudo resuelto cuando el usuario pesó pollo cocinado, 165 vs ≈239 kcal/100g) puede corromper una propuesta adaptativa igual que un cero inventado — la pregunta central de esta fase no distingue esos dos riesgos por gravedad.

**Resolución corregida**: no se construye el clasificador completo de identidad (genérico/producto/plato), que sigue excediendo el mandato de esta fase — pero sí se construye la salvaguarda mínima de frontera descrita en §1.6: conservar el estado que la propia referencia ya declara, comparar contra el estado que declara la búsqueda del usuario mediante un léxico fijo de palabras clave (no una clasificación semántica), y no contar como fiable ninguna coincidencia sin esa confirmación. Este mecanismo es ahora parte de PR3a/PR3, **Nivel 2, bloqueante para la activación** (§1.7). La consecuencia práctica de aplicar la regla con las capacidades de captura de hoy — que la mayoría de las coincidencias genéricas queden `"unknown"`, no `"confirmed"`, y que un usuario de cocina casera con ingredientes genéricos pueda no alcanzar nunca el umbral de cobertura — está documentada con un ejemplo numérico completo en §1.6, sin suavizarla.

### 13.3 Otras diferencias de alcance, sin contradicción

- El documento propone una jerarquía rica de sustancias (`SubstanceDefinition`, padre/subcomponente — EPA/DHA dentro de grasa, forma elemental de minerales, §39). Mi `ActiveSubstance{name, amountMg}` (§4) es deliberadamente plano: cubre el caso bloqueante (creatina nunca es proteína) pero no la jerarquía completa. No hay contradicción — es la misma regla ("una sustancia activa nunca se convierte en macro") aplicada con menos detalle porque los kernels de Nutrition v4 (`planWeeklyStrategy`, Fase A/B) no consumen micronutrientes ni subcomponentes, solo kcal/proteína/carbohidratos/grasa y peso.
- El documento propone `PreparedComponent`/`PortionAllocation` para repartir sobras heterogéneas por componente, no por promedio (§32–33) — un problema real (`saveDishToInventory` hoy asume homogeneidad). Mi `TransformIntakeEvent`/`ServeIntakeEvent` (§4) son agnósticos a CÓMO se reparte una porción; solo garantizan que no se cuente dos veces. La solución al reparto heterogéneo es una extensión compatible y deferida, no una corrección de la frontera de idempotencia.
- Todo lo financiero (§17–29) y de catálogo/mercado (§3–5, §17–19, §24) queda fuera de esta base no por prioridad baja, sino porque Nutrition v4, tal como está diseñado en Fase A/B (`WeeklyStrategyInput`), no consume ningún dato de esas áreas — no es "aplazado para v4", es "no aplica a v4".

### 13.4 Actualización a §11/§12 por este contraste (revisada en v6)

Tras la corrección de 13.2, la salvaguarda mínima de estado del alimento (`foodStateConfidence`) es parte de la ruta bloqueante de activación (§1.7, PR3a/PR3) — ya no figura como recomendada. Lo que permanece en "recomendado, no bloqueante" (§12) es únicamente el clasificador completo de identidad genérico/producto/plato, deliberadamente sin diseñar ni numerar como PR. La decisión abierta correspondiente en §11 pasa de "si vale la pena cerrar el sesgo" a "si conviene relajar el corte binario de `foodStateConfidence` con una tolerancia calibrada, dada la consecuencia práctica documentada en §1.6" — una pregunta de calibración, no de si la salvaguarda debe existir.

---

## 14. Conclusión breve — para decidir, no para ampliar

**Ruta mínima de PRs** (todos pequeños, aditivos, sin cambiar comportamiento observable existente):

1. **PR1** — tipos puros (`NutrientStatus`, `FoodStateConfidence`, `DailyIntegrityReport`) + kernel de cobertura por nutriente. `packages/types`+`packages/engine`, cero uso en `apps/web`.
2. **PR2** — adaptador de lectura sobre `state.foodLog` real, gate, y guard síncrono de intención (`IntentGuard`) en `CookModal.tsx`/`ConsumeModal.tsx`. No persiste nada nuevo.
3. **PR3a** — provenance en los 7 puntos de captura (`food-lookup.ts`, `BarcodeScannerModal.tsx`, `CreateRecipeModal.tsx`/`EditRecipeModal.tsx` ×2 puntos cada uno, `InventoryView.tsx`, `ai-inventory.ts`): `NutrientValue` real (nunca `?? 0` silencioso) + `foodStateConfidence` con las tres funciones de §1.6.
4. **PR3** — etiquetado en los 8 escritores reales de `foodLog` (`state.tsx` ×3, `LogMealModal.tsx` ×2, `HomeView.tsx`, `PlannerView.tsx`, `SettingsView.tsx`), incluida la exclusión `synthetic:true` y la marca `overrides_ignored` del bug de `CookModal`.

Solo estos cuatro son bloqueantes. Todo lo demás (PR4/PR5/PR10/PR11, el resto de PR6-9, el clasificador completo de identidad) es recomendado o evolución — ninguno impide que v4 decida con seguridad sobre datos reales.

**Qué logran exactamente estos cuatro PR, y qué NO logran todavía**: PR1+PR2+PR3a+PR3 preparan **datos evaluables y su lectura** — un `DailyIntegrityReport` fiable, calculado sobre `state.foodLog` real, que dice honestamente si una ventana es evaluable, provisional o no evaluable. **No generan ni aceptan ninguna propuesta adaptativa.** Eso es trabajo de PR9 (cablear `evaluateAdaptiveState`/`planWeeklyStrategy`/`evaluateAdaptiveProposalApplication` para que lean este reporte en vez de, o además de, `calcIntakeCoverage` legacy) — y PR9, específicamente para poder generar o aceptar una propuesta en producción, tiene además el **prerrequisito duro y persistente** de §1.5/§8 (índice único `nutrition_adjustment_proposals_one_pending_per_user` en Supabase). Sin ese índice, dos propuestas `pending` simultáneas siguen siendo posibles por una carrera entre dispositivos, con independencia de que los datos que las alimentan ya sean fiables gracias a PR1-3. Son dos preguntas distintas: "¿puedo confiar en leer estos datos?" (los 4 PR bloqueantes) y "¿puedo confiar en escribir una decisión basada en ellos?" (PR9 + el índice único).

**Condiciones exactas para que una ventana sea evaluable** (todas a la vez, con solo los 4 PR bloqueantes — sin que exista todavía ninguna propuesta):
- `aggregateCoverageFraction ≥ 0.85` (algoritmo kcal existente, sin cambios, `ADJUSTMENT_MIN_COVERAGE`, `nutrition.ts:1689`).
- Cobertura por nutriente por encima de umbral, contando como fiable **solo** los días donde, para ese nutriente, `NutrientStatus ∈ {known_nonzero, known_zero}` **y** `foodStateConfidence ∈ {confirmed, not_applicable}` — ambas condiciones a la vez, en todas las entradas relevantes del día.
- Ninguna entrada `synthetic:true` en la ventana contribuye a ningún cálculo (se filtra a nivel de entrada, no de día).
- Sin `energyConsistency:"mismatch"` en más del 50% de las kcal de ningún día contado como fiable.

**Condiciones adicionales para generar o aceptar una propuesta real** (más allá de que la ventana sea evaluable — requieren PR9):
- Sin propuesta `pending` ya existente (verificación de aplicación, heredada de Fase B).
- **El índice único persistente de §1.5/§8 debe existir en Supabase antes de que PR9 genere o acepte ninguna propuesta en producción** — la comprobación de aplicación por sí sola no basta, es una optimización de UX, no una garantía frente a una carrera entre dispositivos.

**De dónde sale el plazo real, corregido por segunda vez**: la versión anterior decía "menos de un año" (sin fundamento, retirada) y luego "28 días" como si fuera el único plazo relevante — impreciso, porque confundía dos hitos distintos. El parámetro base sigue siendo real y verificado: `evaluateAdaptiveState` en producción usa **`windowDays = 28`** para el cálculo de cobertura (`nutrition.ts:1856`, `const windowDays = params.windowDays ?? 28`, consumido por `calcIntakeCoverage` en la línea 1865), el mismo valor que `TREND_WINDOW_DAYS` para la tendencia de peso (`nutrition.ts:1339`). *(Los ejemplos numéricos de §1.6 y §6 usaron una ventana ilustrativa de 7 días por simplicidad pedagógica — no es el valor real de producción.)*

Con ese parámetro, hay que distinguir dos hitos que no coinciden:

- **Ventana completamente nueva** (cero días anteriores al despliegue, en el sentido estructural): requiere que hayan transcurrido los **28 días completos** desde el despliegue de PR3a/PR3 — antes de eso, toda ventana de 28 días contiene necesariamente al menos un día `legacy_unlabeled`.
- **Primera ventana que matemáticamente podría superar el gate agregado** (el único umbral con un número fijo y verificado, `ADJUSTMENT_MIN_COVERAGE = 0.85`, `nutrition.ts:1689`): no hace falta que la ventana esté completamente libre de días previos al despliegue — solo que la fracción de días fiables alcance 0,85. Con `windowDays = 28`, el mínimo de días fiables necesarios es `⌈0,85 × 28⌉ = 24`. Es decir, si los 24 días transcurridos desde el despliegue están todos perfectamente capturados (`known_*` y `foodStateConfidence` confirmado en todos ellos), una ventana con **24 días posteriores al despliegue y 4 días previos** (`legacy_unlabeled`) ya alcanza `24/28 ≈ 0,857 ≥ 0,85` — el día 24, no el día 28, es el primer momento en que el gate agregado podría, en el mejor caso, dejar de bloquear por cobertura insuficiente.

**Sobre la cobertura por nutriente, este mismo cálculo NO puede afirmarse con un número único, porque ese umbral sigue sin fijarse** (§11, provisional) — solo existe fijado el umbral de "día fiable" (80% de las kcal del día, §6.2), no el umbral de fracción de días fiables por ventana que decidiría cuántos de los 28 días hacen falta. La fórmula general es `mínimo_días = ⌈umbral × 28⌉`: con 0,85 daría 24 (igual que el agregado); con 0,80 daría 23; con 0,90 daría 26. No se afirma aquí cuál de esos aplica, porque afirmarlo sería fijar por escrito un umbral que el propio documento marca como pendiente de calibrar con datos reales.

En cualquier caso, **24 (o el número que resulte de fijar el umbral por nutriente) es un mínimo teórico bajo captura perfecta, no una expectativa realista** — depende de que cada día desde el despliegue cumpla también `foodStateConfidence` confirmado, la consecuencia ya documentada en §1.6 como poco frecuente para cocina casera genérica.

**Casos que seguirían sin ser evaluables incluso con las cuatro PR ya implementadas** (no por defecto de implementación, sino por diseño, dada la información realmente disponible hoy):
- Cocina casera con ingredientes genéricos donde ni el usuario ni la fuente declaran crudo/cocido — el caso mayoritario según la evidencia de §1.6, quedaría permanentemente `unknown`.
- Productos con base "preparado" declarada (sopas, purés, bebidas en polvo) mientras no exista una forma de confirmar qué base se usó al registrar el consumo — quedan `unknown`, no `not_applicable`, tras esta corrección.
- Cualquier ventana de evaluación (28 días, el valor real de `windowDays` en producción — ver más arriba) donde los días posteriores al despliegue de PR3/PR3a, más los `known_*`/`foodStateConfidence` confirmados que contenga, no lleguen a cubrir el umbral de cobertura — como mínimo teórico, 24 de 28 días si el umbral aplicable es 0,85 (el único fijado hasta ahora, y solo para el agregado kcal); antes del día 24 tras el despliegue es matemáticamente imposible, con cualquier umbral razonable, que exista una ventana evaluable. Los primeros 28 días son, además, el único periodo en que NINGUNA ventana puede estar completamente libre de días `legacy_unlabeled` — a partir de ahí, existir una ventana evaluable depende del uso real, no de un plazo adicional fijo.
- Usuarios con uso frecuente de `qtyOverrides` en `CookModal` sin que PR10 (arreglo de la aritmética, no bloqueante) llegue a implementarse — sus días de receta cocinada quedan `quantityConfidence:"low"` de forma permanente, no solo ocasional.

**Decisiones de producto pendientes** (no técnicas — requieren una elección del equipo, no otra ronda de diseño):
- Si la regla estricta de `foodStateConfidence` (ambiguo/incompatible nunca fiable) se mantiene indefinidamente o se sustituye, con datos reales de uso, por una tolerancia proporcional — hoy deliberadamente sin resolver (§1.6, §11).
- Si merece la pena, antes o después de activar v4, invertir en el clasificador completo de identidad genérico/producto/plato (documento externo §6, §13) para que la cocina casera deje de quedar sistemáticamente `unknown` — es la única palanca real para que v4 sirva a ese perfil de usuario, y es una decisión de alcance/inversión, no de este diseño.
- Si se restringe `seedHistorico()` (PR11) antes de activar v4 o se deja para después, dado que su efecto sobre v4 ya queda neutralizado por el filtrado de PR2/PR3 independientemente de cuándo se restrinja el acceso.
- Si el vínculo financiero/de sobras/suplementos (PR6, evolución) se prioriza en paralelo a la activación de v4 o después — no depende técnicamente de v4, es una decisión de secuenciación de producto.

No se ha ampliado el alcance de esta ronda para responder a estos puntos ni se ha implementado ningún cambio de código.

---

## 15. Corrección durante la implementación de PR3a — catálogo local: `known_*` → `legacy_unlabeled`

Este documento cerraba (§1.3, §4, §11) que el catálogo local (`food-db.ts`) debía tratarse siempre como `known_nonzero`/`known_zero`, justificado como "un dataset curado a mano, no una respuesta de API que pueda omitir un campo en tiempo de ejecución". Al auditar `food-db.ts` línea a línea, antes de escribir el resolutor real, esa justificación resultó ser el criterio equivocado.

**Por qué era el criterio equivocado**: `known_*` no afirma "alguien escribió este número a mano" — afirma "se puede confiar en la magnitud y en de dónde vino". El comentario del propio archivo (`food-db.ts:16-17`, sin cambiar en esta corrección salvo para documentar esta decisión) atribuye las ~200 filas **en conjunto** a "BEDCA / USDA / valores estándar", sin ningún campo que identifique, fila por fila, cuál de esas tres fuentes originó un `carbs`/`fat` concreto. Que el campo sea siempre numérico (`FoodEntry.carbs`/`FoodEntry.fat` no son opcionales) demuestra que el archivo siempre tiene *algún* número — no demuestra que ese número sea una medición verificable. Confundir "el campo nunca está vacío" con "el valor es fiable" es exactamente el tipo de colapso de información que todo el diseño de Nutrition v4 existe para evitar en las fuentes externas; aplicar un criterio distinto (y más permisivo) al catálogo local solo porque es interno no tenía una base real.

**La corrección**: todo valor procedente del catálogo local se clasifica como `"legacy_unlabeled"` — la definición ya existente de ese estado ("número presente, procedencia no verificable... puede venir de datos anteriores al etiquetado de procedencia", `packages/types/src/nutrient-value.ts`) cubre este caso con precisión, sin necesitar un octavo valor de `NutrientStatus` ni reabrir el kernel ya cerrado de PR1. `legacy_unlabeled` nunca equivale a `known_*` en ningún cálculo posterior (PR3, cobertura) — es, deliberadamente, una categoría de menor confianza.

**Qué NO cambia**: ningún número de `food-db.ts` se modifica; el `FoodEntry` sigue teniendo exactamente los mismos campos; los sitios de captura (`food-lookup.ts`, `ai-inventory.ts`, `InventoryView.tsx`, `CreateRecipeModal.tsx`, `EditRecipeModal.tsx`) siguen mostrando el mismo número que antes de PR3a. Lo único que cambia es el metadato que ahora lo acompaña.

**Qué haría falta para elevarlo en el futuro**: una auditoría manual, ficha a ficha, de las ~200 entradas de `FOOD_DB`, añadiendo un campo de origen real por fila (p. ej. `source: "bedca:12345"` o `source: "usda:fdc-167762"`) que permita distinguir un valor verificado de BEDCA/USDA de un "valor estándar" aproximado. Es trabajo de catalogación, no de ingeniería, y queda fuera del alcance de PR3a — anotado aquí como el trabajo pendiente concreto, no como una vaguedad.

**Alcance de esta corrección**: solo afecta `NutrientStatus` (procedencia por nutriente). No afecta `foodStateConfidence` (§1.6) — la resolución de `resolveFoodStateConfidenceForGenericMatch` para coincidencias del catálogo local (comparar el texto buscado contra `FoodEntry.name`) ya era, y sigue siendo, independiente de esta decisión: ambos ejes son ortogonales por diseño (ver la definición de `FoodStateConfidence`), y un valor `legacy_unlabeled` puede perfectamente tener `foodStateConfidence:"confirmed"` si el texto de búsqueda y el nombre de la ficha declaran el mismo estado (ver AC23, §10, sin cambios).

---

## 16. Segunda ronda de correcciones sobre PR3a — revisión tras la primera entrega

La revisión de la primera entrega de PR3a encontró tres casos donde el código todavía podía presentar una confianza injustificada, y pidió dejar resuelta en el diseño la clasificación de los totales de `Recipe` para PR3. Las tres correcciones de código ya están implementadas en el mismo worktree de PR3a (no una entrega nueva); esta sección documenta el razonamiento para que quede trazable, igual que §15.

### 16.1 Edición de inventario (`EditInventoryModal.tsx`) — no auditado en la primera entrega de PR3a

La primera entrega de PR3a enumeró los sitios de CAPTURA (búsqueda OFF/USDA, escáner, recetas, catálogo local, IA) pero no incluyó la EDICIÓN de un `InventoryItem` ya guardado. `EditInventoryModal.tsx` permite cambiar `kcal`/`protein` y, antes de esta corrección, conservaba sin más el `nutrientStatus` que el item ya tenía — así que un valor `known_nonzero` procedente de OFF que el usuario reemplazaba a mano por un número inventado seguía atribuyéndose a la lectura original de OFF.

**Corrección**: `save()` ya distinguía, para otro propósito (limpiar el aviso de IA sin revisar), si `kcal`/`protein` habían cambiado de verdad comparando el valor final del formulario contra `item.kcal`/`item.protein` originales. Se reutiliza exactamente esa misma comparación, por campo: si `kcal` cambió, `nutrientStatus.kcal` pasa a `known_*` (vía `manualStatusFromValue`, la misma función que ya usan los demás sitios de entrada manual); si no cambió, se conserva tal cual. `protein` se trata de forma independiente. Ningún otro campo de `nutrientStatus` (carbs/fat/salt/fiber/sugars) se toca nunca aquí — este modal no tiene inputs para ellos. Abrir y guardar sin tocar `kcal` ni `protein` no añade ni modifica ninguna clave: un item sin `nutrientStatus` previo sigue sin tenerlo después.

### 16.2 `resolveFoodStateConfidenceForProduct` — ausencia de evidencia tratada como prueba

La función original devolvía `"not_applicable"` cuando NO encontraba ni un campo `*_prepared_100g` en la fuente ni una palabra de preparación en el nombre del producto. Es el mismo error de razonamiento, en otro sitio, que motivó la primera corrección de §1.6 (v6): **ausencia de evidencia no es evidencia de ausencia**. Un producto escaneado puede requerir cocción perfectamente sin que Open Food Facts tenga cargado el campo `*_prepared_100g` para esa ficha concreta — el dato es crowdsourced e incompleto; no encontrar la señal no confirma que no exista.

Más allá de ese error puntual, la auditoría encontró algo más estructural: el valor que llega a esta función es **siempre** una referencia por 100 g — los sitios de captura que la llaman (`food-lookup.ts`, `BarcodeScannerModal.tsx`) solo extraen campos con sufijo `_100g`. Por definición, un valor por 100 g necesita escalarse por la cantidad realmente consumida antes de poder ser "el total tal como se consume" — el único criterio que el propio §1.6 fija para `not_applicable`. Con las señales que el código maneja hoy, `not_applicable` no es simplemente infrecuente para un producto escaneado: es **inalcanzable de forma verificable**.

**Corrección**: `resolveFoodStateConfidenceForProduct()` ya no toma parámetros y siempre devuelve `"unknown"`. `hasSeparatePreparedBasis` (existencia de un campo `*_prepared_100g`) se mantiene como una función propia y probada (`offHasSeparatePreparedBasis`) porque sigue siendo un hecho real y verificable sobre la fuente — pero hoy ningún resolutor puede tomar una decisión segura únicamente a partir de él, así que no se usa para producir `not_applicable` ni ninguna otra distinción. Reservar `not_applicable` para un caso genuinamente verificable exigiría una señal estructural que hoy no se extrae de ningún sitio de captura — por ejemplo, un campo de OFF que declare `nutrition_data_per: "serving"` con una ración que sea, además, el envase entero (así el valor reportado ya sería el total del envase, no una base por 100 g escalable). Ninguna función de este documento extrae ese campo todavía; queda anotado aquí como la señal concreta que haría falta, no como una vaguedad.

### 16.3 `extractDeclaredState` — coincidencia de subcadena, no de palabra

`includesAny` comprobaba `haystack.includes(palabra)`, así que `"raw"` se leía dentro de `"strawberry"`. **Corrección**: coincidencia de palabra/frase completa mediante límites Unicode (`(?<![\p{L}\p{N}])palabra(?![\p{L}\p{N}])`, no `\b` de ASCII, para que una tilde o una "ñ" siga contando como parte de la palabra y no cree un límite falso a mitad de un término en español).

Además, la función elegía la PRIMERA categoría que encontraba por orden de comprobación cuando un texto mencionaba más de una — un truco que dependía de que las listas de palabras no tuvieran colisiones reales, no de una regla explícita. **Corrección**: `DeclaredFoodState` gana el valor `"ambiguous"` (§4). `extractDeclaredState` ahora comprueba las 5 categorías de forma independiente y, si más de una tiene coincidencia, devuelve `"ambiguous"` en vez de elegir una por prioridad de lista — sin ninguna regla de reducción especial (ej. "reconstituido" no se prefiere sobre "seco" aunque conceptualmente el primero suceda al segundo): inventar esa regla sin datos de calibración sería exactamente el tipo de clasificador semántico que este documento excluye explícitamente de su alcance. Los tres resolutores de `foodStateConfidence` tratan `"ambiguous"` igual que `"unspecified"` — nunca `"confirmed"`.

### 16.4 Dependencia para PR3: clasificación de `Recipe.kcal/protein/carbs/fat`

La propuesta original de §4 para el agregado de `Recipe` ("nutrientStatus = el peor status entre sus ingredientes") queda **retirada**. `CreateRecipeModal.tsx`/`EditRecipeModal.tsx` permiten sobrescribir `Recipe.kcal/protein/carbs/fat` manualmente (`macroOverride`) sin que `Recipe` conserve, en ningún campo, si el total finalmente guardado procede de esa intervención o de la suma en vivo de `derivedMacros`. Combinar los `nutrientStatus` de los `RecipeIngredient` para derivar la fiabilidad del total, como proponía la línea retirada, produciría una confianza injustificada en dos casos reales: (a) el usuario sobrescribió el total a mano — los ingredientes pueden tener una procedencia excelente y no importar en absoluto, porque el número guardado no viene de ellos; (b) la suma es de ingredientes con alguno en estado `idle` (nunca buscado) — la suma es una suma PARCIAL, no del total real de la receta, aunque los ingredientes SÍ buscados sean todos `known_*`.

**Decisión — clasificación conservadora verificable para PR3, sin añadir campos a `Recipe` en esta entrega**: `Recipe` no gana un `nutrientStatus` propio en PR3a. Cuando PR3 etiquete una entrada de diario que registre el consumo de una receta (`cookRecipe`, `state.tsx:2988`), debe tratar los 4 macros de `Recipe` como `"legacy_unlabeled"` — mismo criterio que el catálogo local (§15): hay un número, pero con la información que `Recipe` conserva hoy no hay forma de verificar si procede íntegramente de ingredientes con procedencia conocida, de un `macroOverride` manual, o de una suma parcial con ingredientes omitidos. Es deliberadamente MÁS conservador que "el peor status entre los ingredientes buscados" (que ignoraría el override/la omisión), y no requiere ningún cambio de esquema.

**Elevarlo con precisión en el futuro** exigiría un campo nuevo en `Recipe`, poblado por la propia lógica de guardado de `CreateRecipeModal.tsx`/`EditRecipeModal.tsx` en el momento de `save()` — por ejemplo `macroProvenance: "derived_complete" | "derived_partial" | "overridden"`, fijado según si `macroOverride !== null` en ese momento y si todos los ingredientes con nombre no vacío llegaron a `status === "found" | "manual"`. Es exactamente el tipo de cambio de esquema que esta ronda de corrección, deliberadamente, no hace — sin conectar la web al kernel ni tocar los escritores del diario — así que queda nombrado aquí como el trabajo concreto para una entrega futura, no como una vaguedad.

**Caso de aceptación correspondiente (AC28, nuevo)**: una entrada de diario que registra `cookRecipe` para una receta cuyo `Recipe.kcal` fue fijado por `macroOverride` (no por la suma de ingredientes) produce, en PR3, `nutrientStatus:"legacy_unlabeled"` para sus 4 macros — nunca `"known_*"` derivado combinando los `nutrientStatus` de `RecipeIngredient`, aunque todos ellos sean `known_nonzero`. Prueba, en forma de test, exactamente el caso (a) de arriba: procedencia excelente en los ingredientes que NO se refleja en el total real guardado.

---

## Confirmación de cierre

- **Commit base**: `82a581c02bac2802dd4aec863c22a21f76fd755f` (`origin/main`) — confirmado sin movimiento (re-verificado con `git fetch` al cierre de esta ronda).
- **Worktree**: `wt-nutrition-v4-data-integrity`, rama `design/nutrition-v4-data-integrity`.
- **Modificaciones de implementación durante esta ronda**: cero. No se creó, editó ni borró ningún archivo de código; no se ejecutó SQL; no se realizó ninguna operación contra Supabase; no se abrió PR; no se hizo ningún commit.
