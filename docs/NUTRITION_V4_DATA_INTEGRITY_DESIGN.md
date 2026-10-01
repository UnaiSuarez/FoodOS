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

*(Histórico — describe la ronda original de diseño, cerrada antes de PR1/PR2/PR3a. Desde entonces el documento se ha ampliado durante la implementación, ver §15–§16 y «Estado actual» al final.)* No se ha ampliado el alcance de esa ronda para responder a estos puntos ni se ha implementado ningún cambio de código.

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

### 16.5 Renombrar un `InventoryItem` — `foodStateConfidence` no sobrevive a un cambio real de nombre

`EditInventoryModal.tsx` también permite editar `name`. Un `foodStateConfidence:"confirmed"` se calculó comparando el texto de la referencia original contra el nombre del alimento en ese momento, y ese texto de referencia no se conserva en `InventoryItem` — no hay forma de recalcular la comparación. Si el usuario renombra de «arroz crudo» a «arroz cocido», la composición sigue siendo la de la referencia original, pero el alimento nombrado ya no coincide con el estado al que se aplicó.

**Regla (conservadora)**: un cambio real del nombre rebaja `"confirmed"` a `"unknown"` (`foodStateConfidenceAfterRename`, `nutrient-provenance.ts`). Solo se rebaja `"confirmed"`, el único valor que afirma algo que el renombrado puede invalidar: `"unknown"` e `"incompatible"` no se elevan (renombrar no demuestra que el conflicto desapareciera), `"not_applicable"` describe el tipo de número y no depende del nombre, y una ausencia sigue siendo ausencia. Diferencias solo de mayúsculas o espacios no cuentan como cambio real. Un guardado sin cambio de nombre conserva el valor anterior tal cual.

**Caso de aceptación (AC29, nuevo)**: un `InventoryItem` con `foodStateConfidence:"confirmed"` renombrado de «arroz crudo» a «arroz cocido» queda con `"unknown"`; guardado sin tocar el nombre conserva `"confirmed"`. (PR3a)

### 16.6 Edición manual de macros — número, `nutrientStatus` y `foodStateConfidence` en sincronía

La revisión detectó que `resolveFoodStateConfidenceForDirectEntry("per_unit_reference", …)` — prevista en §1.6 para la entrada manual — solo se usaba en las funciones de IA, y que un override manual de una referencia dejaba su `foodStateConfidence` intacta. Se revisaron los cuatro sitios con eventos de edición manual de macros: `InventoryView` (formulario de alta), `CreateRecipeModal` y `EditRecipeModal` (macros por ingrediente) y `EditInventoryModal` (kcal/proteína de un item guardado).

**Principio**: cada base de evidencia cubre solo sus propios números. La comparación de una referencia (`"confirmed"` contra el nombre) certifica los números de esa referencia; el nombre declarado por el propio usuario (regla de entrada directa, más débil) certifica los que él escribió. Un único valor por item o ingrediente no puede certificar dos bases a la vez, y sustituir a mano un valor de una referencia es además indicio de desacuerdo con ella. Reglas (`nutrient-provenance.ts`, todas puras y probadas):

1. **Entrada manual nueva** (ningún número viene de una referencia): `foodStateConfidence = resolveFoodStateConfidenceForDirectEntry("per_unit_reference", nombre)` — `"confirmed"` (débil, un solo lado declara) solo si el nombre declara UN estado sin ambigüedad; si no lo declara o es ambiguo, `"unknown"`. El campo tecleado pasa a `known_*` (`known_zero` si el valor es 0); los demás no cambian.
2. **Sustitución manual de números que venían de una referencia** (búsqueda, producto, IA, catálogo): si queda algún número de la referencia sin reescribir, un `"confirmed"` previo se rebaja a `"unknown"`; nunca se eleva nada (`"incompatible"`, `"unknown"` y la ausencia se conservan). Solo si se reescriben **todos** los números que la referencia aportó (los campos con estado distinto de `"unknown"`; un hueco rellenado con 0 no cuenta como número de la referencia) se recalcula por el nombre, con el resultado independiente del orden de las ediciones. En `InventoryView` carbs/fat/sal/fibra/azúcares no se pueden teclear, así que un resultado OFF/escáner/catálogo con esos campos queda `"unknown"` tras cualquier override; con referencia de solo kcal/proteína (Completar datos) y ambos reescritos, se recalcula.
3. **`EditInventoryModal`** no conserva qué números vinieron de una referencia, así que infiere lo mínimo verificable: carbs/fat/sal/fibra/azúcares presentes solo pueden venir de una referencia; kcal/proteína vienen de una referencia si el item conserva `dataSource`; si el nombre cambió, los kcal/proteína sin reescribir se escribieron bajo el nombre anterior. Renombrar sigue rebajando `"confirmed"` a `"unknown"` (§16.5).
4. **Recarga de una receta guardada**: el origen por campo no se conserva, así que todo campo con estado real se toma como de referencia (lado conservador): editar un solo macro de un ingrediente recargado con `"confirmed"` lo rebaja a `"unknown"` aunque el ingrediente hubiera sido 100 % manual.
5. **Abrir y guardar sin editar macros ni nombre conserva los metadatos existentes.** Un item de inventario antiguo sin metadatos no adquiere ninguno. Un ingrediente de receta antiguo, al recargarse, recibe el piso `legacy_unlabeled` en sus números presentes (comportamiento de §16.2, nunca `known_*`) y ningún estado de alimento.

**Renombrar en el formulario de alta de `InventoryView`** sigue descartando toda la procedencia ya capturada (comportamiento previo): los números permanecen y quedan sin etiqueta, es decir, `unknown`. Es conservador y se documenta como límite conocido: un kcal tecleado antes que el nombre pierde su `known_*`.

**Otros dos ajustes de esta ronda**: `fillFoodData` ya no devuelve el estado de carbs/fat de OFF/USDA (`FoodNutriData` solo transporta kcal/proteína: era metadato huérfano), y el léxico de `extractDeclaredState` incluye plurales y femeninos («cocidas», «cocidos», «crudas»…) porque la coincidencia de palabra completa de §16.3 dejó de leerlos por subcadena — sin ello el propio ejemplo de AC23 («lentejas cocidas») habría dejado de dar `"confirmed"`.

**Casos de aceptación (nuevos, PR3a)**
- **AC30** — Entrada manual nueva con kcal tecleado: nombre «arroz cocido» → `foodStateConfidence:"confirmed"`; «arroz» o «sopa deshidratada para preparar» → `"unknown"`. La proteína sin teclear no tiene estado.
- **AC31** — Un resultado OFF con `"confirmed"` cuyo kcal se reescribe a mano queda `"unknown"`, con `nutrientStatus.kcal` `known_*` y el resto de la referencia intacto; si se reescriben todos los macros de la referencia (ingrediente de receta) o toda la referencia (kcal/proteína en Completar datos), se recalcula por el nombre.
- **AC32** — Un ingrediente de receta editado a mano, y una edición de kcal/proteína en `EditInventoryModal`, siguen las mismas reglas; abrir y guardar sin editar conserva los metadatos.

---

## 17. Viabilidad del gate actual — decisión pendiente antes de la integración adaptativa

Análisis con el diseño y el código tal como quedan tras PR3a (no propone construir un catálogo ni una interfaz nueva, ni relaja ningún umbral). Un día cuenta como fiable para un nutriente solo si al menos el 80 % de las kcal del día vienen de entradas con `known_*` para ese nutriente **y** `foodStateConfidence ∈ {confirmed, not_applicable}`; una sola entrada con kcal desconocidas o `legacy_unlabeled` deja el día provisional para todos los nutrientes.

| Camino de ingesta | Procedencia numérica | `foodStateConfidence` | ¿Contribuye a un día fiable? |
|---|---|---|---|
| **Catálogo local** | `legacy_unlabeled` siempre | `confirmed` solo si búsqueda y ficha declaran el mismo estado (ya con plurales); si no, `unknown`/`incompatible` | **No.** Hasta auditar ficha a ficha (§15) |
| **Producto escaneado** | `known_*` (`estimated` si la kcal viene del campo sin sufijo) | Siempre `unknown` (§16.2) | **No.** |
| **Receta cocinada** | Total como `legacy_unlabeled` (§16.4, AC28) | No aplicable a un total con posible override | **No.** |
| **IA** | `estimated` (`unknown` si el modelo omite el campo) | Comida completa `not_applicable`; por 100 g `confirmed` débil o `unknown` | **No.** `estimated` nunca es fiable |
| **Referencia OFF/USDA por texto** | `known_*` (OFF `_100g`, USDA Foundation/SR Legacy) | `confirmed` solo si ambos lados declaran el mismo estado único; si solo uno, `unknown`; si difieren, `incompatible`. Un override manual parcial lo rebaja a `unknown` (§16.6) | **Sí, en un caso minoritario:** estado declarado y coincidente en ambos lados y sin sustituir números a mano |
| **Entrada manual** (kcal/proteína de un item de inventario) | `known_*` solo del campo tecleado; el resto `unknown` | `confirmed` (débil) si el nombre declara UN estado sin ambigüedad; `unknown` en otro caso (§16.6) | **Sí, pero limitado:** solo kcal y proteína, y solo con un nombre que declare estado; carbs/fat/sal/fibra/azúcares de un item no son tecleables, así que nunca serían fiables por esta vía. Los macros tecleados en un ingrediente de receta no llegan al diario por su cuenta: el total de la receta es `legacy_unlabeled` (§16.4) |

**Lectura.** El gate es seguro — ningún camino deja pasar como fiable un número cuyo origen o estado no se pueda sostener — pero probablemente poco utilizable para muchos usuarios: la cocina casera con ingredientes genéricos (nombres sin «crudo/cocido»), los productos escaneados, las recetas y la IA no aportan ningún día fiable; solo lo hacen las coincidencias OFF/USDA con estado declarado en ambos lados y la entrada manual con estado en el nombre, ambas minoritarias. Es la consecuencia ya anticipada en §1.6 y AC26, no un fallo de implementación.

**Decisión pendiente, sin resolver en esta entrega.** Antes de la integración adaptativa hay que decidir explícitamente si se mantiene esta regla estricta, si se sustituye por una tolerancia calibrada con datos reales de uso (la decisión provisional de §11/§1.6), o si se invierte en las palancas que hoy quedan fuera: auditar el catálogo local ficha a ficha (§15), extraer de OFF una señal verificable de «total cerrado» para productos escaneados (§16.2), o el clasificador completo de identidad genérico/producto/plato (§12). **Ningún umbral se ha relajado ni se ha inventado confianza para aliviar este resultado.**

---

## 18. PR3 — etiquetado de procedencia al escribir el diario

PR3 etiqueta cada entrada que un camino real escribe en `foodLog`, en el momento de escribirla, con la procedencia que PR3a capturó en el item o el ingrediente de origen. Ningún número del diario cambia: se añade metadato junto a él. **No conecta `apps/web` con el kernel adaptativo, no genera propuestas, no cambia umbrales y no aplica SQL ni despliega nada.** El código vive en `apps/web/src/lib/food-log-provenance.ts` (reglas puras) y `food-log-entries.ts` (constructores de las entradas de los componentes).

### 18.1 Mapa real de escritores — los 8 del diseño más uno que faltaba

Verificado leyendo el código, no el documento. Cada camino de la tabla tiene una prueba que lo ejerce (los componentes, a través del componente real montado sobre el `FoodOSProvider` real) y una guarda automática (`food-log-writers.guard.test.ts`) que falla si aparece un escritor nuevo sin etiquetar.

| # | Camino real | `nutrientStatus` (kcal/protein/carbs/fat) | `foodStateConfidence` | `quantityConfidence` |
|---|---|---|---|---|
| 1 | `actions.cookRecipe` (CookModal, pestaña Receta de LogMealModal) | `legacy_unlabeled` ×4 (AC28) | `unknown` | `low`/`overrides_ignored` si `qtyOverrides` toca un ingrediente de la receta |
| 2 | `actions.consumeInventoryItem` (ConsumeModal, pestaña Inventario de LogMealModal) | lo guardado en el item; sin él, `legacy_unlabeled`; carbs/grasa que `macrosForQuantity` imputa → `estimated`; `dataSource:"ai"` nunca `known_*` (AC19) | el del item (ausente → `unknown`) | `low`/`missing_unit_size` (`ud` sin tamaño) o `low` sin motivo (carbs/grasa imputados) |
| 3 | migración `consumedMeals` en `normalizeState` | `legacy_unlabeled` ×4 | `unknown` | — |
| 4 | `LogMealModal` pestaña **Plato** (`confirmDish`) | `legacy_unlabeled` ×4 | `unknown` | — |
| 5 | `LogMealModal` pestaña **Externa** (`confirmExternal`, IA) | `estimated` por macro (`unknown` si la IA lo omitió); un macro ajustado a mano sigue `estimated`; nunca `known_*` | `not_applicable` | — |
| 6 | `HomeView.logPlanEntry` | `legacy_unlabeled` ×4 | `unknown` | — |
| 7 | `PlannerView.logEntry` (plato rápido) | `legacy_unlabeled` ×4 | `unknown` | — |
| 8 | `SettingsView.seedHistorico` | **ninguno** — `synthetic:true` | — | — |
| 9 | **`seedDemo` («Cargar datos demo»)** — no estaba en §1.4 | **ninguno** — `synthetic:true` | — | — |

Caminos que modifican una entrada sin crearla: `EditLogModal` reescala el número y conserva la procedencia (solo ajusta un estado que dejaría de ser coherente con el número, ver 18.3); cambiar el tipo de comida, borrar y deshacer no tocan los campos nuevos. Las entradas históricas sin metadatos **no se reescriben**: siguen sin ellos y se leen como `legacy_unlabeled` por ausencia.

### 18.2 Reglas aplicadas

- **AC28 / §16.4.** Un total de receta se etiqueta `legacy_unlabeled` para los cuatro macros aunque todos sus ingredientes sean `known_*` y estén confirmados: `Recipe` no conserva si el total viene de `macroOverride` o de una suma parcial. La certeza del total no se deriva de los ingredientes.
- **`overrides_ignored`.** `cookRecipe` usa `qtyOverrides` para descontar inventario pero registra `recipe.kcal × ratio`; si algún override corresponde a un ingrediente real de la receta, la entrada lleva `quantityConfidence: { level: "low", reason: "overrides_ignored" }`. No se compara contra el valor por defecto: ante la duda se marca.
- **IA de comida completa.** Todos los macros son `estimated` (o `unknown` si la IA los omitió), nunca `known_*`, y `foodStateConfidence` es `not_applicable` (AC25e). Como el modal permite ajustar los macros («puedes ajustarlos»), un macro editado sigue siendo `estimated`, y vaciar el campo (0) no lo convierte en `known_zero`.
- **Datos de demostración.** `seedHistorico` y `seedDemo` marcan cada fila `synthetic:true` y ninguna lleva procedencia real. El adaptador de PR2 las descarta por entrada, antes de agrupar por día, y la ventana no se reduce (el test siembra 7 días en una ventana de 28 y comprueba que llega intacta y que una entrada real del mismo día se conserva).
- **Pasado sin reescribir.** Ninguna entrada existente adquiere etiquetas; `normalizeState` conserva las etiquetadas y no añade nada a las que no las tienen.

### 18.3 Decisiones y desviaciones respecto al diseño original

1. **Forma de `FoodLogEntry.nutrientStatus`.** §4 proponía `Partial<Record<NutrientKey, NutrientValue>>` (estado + valor). Se implementa `Partial<Record<NutrientKey, NutrientStatus>>` (solo estado), como en `InventoryItem` y `RecipeIngredient`. Guardar el valor duplicaría el número que la entrada ya tiene y se desincronizaría al editarla; el adaptador de integración construirá el `NutrientValue` a partir del estado y del número guardado.
2. **Coherencia con el número.** El kernel exige `known_zero` ⇔ 0 y `known_nonzero` ⇒ > 0, y una sola entrada incoherente invalida la ventana entera. Un `known_nonzero` cuyo valor escalado y redondeado queda en 0 (una cantidad diminuta) pasa a `estimated`, tanto al escribir (`consumeInventoryItem`) como al reescalar (`EditLogModal`). Nunca se afirma una medición que el número guardado ya no describe.
3. **Un plato compuesto y una entrada de planificador son `legacy_unlabeled`, no una combinación de sus ingredientes.** Ni `DishIngredient` (estado del formulario de LogMealModal) ni `PlanEntry`/`QuickMeal` conservan la procedencia por ingrediente, y combinarla sería la inferencia que §16.4 retiró para las recetas. Los ingredientes de un plato o de un plato rápido tampoco pasaron por PR3a (`PlannerAddMealModal` sigue colapsando `carbs ?? 0`/`fat ?? 0`). Subirlo con precisión exigiría llevar la procedencia por ingrediente hasta el momento de registrar; es trabajo de captura análogo a PR3a, fuera del alcance de PR3.
4. **`quantityConfidence` solo se escribe cuando hay un motivo concreto de desconfianza** (`overrides_ignored`, `missing_unit_size`, o carbs/grasa imputados). PR3 nunca afirma `"high"`; su ausencia se lee como baja. `toGrams` sigue tratando 1 ml = 1 g (P7): no se marca `missing_density`, porque el inventario no registra la base (g/ml) de sus valores por 100 y no hay evidencia para hacerlo.
5. **El adaptador de PR2 no lee todavía los campos nuevos.** Sigue tratando toda entrada como `legacy_unlabeled` (más conservador que lo escrito). Leerlos exige reconciliar cada estado con el número y decidir la traducción de cada eje; es trabajo del PR de integración. Lo único que cambia en el adaptador es que `synthetic` se lee ya con tipo.

### 18.4 Hallazgos que corrigen el documento

- **`LogMealModal.tsx:354` no es «quick add desde inventario»** (§1.4): es la pestaña **Plato**, un plato compuesto por ingredientes. La pestaña Inventario pasa por `actions.consumeInventoryItem` y la de Receta por `actions.cookRecipe`, así que no son escritores adicionales.
- **Hay un noveno escritor, `seedDemo`** (`state.tsx`), que asigna `demo.foodLog = [...]` con cinco comidas ficticias; un `grep` de `foodLog.push` no lo encuentra. Ahora marca `synthetic:true` y la guarda de inventario lo cubre.
- **§1.5 sobreestimaba el acceso a `seedHistorico`.** «Cargar datos demo» y «Sembrar 7 días de historial» están dentro del bloque «Solo admin» de Ajustes (`isAdmin`: en producción con Supabase configurado solo los correos de `NEXT_PUBLIC_ADMIN_EMAILS`; sin Supabase, en modo solo-local, todo el mundo). No eran alcanzables por «cualquier usuario autenticado». El marcado `synthetic:true` sigue siendo necesario (un admin o una instalación local puede sembrar), pero PR11 queda parcialmente mitigado por el propio producto.
- **`estimateMealMacros`/`estimateMealFromPhoto` no se cablearon en PR3a**, pese a estar en su lista (§9) y en AC25e: seguían colapsando protein/carbs/fat con `?? 0` y no declaraban `not_applicable`. Se completan en PR3 (primer commit de la rama, separable): devuelven `nutrientStatus` por macro y `foodStateConfidence`, sin cambiar los números.
- **La procedencia no sobrevivía a la sincronización.** La sincronización con Supabase copia a `food_log.client_meta` una lista fija de campos; sin ampliarla, `synthetic` y las etiquetas se perderían en el primer viaje y una fila de demostración volvería como entrada real. Ver 18.5.
- **`HomeView` no puede «heredar el `nutrientStatus` del `PlanEntry`»** (§1.4): `PlanEntry` no lleva ninguno.

### 18.5 Persistencia — `food_log.client_meta`

Los cuatro campos viajan en `client_meta` (JSONB existente): **sin cambio de esquema ni SQL**. Lectura y escritura pasan por el mismo saneado (`sanitizeFoodLogProvenance`): solo salen y entran valores válidos; cualquier otra cosa se descarta y la entrada se lee como `legacy_unlabeled`, el lado conservador. El comentario de la columna en la base (que enumera las claves) no se ha actualizado: es documentación, y cambiarlo exigiría SQL. Limitaciones: un cliente antiguo que reescriba la fila (el `push` sincroniza el estado completo) descartaría las claves nuevas; y las filas ya guardadas no las tienen (no se hace backfill, §7).

### 18.6 Casos de aceptación cubiertos

AC17 (los escritores, uno por uno, más la guarda de inventario), AC19 (item de IA nunca `known_*`, incluidas todas las combinaciones de estado guardado), AC20/AC21 (filtrado por entrada, botón de demostración sigue funcionando y marca sus filas), AC25e (a nivel de estimador y de escritor) y AC28 (receta con ingredientes `known_*`).

### 18.7 Pendiente después de PR3

Integración del adaptador (leer estas etiquetas reconciliadas con el número), procedencia por ingrediente en platos compuestos y platos rápidos, y la decisión de producto de §17. Sin cambios en ninguno de los tres: ningún umbral se ha relajado.

---

## 19. La procedencia del inventario no sobrevivía a la sincronización

Hueco encontrado en la revisión de PR3, en `apps/web/src/lib/data-layer.ts`: `pushState` escribía `inventory_items` con una lista fija de columnas y `pullState` reconstruía cada `InventoryItem` desde otra lista fija; ninguna conservaba `nutrientStatus`, `foodStateConfidence` ni `dataSource` (este último tampoco se persistía antes de PR3a: solo vivía en memoria y en `localStorage`). Tras sincronizar y recargar, un item OFF/USDA/IA perdía su procedencia y consumirlo acababa `legacy_unlabeled`. Seguro, pero impedía que la captura de PR3a aportara cobertura.

### 19.1 Reproducción

Prueba de ida y vuelta `pushState` → `pullState` con un cliente falso que devuelve solo las columnas que pide el `.select()` (como PostgREST) y redondea las columnas `numeric(…,2)` como Postgres: un item OFF con valores conocidos, uno con un nutriente ausente, uno de IA, uno con `known_zero` y uno anterior a PR3a. Contra el código anterior fallaban 11 de las 15 primeras pruebas (`expected undefined to deeply equal { kcal: 'known_nonzero', … }`); las 4 que pasaban eran las que ya esperaban el comportamiento legado.

### 19.2 Esquema real, inspeccionado antes de decidir

Consultas de catálogo de solo lectura sobre el proyecto Supabase de FoodOS (sin leer datos de usuarios) y las migraciones del repositorio:

- `inventory_items` tiene 27 columnas y **ninguna JSONB** ni de procedencia. La columna `source` (`manual|barcode|photo_ai|cart|bank_ticket`, con `CHECK`) tiene otro significado y otros valores que `dataSource` (`local|off|usda|ai|manual`): reutilizarla mezclaría dos cosas y perdería información.
- RLS activado con cuatro políticas por fila; `authenticated` tiene privilegios de tabla completos (SELECT/INSERT/UPDATE/DELETE), que una columna nueva hereda. Sin cambios de política ni permisos.
- El historial de migraciones remoto coincide con las versiones del repositorio hasta `20260908120000_unit_size_dimension` (19 versiones). `supabase/schema.sql` es una línea base que ya no incluye las columnas posteriores (`salt_per_100`, `unit_size`, …); no se ha tocado.

### 19.3 Solución aditiva

Una columna **`inventory_items.nutrition_provenance jsonb`**, nullable, sin valor por defecto y sin backfill, con `CHECK` de que, si hay valor, es un objeto JSON (migración `20260924190000_inventory_nutrition_provenance.sql`, en su propio commit, **preparada y sin aplicar**). Guarda la procedencia con la propia fila:

```
{ dataSource, nutrientStatus, foodStateConfidence,
  basis: { name, unit, unitSize?, unitSizeUnit?, kcal, protein, carbs?, fat?, salt?, fiber?, sugars? } }
```

- **NULL = sin procedencia**: un item anterior a PR3a no gana ninguna (sigue `legacy_unlabeled`), y un item que la perdió escribe NULL y limpia la que hubiera.
- **Saneado en ambas direcciones** (`inventory-provenance-persistence.ts`, compartiendo los validadores con la persistencia del diario): solo salen y entran claves y estados válidos; lo demás se descarta y nunca lanza. Un `known_*` en un item de IA sigue rebajándose a `estimated` al consumir (AC19), aunque la base dijera otra cosa.
- **Frescura (`basis`)**: es la **referencia** a la que describe la procedencia, no solo los números. Al leer, si algo de ella ya no coincide con la fila —o no hay un `basis` verificable— la procedencia se descarta **entera** y el item queda `legacy_unlabeled`:
  - **Nombre.** «arroz crudo» → «arroz cocido» cambia el alimento al que se refiere un `foodStateConfidence: "confirmed"` sin tocar un número. Se compara sin distinguir mayúsculas ni espacios de más (misma regla que §16.5).
  - **Unidad, `unitSize` y `unitSizeUnit`.** Cambian cómo se interpreta la referencia por 100 (g frente a ml, gramos por unidad); cualquier cambio la invalida, incluido que el item gane o pierda un tamaño de unidad.
  - **Números, en su forma canónica de Postgres, sin banda de tolerancia.** Una banda alrededor del valor original no vale: con base `165,0051` (guardada por `numeric(7,2)` como `165,01`) y una edición antigua a `165,00`, la diferencia real es de 0,01 pero la del valor crudo es 0,0051, y una banda de 0,006 la aceptaría. El `basis` guarda el valor canónico (`165,01`) y al leer se compara la forma canónica de ambos lados con igualdad exacta: el redondeo inicial no descarta nada válido y una modificación de 0,01 sí.

`RecipeIngredient` no tiene este hueco: `customRecipes` viaja entero en `user_profiles.extra_state` (JSONB) y su procedencia sobrevive (prueba de ida y vuelta añadida).

### 19.4 Clientes antiguos

Un cliente anterior a este cambio no conoce la columna.

- **Leer:** pide una lista explícita de columnas en su `.select()`: no ve la columna nueva y no le afecta. *Verificado en el código; no ejercitado contra la base de FoodOS.*
- **Escribir:** supabase-js declara `columns` con las claves de su payload en el `upsert` (`postgrest-js`) y PostgREST genera `INSERT (esas columnas) … ON CONFLICT DO UPDATE SET col = EXCLUDED.col` **solo para ellas** (`QueryBuilder.hs`, `mutatePlanToQuery`, leído en el código fuente de PostgREST). Ese SQL exacto se ejecutó en un PostgreSQL real y aislado: la columna nueva se conserva aunque el cliente antiguo cambie el nombre y los números (§19.7). *No se ejecutó PostgREST en sí, ni la versión concreta de Supabase, ni contra la base de FoodOS.*
- **Cambiar la referencia sin tocar la procedencia** (lo que un cliente antiguo sí hace: `EditInventoryModal` cambia nombre, unidad, `unitSize`, `unitSizeUnit`, kcal y proteína): la procedencia guardada quedaría obsoleta y un cliente nuevo la seguiría afirmando. Con `basis` (§19.3) se descarta, y el siguiente `push` del cliente nuevo la limpia. Cubierto por pruebas de ida y vuelta para nombre, unidad, `unitSize`, `unitSizeUnit` y el borde del redondeo.
- **Items anteriores a PR3a:** siguen sin adquirir etiquetas, también tras una edición antigua (columna NULL).
- **Efecto secundario deseado:** `dataSource` ahora persiste, así que un item de IA sigue marcado como aproximado tras recargar o en otro dispositivo.

### 19.5 Secuencia de despliegue

1. **Aplicar la migración** `20260924190000_inventory_nutrition_provenance.sql` en Supabase y **verificar** que existe `inventory_items.nutrition_provenance` (`jsonb`, nullable) — consulta al final del propio fichero.
2. **Solo después, desplegar el código.** Referencia la columna en el `.select()` y en el `upsert` de inventario: sin ella, PostgREST rechaza la petición entera y el inventario deja de sincronizar (mismo riesgo y mismo orden que `unit_size_unit`).
3. Con la migración aplicada, el código **antiguo** sigue funcionando (compatible hacia delante); el orden inverso no es seguro. Para deshacer basta volver al código anterior; la columna puede quedarse.
4. No hay backfill: las filas existentes quedan NULL. Los items ya guardados solo ganan procedencia cuando un cliente nuevo los vuelva a escribir con ella.

### 19.6 Límites

- Un item recreado desde un snapshot del diario (`restoreInventoryQty`, al borrar una entrada que consumió el lote entero) no conserva la procedencia: `InventorySnapshot` no la lleva. Es conservador (queda `legacy_unlabeled`).
- Un item que nace de un ítem de carrito o de un plato guardado en la despensa tampoco la tiene: no pasó por captura.
- Un cambio de nombre que haga un cliente **nuevo** (no antiguo) ya lo gestiona `foodStateConfidenceAfterRename` (§16.5) y `basis` se reescribe en cada `push`.
- No se ha aplicado nada a Supabase ni desplegado nada; ninguna prueba toca una base real.

### 19.7 Verificación en un Postgres aislado

`supabase/verification/inventory-nutrition-provenance/` (PGlite: PostgreSQL 18.3 en WebAssembly, en memoria, sin datos de nadie; el proyecto de FoodOS usa 17.6). No forma parte de la app ni del workspace y trae su propio `package.json` con la dependencia fijada.

- **Valor canónico de `numeric(p,2)`.** `canonicalNumeric2` (`pg-numeric.ts`, importado tal cual) coincide con Postgres en 36 040 valores (41 fijos y ~36 000 aleatorios, con bordes `x,xx5`): **0 diferencias**. El redondeo ingenuo `Math.round(v * 100) / 100` se equivoca en 446 (p. ej. `1,005` → 1 en JS, `1,01` en Postgres, porque Postgres redondea el **texto** decimal que recibe, no el `double`). Los valores esperados de las pruebas salen de Postgres, no de la función.
- **La migración**, ejecutada dos veces sobre una copia vacía de la estructura real de `inventory_items`: añade la columna y el `CHECK` una sola vez; acepta `NULL`, `{}` y objetos; rechaza arrays, texto, números y `jsonb 'null'`; y un `null` JSON de un cliente nuevo llega como `NULL` de SQL, sin violar el `CHECK`.
- **El `upsert` de un cliente antiguo**, con la forma exacta del SQL de PostgREST, conserva `nutrition_provenance` aunque cambie el nombre y los números; el de un cliente nuevo la sustituye o la limpia a `NULL`.
- **Qué no cubre:** PostgREST no se ejecuta (su generación de SQL se contrastó en su código fuente, `main` a 24/09/2026, no en la versión de Supabase), y RLS/permisos no se modelan.

---

## 20. Confianza de cantidad en el consumo de inventario — diseño, sin implementar

Fase de solo diseño: cero código tocado, cero PR abierto. Corrige una propuesta anterior (interacción con el control de cantidad como condición principal) tras una revisión que la rechazó explícitamente por insuficiente. Parte de PR4/el gateway de Nutrition v4 (§17, ya conectado en modo de solo lectura — ver «Estado actual» al final del documento) sin tocar el kernel, sus umbrales ni el histórico.

### 20.1 Por qué la interacción con el control no basta

La propuesta anterior proponía `quantityConfidence:"high"` cuando el usuario tecleaba, movía el slider o pulsaba un preset en `ConsumeModal.tsx`. Revisado contra el código real (`consumeInventoryItem`, `state.tsx:3024`; `ConsumeModal.tsx`), esa condición no distingue tres hechos distintos:

1. **Cantidad seleccionada o estimada** — el slider, los presets («25 %», «50 %», «Todo») y teclear un número a ojo son, los tres, una ESTIMACIÓN. `qty` además se precarga con un valor calculado (`item.unit==="ud" ? 1 : Math.min(item.qty,100)`) que el usuario puede confirmar sin tocar nada — "interacción" ni siquiera ocurrió necesariamente.
2. **Cantidad que el usuario declara haber pesado** — una afirmación explícita, distinta de cualquier edición del campo normal de cantidad: nadie declara sin querer que pesó algo.
3. **Cantidad calculada desde unidades con una masa por unidad acreditada** (`"ud"` × `unitSize` confirmado) — una tercera base, ni estimada ni pesada: contada y multiplicada por un dato declarado aparte.

**`"high"` solo puede nacer de (2) o (3), nunca de (1) — y nunca de que el campo haya recibido un evento de cambio.** El sistema puede verificar: que el usuario activó un control que SOLO existe para declarar un peso (nunca el campo de cantidad normal); que el número que acabó usándose para calcular macros coincide exactamente con esa declaración; que la unidad en la que se declaró es masa exacta. El sistema **no puede verificar, y no debe fingir que verifica**: que el usuario puso de verdad el alimento en una báscula; que el peso por unidad declarado una vez sigue siendo exacto esta vez. `"high"` es una declaración acreditada por interacción EXPLÍCITA e inequívoca, nunca una medición confirmada por el sistema.

**Mecanismo propuesto para (2):** un control SEPARADO del campo de cantidad normal — p. ej. una casilla «He pesado esta cantidad (g)», **desmarcada cada vez que se abre el modal, nunca recordada entre aperturas** — que, al marcarse, sustituye el slider/presets/campo normal por un único campo numérico en gramos, vacío por defecto (nunca precargado). Marcar la casilla y usar el slider a la vez es imposible por construcción: son modos mutuamente excluyentes, no dos señales que puedan contradecirse.

### 20.2 Dos unidades distintas — nunca comparadas directamente

**Corrección sobre la versión anterior de esta sección: mezclaba gramos declarados con cantidades expresadas en la unidad del inventario.** Son dos magnitudes distintas que solo se pueden comparar convertidas a una base común:

- **`declaredGrams`**: SIEMPRE gramos — lo que el usuario declara haber pesado. Nunca está en `item.unit`.
- **La cantidad descontada del inventario y `FoodLogEntry.qty`**: SIEMPRE en `item.unit` — igual que hoy para cualquier otro consumo, sin excepción para este camino.

**Ejemplo obligatorio.** Inventario de 1 kg, consumo declarado de 200 g:

```
item.unit = "kg", item.qty = 1
declaredGrams = 200

availableGrams = toGrams(item.qty, item.unit) = toGrams(1, "kg") = 1000   // exacto, sin unitSize
consumedGrams  = Math.min(declaredGrams, availableGrams) = 200            // AMBOS lados en gramos
consumedInItemUnit = fromGrams(consumedGrams, item.unit) = 200 / 1000 = 0.2

FoodLogEntry: { qty: 0.2, unit: "kg" }
quantityConfidence: { level: "high", declaredGrams: 200 }
```

`fromGrams` es la inversa exacta de `toGrams` para `"g"`/`"kg"` (identidad y `÷1000`, respectivamente) — no hace falta ninguna función nueva de cálculo, solo invertir la ya existente para estos dos casos, que son los únicos admitidos (20.4).

**Nunca `Math.min(declaredGrams, item.qty)` directamente** — compararía gramos contra kilos sin convertir (el error que señaló la revisión). El recorte por stock se hace SIEMPRE en gramos (`consumedGrams`), y el resultado se convierte a `item.unit` una sola vez, al final, para escribir la entrada.

**Cerrar el recorte previo del modal.** `setQtyClamped` (`ConsumeModal.tsx:25`) recorta dentro del propio componente, antes de llegar a cualquier escritor — pero en el modo «He pesado» no se usa en absoluto: el campo de gramos es un control nuevo y separado (20.1), vacío por defecto, que nunca pasa por `setQtyClamped`. Si `declaredGrams` supera `availableGrams` en el momento de escribir, el resultado es `consumedGrams < declaredGrams` — eso por sí solo ya basta para no acreditar `"high"` (20.7A, comparación sin redondear), sin necesitar ningún recorte visual en el modal. Sigue sin haber ninguna transformación oculta entre lo tecleado y lo comparado: `declaredGrams` es, siempre, exactamente lo que la persona tecleó.

### 20.3 Pérdida de confianza frente a cambio de significado — no es lo mismo

Dos cosas muy distintas pueden pasar entre que el usuario confirma y `consumeInventoryItem` escribe de verdad (recuperando `item` fresco del `draft`, como ya hace hoy):

**(a) Se reduce el stock disponible — la DECLARACIÓN sigue siendo interpretable, solo que el stock no la sostiene entera.** `consumedGrams = Math.min(declaredGrams, availableGrams) < declaredGrams`. El número que se escribe (`consumedInItemUnit`, derivado de `consumedGrams`) sigue siendo correcto y útil — es sencillamente menor que lo declarado. Se escribe igual que hoy, solo que etiquetado `"low"`: la confianza se pierde, pero el registro no se bloquea.

**(b) Cambia la unidad del item, o deja de ser una unidad de masa — la declaración deja de ser interpretable de forma segura, no solo menos fiable.** `declaredGrams` solo tiene un significado seguro mientras `item.unit ∈ {"g","kg"}`: convertir 200 g declarados a `"ud"` o a `"ml"` exigiría una masa por unidad o una densidad que, si acaba de cambiar, no se puede dar por buena sin más — escribir igual que en (a) pero etiquetado `"low"` **podría escribir un descuento de inventario y unos macros incorrectos**, no solo una confianza optimista: ya no es un problema de etiqueta, es un problema de cálculo. Por eso el modo «He pesado» solo se ofrece cuando `item.unit` YA es `"g"`/`"kg"` al abrir el modal, y la comprobación de escritura repite la misma condición sobre el `item.unit` fresco — un cambio DENTRO de la familia de masa (`"g"`↔`"kg"`) sigue siendo seguro y se recalcula sin más (ver tabla 20.8); un cambio FUERA de ella (`"ud"`, `"ml"`, `"L"`...) **bloquea el registro: no se escribe ninguna fila, no se toca el inventario**, y el modal muestra un error pidiendo revisar la cantidad — con `declaredGrams` todavía en el campo, para que la persona pueda corregir (p. ej. cambiar a modo estimado) y reintentar, en vez de perder lo que había tecleado.

**Qué información viaja del modal al escritor.** Únicamente `declaredGrams` (un número en gramos, autocontenido) más la marca de que es una declaración de peso — nada de la unidad del item en el momento de declarar: como el modo «He pesado» solo se ofrece con `item.unit` ya en `{"g","kg"}`, la única comprobación que hace falta en el escritor es sobre el `item.unit` FRESCO en el instante de escribir, sin necesitar recordar cuál era antes. Esto simplifica la condición de carrera a una sola pregunta: ¿sigue `item.unit` dentro de `{"g","kg"}` ahora mismo? Si sí, (a); si no, (b).

### 20.4 `unitSizeUnit` y la conversión que de verdad se usa

Hallazgo que cambia el alcance recomendado: **`toGrams` (`utils.ts:271`), la función que `macrosForQuantity` usa de verdad para calcular los macros de un consumo, no recibe `unitSizeUnit` en absoluto.** Su rama `"ud"` es `qty * unitSize` sin más — trata `unitSize` como si ya estuviera en gramos, sea cual sea su `unitSizeUnit` real. Existe una función distinta, `convertQty` (`utils.ts:329`), que sí es consciente de la dimensión (masa/volumen/conteo) y exige que `unitSizeUnit` coincida antes de cruzar de `"ud"` a gramos o mililitros, devolviendo `null` en vez de inventar — pero **`macrosForQuantity` no la usa**. Esto significa que, HOY, un item `"ud"` con `unitSizeUnit:"ml"` (una lata de 330 ml) ya calcula sus macros tratando 330 como si fueran 330 g — una suposición de densidad 1 completamente silenciosa, independiente de cualquier trabajo de procedencia.

Un `unitSize` positivo y declarado no basta, entonces, ni siquiera cuando `unitSizeUnit` es `"g"` de verdad: **la propia función de cálculo no distingue el caso correcto del incorrecto.** Acreditar `"high"` para un consumo en `"ud"` sin corregir primero `macrosForQuantity`/`toGrams` significaría certificar una cifra que puede estar sosteniendo una conversión volumen→masa no reconocida.

**Alcance recomendado para el primer PR de implementación: únicamente `"g"`/`"kg"`.** Son masa exacta sin ninguna conversión de por medio — `toGrams` ya las trata correctamente hoy (`kg: qty*1000`, `g`: identidad) — así que no hace falta tocar ningún cálculo existente, solo decidir cuándo etiquetar la entrada. `"ud"` y cualquier volumen (`"ml"`/`"L"`) quedan en `"low"` siempre, en este primer PR, sin excepción — no por una limitación del diseño de procedencia, sino porque el cálculo de macros que los alimenta no es hoy dimensionalmente correcto para `"ud"`, y nunca lo es para volumen sin densidad.

**Si un PR posterior quisiera admitir `"ud"`:** tendría que, a la vez, (a) corregir `macrosForQuantity` para que, cuando `unitSizeUnit==="g"`, calcule igual que hoy (ya es correcto en ese caso concreto), y cuando `unitSizeUnit==="ml"` o esté ausente, NO use `toGrams` sin más — enrutar por `convertQty(qty, "ud", "g", {fromUnitSize, fromUnitSizeUnit})`, que devuelve `null` en vez de inventar, y decidir qué hacer con ese `null` (tratar el lote como no convertible para macros, igual que ya se hace para comparar/descontar cantidades); y (b) exigir que `unitSize`/`unitSizeUnit` fueran declarados explícitamente para ESE item (mismo patrón de interacción explícita que 20.1, nunca heredado del 60 por defecto). Es trabajo de cálculo, no solo de procedencia — motivo suficiente para no mezclarlo con este primer PR.

### 20.5 Contrato — sin cambios de esquema

`FoodLogEntry.quantityConfidence?: { level: "high" | "low"; reason?: QuantityLowConfidenceReason }` ya admite `"high"` hoy — ningún escritor real lo emite todavía, pero el tipo no necesita ninguna migración. Se añade una propiedad opcional nueva, **siempre en gramos, nunca en `item.unit`**, solo informativa para la relectura defensiva (20.7):

```ts
quantityConfidence?: {
  level: "high" | "low";
  reason?: QuantityLowConfidenceReason;
  /** Solo con level:"high". SIEMPRE gramos — nunca la unidad de la
   *  entrada (`entry.unit`). La relectura (20.7) la compara contra
   *  `toGrams(entry.qty, entry.unit)`, no contra `entry.qty` directo. */
  declaredGrams?: number;
};
```

`sanitizeFoodLogProvenance` (`food-log-provenance.ts`) necesita sanear `declaredGrams` con una regla estricta, no la misma que `reason`: **finito, estrictamente positivo** (`typeof === "number" && Number.isFinite(v) && v > 0`) — cero, negativo, `NaN` e `Infinity` se descartan igual que cualquier otro valor inválido. Si `declaredGrams` no sobrevive el saneado pero `level` sigue siendo `"high"`, el resultado es un `"high"` sin evidencia: 20.7 lo degrada a `"low"` en la lectura, nunca lo descarta en silencio sin degradar.

### 20.6 Recorrido modal → escritor → diario → sincronización

1. **`ConsumeModal`**: casilla «He pesado esta cantidad (g)», visible SOLO cuando `item.unit ∈ {"g","kg"}` (20.3), desmarcada al abrir. Marcada, sustituye el control normal por un campo de gramos vacío, sin recorte (20.2). Al confirmar, pasa a `consumeInventoryItem` ÚNICAMENTE `{ declaredGrams }` — nunca una cantidad en `item.unit` para este camino; el escritor deriva esa cantidad él mismo (20.2).
2. **`consumeInventoryItem`** (escritor): recupera `item` fresco del `draft`. Si `item.unit ∉ {"g","kg"}` → bloquea (20.3b): no escribe fila, no toca inventario, devuelve al llamador una señal distinguible de "no se escribió por cambio de unidad" (el mecanismo exacto — valor de retorno de la acción, campo transitorio en el draft, excepción tipada — es detalle de implementación). Si `item.unit` sigue en la familia de masa: calcula `availableGrams = toGrams(item.qty, item.unit)`, `consumedGrams = Math.min(declaredGrams, availableGrams)`. **El recorte se decide AQUÍ, con los números SIN REDONDEAR** (`wasClamped = consumedGrams !== declaredGrams`, comparación exacta, no vía `canonicalNumeric2`) — redondear antes de comparar podría esconder un recorte real si las dos cifras redondeadas coincidieran por casualidad (20.7). `consumedInItemUnit = fromGrams(consumedGrams, item.unit)`, con la precisión de 20.6b (no la de 2 decimales que usa cualquier otro consumo). Escribe `FoodLogEntry.qty = consumedInItemUnit`, `unit = item.unit`. `quantityConfidence: { level: "high", declaredGrams }` solo si `!wasClamped`; si `wasClamped`, `{ level: "low" }` sin `declaredGrams` — el número escrito sigue siendo correcto (lo que de verdad cupo), la etiqueta es la que cambia.

**20.6b — Precisión del número escrito: por qué 2 decimales no bastan para `"kg"`.** El resto de la app redondea la cantidad restante de inventario a 2 decimales EN LA UNIDAD DEL ITEM (`item.qty = Math.round((item.qty - consumed) * 100) / 100`, patrón ya existente) — para `"kg"` eso es una granularidad de **10 g**, insuficiente para un consumo declarado con precisión de gramo: 233 g declarados, redondeados a 2 decimales de kg, se convierten en 0,23 kg (230 g) o 0,24 kg (240 g) — una diferencia real de varios gramos, no ruido de coma flotante, que además rompería la propia comprobación de coherencia de 20.7 incluso en el caso correcto. **Decisión de alcance, no de esquema:** este camino concreto (consumo declarado como pesado, en `"g"`/`"kg"`) redondea a una precisión distinta — 3 decimales para `"kg"` (`Math.round(consumedGrams) / 1000`, fidelidad de 1 g), identidad para `"g"` — usada A LA VEZ para `FoodLogEntry.qty` y para la cantidad que se resta del stock restante del item, para que ambos números sean siempre coherentes entre sí. **No se toca la precisión de 2 decimales que usa cualquier otro consumo** (estimado, receta, plato) — la rama de código que decide esto es exclusiva de `declaredAsWeighed`, no una regla nueva aplicada a todo `consumeInventoryItem`. Sin esquema nuevo: `item.qty`/`FoodLogEntry.qty` siguen siendo el mismo campo `number` de siempre, solo con más decimales en este camino concreto.
3. **`FoodLogEntry`**: el campo viaja como cualquier otro de procedencia — mismo `food_log.client_meta`, mismo saneado de ida y vuelta (B.1), sin cambio de esquema en Supabase.
4. **Edición posterior (`EditLogModal.tsx`)**: ya permite cambiar `qty` de una entrada existente, escalando macros — no toca `quantityConfidence`/`declaredGrams` hoy. El PR de implementación debe limpiar ambos campos ahí cuando `qty` cambie (la declaración original ya no describe la nueva cantidad) — limpieza en el ESCRITOR, proactiva, no solo defensiva.
5. **Adaptador** (`nutrition-v4-adapter.ts`, `quantityConfidenceOf`): al leer `level:"high"`, recalcula `entryGrams = toGrams(entry.qty, entry.unit)` (válido solo si `entry.unit ∈ {"g","kg"}`) y lo compara contra `declaredGrams` con la regla de 20.7B (comparación con precisión explícita, no exacta) — nunca compara `declaredGrams` contra `entry.qty` directamente. Cualquier discrepancia, unidad no admitida, o `declaredGrams` ausente/inválido → degrada a `"low"` en silencio, nunca lanza ni descarta la entrada. Esto protege incluso contra un escritor (como el punto 4) que no limpiara correctamente.
6. **Kernel**: sin cambios — sigue leyendo `"high"|"low"` exactamente como hoy.

### 20.7 Dos comprobaciones distintas — recorte al escribir, coherencia al releer

**Precisión sobre la versión anterior de esta sección: `canonicalNumeric2` fija una comparación a 0,01 g — no es igualdad exacta de las cantidades originales, y su verificación contra Postgres (36 040 valores, B.2) acredita que el ALGORITMO de redondeo coincide con el de Postgres, no que cualquier diferencia por debajo de esa precisión sea necesariamente ruido de representación binaria.** Son dos afirmaciones distintas — la primera (el algoritmo redondea igual que Postgres) está demostrada; la segunda (0,01 g es la tolerancia correcta para ESTE contrato) es una decisión de la aplicación, no algo que Postgres certifique. Por eso esta sección separa explícitamente DÓS reglas que antes se mezclaban:

**(A) Detectar el recorte, al ESCRIBIR — sin redondear, antes de que exista ningún `entry.qty`.** Ya cubierto en 20.6: `wasClamped = consumedGrams !== declaredGrams`, con los números tal cual produce `Math.min`, sin pasar por `canonicalNumeric2` ni por ningún redondeo. Cualquier reducción real por stock — por mínima que sea — impide `"high"` en este punto, **incluso si las dos cifras redondeadas a 2 decimales coincidirían**: redondear antes de comparar aquí escondería exactamente el caso que esta comprobación existe para atrapar.

**(B) Comprobar coherencia, al RELEER — con una precisión explícita y documentada, nunca con igualdad exacta.** En este punto `entry.qty` ya es el número PERSISTIDO (potencialmente redondeado al escribir, 20.6b) y puede haber viajado por JSON/Supabase — comparar con `===` contra `declaredGrams` rechazaría casos coherentes por representación binaria (`0,2 kg` reconvertido a gramos puede dar `200.00000000000003`). Aquí sí hace falta una tolerancia, y la pregunta correcta no es "¿son exactamente iguales?" sino "¿son iguales dentro de la precisión que este contrato declara aceptar?":

```ts
/** Precisión de aceptación del CONTRATO de quantityConfidence — una
 *  decisión de la aplicación, no una garantía que aporte Postgres. El
 *  algoritmo de redondeo (canonicalNumeric2) está verificado contra
 *  Postgres; la elección de aceptar hasta 0,01 g de diferencia aquí es
 *  independiente de esa verificación. */
function gramsCoherentForReread(declaredGrams: number, entryGrams: number): boolean {
  return canonicalNumeric2(declaredGrams) === canonicalNumeric2(entryGrams);
}
```

0,01 g sigue siendo un margen deliberadamente estrecho (más fino que cualquier discrepancia que importe para macros — la propia app ya redondea proteína/carbohidratos/grasa a 1 decimal), pero la razón para aceptarlo es "la aplicación decide que 0,01 g de diferencia en la reconstrucción no es una discrepancia material", no "Postgres demuestra que no lo es". **Por esto mismo, 20.6b fuerza una precisión de escritura de 1 g para `"kg"` (3 decimales) en vez de los 2 decimales/10 g que usa el resto de la app** — con 10 g de margen en la escritura, esta comprobación de 0,01 g en la lectura rechazaría sistemáticamente un camino perfectamente correcto, convirtiendo la tolerancia de relectura en papel mojado.

**Para conservar `"high"` en la lectura, hacen falta las tres a la vez:**
1. `declaredGrams` finito y estrictamente positivo (20.5).
2. `entry.qty` finito y estrictamente positivo (un `"high"` sobre una cantidad final de `0` no tiene sentido — `declaredGrams>0` por definición).
3. `entry.unit ∈ {"g","kg"}` — cualquier otra unidad (incluida la ausencia de unidad) nunca admite `"high"`.

Más la comprobación (B) sobre `entryGrams = toGrams(entry.qty, entry.unit)`.

**Degradación, nunca descarte.** Un `"high"` que falla cualquiera de las tres condiciones, o la comprobación (B), se lee como `{ level: "low" }` — la entrada entera NUNCA se descarta, ni se bloquea su lectura: solo pierde la etiqueta de confianza, igual que cualquier otro metadato inválido ya cubierto en PR4. El saneador y el adaptador, juntos, garantizan que una evidencia inválida nunca sobrevive como `"high"` — ni al guardar, ni al releer — y que ninguna ausencia de evidencia se convierte en confianza por defecto.

### 20.8 Tabla de aceptación

«Bloqueado» significa: no se escribe ninguna fila en `foodLog`, no se toca el inventario, el modal muestra un error y conserva `declaredGrams` en el campo para reintentar.

| Caso | Resultado | `declaredGrams` / `qty` escritos | Motivo |
|---|---|---|---|
| Valor precargado, sin ninguna declaración adicional | `"low"` (ausente) | — | Nunca hubo declaración — el campo ni se mostró (modo estimado por defecto) |
| Cantidad estimada con slider o preset | `"low"` (ausente) | — | Estimación, nunca declaración de peso, con independencia de cuánta interacción hubo (20.1) |
| **200 g desde un inventario de 1 kg** (ejemplo obligatorio) | `"high"` | `declaredGrams:200`, `qty:0.2`, `unit:"kg"` | `consumedGrams(200) = declaredGrams(200)`, sin recorte, comprobado SIN redondear (20.7A) |
| Consumo decimal, 233 g desde 1,5 kg | `"high"`, persiste y relee igual | `declaredGrams:233`, `qty:0.233` (3 decimales, no 2 — 20.6b), `unit:"kg"` | Escritura con fidelidad de 1 g; `canonicalNumeric2(toGrams(0.233,"kg"))=233.00=canonicalNumeric2(233)` en la relectura (20.7B) — con la precisión de 2 decimales habitual (`0.23`) esto fallaría incluso sin ningún recorte real |
| Recorte real que un redondeo a 2 decimales ocultaría (p. ej. `declaredGrams=200.01`, `availableGrams=200`) | `"low"` | `qty` = lo que cupo | `wasClamped` se decide SIN redondear (20.7A): `200 !== 200.01` detecta el recorte aunque `canonicalNumeric2` de ambos dé `200.00`/`200.01` igual de "cerca" |
| Alimento desaparecido del inventario entre confirmar y escribir (`item` ya no existe en el `draft`) | **Bloqueado**, resultado de negocio distinto del de cambio de unidad | Nada escrito | No hay `item` del que leer `unit`/`qty` — el escritor debe distinguir este caso del de unidad incompatible, no fundirlos en un único "no se pudo" (§9) |
| Reintento tras un bloqueo (unidad incompatible o alimento desaparecido), con `declaredGrams` sin tocar | Depende del nuevo intento — `"high"`, `"low"` o bloqueado de nuevo, como cualquier otra confirmación | Según corresponda | El bloqueo anterior no deja ningún resto: cada intento se evalúa desde cero contra el `item` fresco |
| Doble envío del mismo intento (doble clic, u otra pestaña confirmando la misma intención) | Como máximo UN registro | Uno solo | Mismo `IntentGuard` ya usado por `ConsumeModal`/`CookModal`, ahora coherente con el resultado de negocio del escritor (no solo con el booleano de `mutate()`) |
| `declaredGrams` = 0 | Rechazado en el propio modal, no se envía | — | No estrictamente positivo (20.5) |
| `declaredGrams` negativo | Rechazado en el propio modal, no se envía | — | No estrictamente positivo (20.5) |
| `declaredGrams` = `NaN` | Rechazado en el propio modal, no se envía | — | No finito (20.5) |
| `declaredGrams` = `Infinity` | Rechazado en el propio modal, no se envía | — | No finito (20.5) |
| Cambio **g→kg** mientras el modal está abierto (otra pestaña cambió la unidad del item, sigue siendo masa) | `"high"` si no hay recorte | `declaredGrams` igual; `qty`/`unit` recalculados sobre el `item.unit` fresco | Sigue dentro de la familia de masa — se reinterpreta correctamente, no se bloquea (20.3a) |
| Cambio **masa→`"ud"`/`"ml"`** mientras el modal está abierto | **Bloqueado** | Nada escrito | La declaración en gramos ya no es interpretable sin una conversión no verificada (20.3b) |
| Reducción de stock después de confirmar (otra pestaña consumió entre confirmar y escribir) | `"low"` | `qty` = lo que de verdad cabía (`consumedGrams < declaredGrams`), convertido a `item.unit` | Se escribe lo que cabe, igual que hoy — solo se pierde la etiqueta (20.3a) |
| Evidencia válida cuyo `qty` o `unit` se modifica DESPUÉS de escrita (p. ej. `EditLogModal`) | Degrada a `"low"` en la próxima lectura | La fila en sí no cambia por esto; la lectura deja de confiar en `declaredGrams` | `toGrams(entry.qty, entry.unit)` ya no coincide con `declaredGrams` — detectado en la relectura (20.6–20.7), con independencia de si el escritor limpió el campo o no |
| Tamaño por unidad (`unitSize`/`unitSizeUnit`) ausente, inválido, en gramos o en mililitros | Irrelevante en este PR | — | `"ud"` nunca ofrece el modo «He pesado» (20.4) — ningún valor de `unitSize`/`unitSizeUnit` lo cambia |
| Entrada antigua, o cliente que no envía la nueva evidencia | `"low"` (ausente), sin migración retroactiva | — | Mismo criterio que toda ausencia de procedencia en este diseño |
| Persistencia y relectura — `"high"` sin `declaredGrams` coherente (corrupto, editado a mano, cliente que implementó mal la función) | Degrada a `"low"` en la lectura, la entrada nunca se descarta | — | El saneador y el adaptador, juntos, nunca elevan confianza por defecto (20.7) |

### 20.9 Recomendación de alcance mínimo para el siguiente PR de implementación

1. La casilla «He pesado esta cantidad (g)» en `ConsumeModal.tsx` — visible solo con `item.unit ∈ {"g","kg"}`, campo vacío sin recorte (20.1–20.2).
2. La derivación en gramos dentro de `consumeInventoryItem` (`availableGrams`/`consumedGrams`/`consumedInItemUnit`, 20.2) y el bloqueo explícito cuando `item.unit` deja la familia de masa entre confirmar y escribir (20.3b).
3. El saneado estricto de `declaredGrams` en `sanitizeFoodLogProvenance` (20.5) y la relectura defensiva con `canonicalNumeric2` en el adaptador (20.6–20.7).
4. La limpieza de `quantityConfidence`/`declaredGrams` en `EditLogModal.tsx` cuando se cambia `qty` de una entrada existente (20.6, punto 4) — proactiva, además de la defensa en el adaptador, no en su lugar.
5. Pruebas centradas en la tabla de 20.8 completa — en particular los tres pares que antes no existían: el ejemplo de 1 kg/200 g con sus unidades correctas, el bloqueo por cambio masa→`"ud"`/`"ml"` (sin ninguna escritura), y la relectura tras una edición posterior de `qty`.

Fuera de este PR, explícitamente: `"ud"` (requiere corregir primero `macrosForQuantity`/`toGrams`, 20.4); volumen; ningún cambio al kernel, a sus umbrales, ni al histórico; ninguna conexión con el gate ni con propuestas adaptativas.

**Decisiones que siguen pendientes, no resueltas por este diseño:**
- Si `"ud"` merece su propio PR de corrección de cálculo antes de poder acreditar cantidad ahí, o si se deja fuera indefinidamente.
- Si la casilla «He pesado» debería ofrecerse también en otros escritores que hoy nunca pueden ser `"high"` (p. ej. un ingrediente de receta pesado al cocinar) — hoy fuera de alcance porque el total de una receta sigue siendo `legacy_unlabeled` incondicional (AC28, §16.4) con independencia de la cantidad.
- Cómo se comunica en la interfaz, si es que se comunica, que un consumo es `"high"` — este diseño no incluye ningún indicador visual nuevo.

---

## Confirmación de cierre — ronda original de diseño (histórica)

*Esta sección describe únicamente la ronda original de diseño, previa a cualquier implementación. No describe PR1, PR2 ni PR3a — ver «Estado actual» más abajo.*

- **Commit base**: `82a581c02bac2802dd4aec863c22a21f76fd755f` (`origin/main`) — confirmado sin movimiento (re-verificado con `git fetch` al cierre de esta ronda).
- **Worktree**: `wt-nutrition-v4-data-integrity`, rama `design/nutrition-v4-data-integrity`.
- **Modificaciones de implementación durante esta ronda**: cero. No se creó, editó ni borró ningún archivo de código; no se ejecutó SQL; no se realizó ninguna operación contra Supabase; no se abrió PR; no se hizo ningún commit.

---

## Estado actual — actualizado tras el gateway de diagnóstico (#149, fusionado)

Separado de la confirmación histórica de arriba, que sigue siendo cierta para aquella ronda de diseño y no debe leerse como descripción de lo que ocurre ahora. Esta sección sí se mantiene al día — a diferencia de §15–§20, que son correcciones puntuales fechadas y no se reescriben.

**`main` en `5def4afd013fd03a02fa0984914d3e12376bf864`** (merge de PR #149). Todo lo que sigue está fusionado en `main` y desplegado en producción, salvo donde se indique explícitamente lo contrario.

- **PR1** (tipos y kernel puro de cobertura, `packages/types`/`packages/engine`) — fusionado.
- **PR2** (adaptador del diario, esqueleto) y **PR3a** (procedencia y estado del alimento en el punto de captura) — fusionados.
- **B.1 / PR3** (etiquetado de los 9 caminos que escriben `foodLog`, persistencia en `food_log.client_meta`, §18) — fusionado.
- **B.2** (persistencia de la procedencia del inventario en `inventory_items.nutrition_provenance`, §19) — fusionado. **La migración `20260924190000_inventory_nutrition_provenance.sql` está APLICADA** en el proyecto Supabase real de FoodOS (`rwxysqzurjsrevdhbejy`) — ya no es «preparada, sin aplicar» como decía esta sección antes.
- **PR4** (lectura fiel de la procedencia en `nutrition-v4-adapter.ts`) — fusionado. El adaptador YA lee `nutrientStatus`/`quantityConfidence`/`foodStateConfidence` realmente guardados, reconciliados con el número, en vez de tratar toda entrada como `legacy_unlabeled` por defecto. Ya no es cierto que «el adaptador de PR2 no lee todavía las etiquetas del diario» (afirmación de esta sección antes de PR4).
- **Gateway + panel de diagnóstico (#149)** — fusionado. `apps/web` **SÍ** importa ahora el paquete de kernels puros, mediante un único archivo explícito (`nutrition-v4-coverage-gateway.ts`) — ya no es cierto que «`apps/web` no importa el motor puro» (afirmación de esta sección antes de #149). La frontera sigue protegida: todo archivo de `apps/web/src` salvo ese uno sigue prohibido de mencionar el paquete, verificado por un helper de test compartido (`packages/engine/src/test-support/web-boundary.ts`) usado por los 7 kernels — PR1 (`nutrient-coverage-kernel.test.ts`) ganó su propia copia de esta prueba, que antes le faltaba. El panel (Ajustes → Admin) calcula y muestra el informe de cobertura de los últimos 28 días del diario real — de solo lectura, sin generar propuestas, sin modificar objetivos, sin activar nada.
  - **Comprobación visual del panel: pendiente.** Se verificó por código, por sus 17 pruebas específicas (determinismo, no-mutación, cero red del gateway; diario vacío, entradas sintéticas, umbrales inválidos, cobertura fiable+provisional simultánea, cero mutación/persistencia del panel) y por CI/e2e/Vercel en verde — pero la cuenta QA con sesión iniciada en el preview no tenía acceso admin, así que nunca se vio renderizado en un navegador real. No es un fallo conocido del panel: es una verificación que sigue sin completarse.
- **§20 (confianza de cantidad en el consumo de inventario): diseño únicamente, sin implementar.** Vive en la rama local `design/nutrition-v4-quantity-confidence`, sin PR abierto. Ningún código de `ConsumeModal.tsx`/`consumeInventoryItem`/el adaptador se ha tocado para esto todavía.
- **Nutrition v4 sigue sin activar.** El kernel de cobertura es alcanzable desde la web (vía el gateway), pero solo para calcular y mostrar un informe — ninguna propuesta adaptativa se genera ni se acepta, ningún objetivo nutricional cambia, ningún umbral se ha fijado ni relajado. La decisión de producto de §17 (el gate es seguro pero probablemente poco utilizable con los caminos de captura actuales) sigue sin resolver.
