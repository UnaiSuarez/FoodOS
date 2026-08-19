# Investigación: cómo funcionan las apps de nutrición líderes

Investigación de campo (agosto 2026) sobre MyFitnessPal, Cronometer, Lose It!, MacroFactor, Noom, YAZIO y Lifesum — de dónde sacan los datos de alimentos, cómo cuentan calorías, cómo se registra la comida, y qué patrones de diseño usan para retención. Cada afirmación va con su fuente. Al final: recomendaciones concretas para FoodOS, mapeadas contra lo que ya existe en el código y contra `docs/BACKLOG.md`.

---

## 1. De dónde sacan los datos de alimentos

Esta es la pregunta que más impacto tiene en la confianza del usuario, y es donde más se diferencian las apps.

### 1.1 Las dos familias de bases de datos

**Bases de datos verificadas/de laboratorio** (analizadas químicamente, no auto-declaradas):
- **USDA FoodData Central** — la referencia dorada en EE. UU., cubre 380.000+ alimentos con perfiles nutricionales validados por estándares federales, actualización trimestral, sin reconocimiento de imagen ni escaneo de código de barras integrado ([SpikeAPI](https://www.spikeapi.com/blog/top-nutrition-apis-for-developers-2026), [Nutrola](https://nutrola.app/en/blog/open-nutrition-datasets-compared-usda-openfoodfacts-nutrola)).
- **NCCDB** (Nutrition Coordinating Center, Universidad de Minnesota), **CNF** (Canadá), **NEVO** (Países Bajos), **CoFID** (Reino Unido), **NUTTAB** (Australia) — bases de composición de alimentos nacionales, todas de laboratorio.

**Bases de datos crowdsourced** (cualquier usuario puede añadir o editar):
- **Open Food Facts** — 2,5M+ productos de 180+ países, gratis, buena cobertura internacional de productos de marca — ya es la fuente principal de FoodOS ([Nutrola](https://nutrola.app/en/blog/open-nutrition-datasets-compared-usda-openfoodfacts-nutrola)).
- Las entradas de usuarios de MyFitnessPal, Lose It!, etc.

### 1.2 Cronometer: el caso de "solo verificado"

Cronometer combina **más de 10 fuentes de laboratorio** (NCCDB, USDA SR28, CNF, IFCDB, NEVO, CoFID, NUTTAB) y trata cada envío de marca con un proceso de verificación antes de publicarlo. Resultado: **±3,5% de precisión calórica** en sus entradas verificadas, y tracking de **84 nutrientes** solo de fuentes verificadas ([Data Sources – Cronometer](https://support.cronometer.com/hc/en-us/articles/360018239472-Data-Sources), [ScienceInsights](https://scienceinsights.org/how-accurate-is-cronometer-what-the-data-shows/)).

Cronometer **rechazó deliberadamente** añadir un "Quick Add" (calorías sin buscar el alimento) porque, según su propio equipo, eso "promovería usar datos menos precisos e incompletos" ([foro de Cronometer](https://forums.cronometer.com/discussion/2578/quick-add-feature)). Es una decisión de producto explícita: velocidad vs. exactitud.

### 1.3 MyFitnessPal: el coste real de crowdsourcing sin control de calidad

MyFitnessPal tiene 20,5 millones de alimentos, pero **menos del 10% están verificados por la propia empresa**. El resto viene de: (1) USDA FoodData Central, (2) envíos de fabricantes (limitado a marcas grandes), y (3) **entradas de usuarios — ~70% del total**, sin obligación de citar fuente ni revisión nutricional, y sin deduplicación automática de entradas contradictorias ([blog de MyFitnessPal](https://blog.myfitnesspal.com/how-food-database-works/), [Nutrola](https://nutrola.app/en/blog/how-accurate-is-myfitnesspal)).

El impacto real, medido en estudios:
- Un estudio de 2019 en *Nutrition Journal* encontró **errores en el 27% de las entradas** de bases crowdsourced.
- Un estudio revisado por pares de 2024 encontró que el **37% de las entradas de alimentos populares** tenían errores de valor energético superiores al 20% del valor medido.
- Discrepancias de más de 100 kcal por ración entre duplicados del mismo alimento — suficiente para desviar meses de seguimiento de pérdida de peso ([hilos de la comunidad MyFitnessPal](https://community.myfitnesspal.com/en/discussion/10862172/there-is-so-much-items-in-the-database-with-incorrect-nutritional-values), [Nutrola](https://nutrola.app/en/blog/why-is-myfitnesspal-so-inaccurate)).

El escáner de código de barras de MyFitnessPal es ~92-95% preciso para marcas grandes de EE. UU., pero la precisión cae con marcas blancas, productos internacionales y reformulaciones recientes ([Nutrola](https://nutrola.app/en/blog/how-accurate-is-myfitnesspal)).

**Esto valida directamente una decisión que FoodOS ya tomó esta sesión**: el campo `dataSource` (`local` / `off` / `usda` / `ai` / `manual`) en `InventoryItem` y los avisos de "estimado por IA, revísalo" en `InventoryDetailModal`/`BulkImportModal`/`EditInventoryModal` no son un capricho — son exactamente la mitigación que Cronometer aplica con badges de verificación y que MyFitnessPal necesita desesperadamente y no tiene.

### 1.4 Agregadores comerciales (APIs)

| Proveedor | Especialidad | Cobertura |
|---|---|---|
| **Nutritionix** | Marca + restaurante | 799k alimentos de supermercado, 184k ítems de restaurante, 209.882 geolocalizaciones de restaurantes ([SpikeAPI](https://www.spikeapi.com/blog/top-nutrition-apis-for-developers-2026)) |
| **Edamam** | Recetas + parsing en lenguaje natural | 2,3M recetas agregadas, 900k+ alimentos, acepta consultas como *"1 cup of cooked brown rice"* directamente ([SpikeAPI](https://www.spikeapi.com/blog/top-nutrition-apis-for-developers-2026)) |
| **FatSecret Platform** | Global, muy usado por desarrolladores | 2,3M alimentos verificados, 58 países, 700M llamadas/mes de 50.000+ desarrolladores ([FatSecret](https://platform.fatsecret.com/platform-api)) |

Todos combinan USDA + datos de marca + a veces Open Food Facts. Ninguno resuelve el problema de fondo: **la precisión depende de si la entrada concreta que se muestra viene de laboratorio o de un usuario**, y casi ninguna app comunica eso con claridad en el momento de búsqueda — solo en la ficha de detalle si el usuario profundiza.

---

## 2. Cómo cuentan las calorías (TDEE)

### 2.1 El consenso de fórmula estática

- **Mifflin-St Jeor** (1990) es la fórmula más validada como precisa en TMB basada en peso, para el rango general de tipos corporales — es lo que usa FoodOS y lo que confirmó la verificación de fuentes hecha al principio de este proyecto ([Nutrola](https://nutrola.app/en/blog/understanding-tdee-bmr-mifflin-st-jeor-equation-calorie-goals)).
- **Katch-McArdle** es más precisa solo si hay un % de grasa corporal fiable, porque usa masa magra en vez de peso total — relevante para personas muy musculadas o muy delgadas. FoodOS ya cubre este caso parcialmente vía el ajuste ESPEN de `calcProteinBase`, pero **no** para el cálculo de TMB en sí (que sigue siendo Mifflin-St Jeor puro).
- Entre calculadoras "reputadas", es normal un **5-10% de dispersión** solo por diferencias de redondeo y definición de nivel de actividad ([Nutrola](https://nutrola.app/en/blog/understanding-tdee-bmr-mifflin-st-jeor-equation-calorie-goals)).

### 2.2 MacroFactor: validación externa directa del enfoque de PR4-PR7

Este es el hallazgo más relevante de toda la investigación para FoodOS. **MacroFactor implementa, como su función central pagada, casi exactamente lo que se acaba de construir en PR4-PR7**:

> "En vez de usar fórmulas estáticas basadas en demografía, MacroFactor deriva tu TDEE real de la relación entre tu ingesta calórica registrada y la tendencia de tu peso corporal a lo largo del tiempo." — [MacroFactor Help](https://help.macrofactorapp.com/en/articles/26-how-should-i-interpret-changes-to-my-energy-expenditure)

Su algoritmo:
1. Usa una **media móvil ponderada** para extraer la tendencia de peso subyacente del ruido diario (agua, sal, glucógeno) — el mismo objetivo que `calcWeightTrend` (mediana móvil + EWMA) de FoodOS.
2. Compara la ingesta real registrada contra el cambio de peso real para inferir el TDEE observado — el mismo cálculo `observedKcal = avgIntake − slope × 7700` que se implementó en PR5.
3. Actualiza continuamente la estimación de TDEE y **recomienda** cambios de objetivo — no los aplica solo. El usuario decide.
4. Necesita ~2 semanas de datos consistentes para estabilizarse.
5. El margen de error de las fórmulas estándar frente a la realidad individual es de **200-400 kcal/día** — justo el tipo de discrepancia que el TDEE adaptativo corrige ([MacroFactor](https://macrofactor.com/algorithm-accuracy/)).

La diferencia clave con FoodOS: MacroFactor es la app *entera* construida alrededor de esto (con suscripción de pago como producto principal), mientras que en FoodOS es una capa opcional sobre un motor de fórmula que sigue funcionando perfectamente sin ella. Esa es una posición de producto más sana — MacroFactor no tiene modo "solo fórmula" real.

**Conclusión práctica**: no hace falta rediseñar nada del motor adaptativo ya construido — el diseño (snapshot inmutable, confianza por cantidad de datos, guardarraíles de seguridad, aceptación explícita del usuario, cooldown) ya es más conservador que el de MacroFactor en el sentido de que nunca aplica un cambio sin confirmación humana.

---

## 3. Cómo se registra la comida (velocidad de logging)

La fricción de registro es la razón #1 de abandono — la investigación cita que la mayoría de usuarios abandona su app de conteo de calorías en los primeros 14 días ([Trophy.so](https://trophy.so/blog/streaks-gamification-case-study)). Cada app compite en reducir el tiempo de "abrir app → comida registrada".

### 3.1 Código de barras

Estándar en todas. Patrón de UX consistente: feedback inmediato tipo *"Código reconocido — macros cargadas"*, con fallback a búsqueda por texto o entrada manual si el código no está en la base ([Scandit](https://www.scandit.com/blog/best-practices-for-self-scanning-app-user-experience/)). FoodOS ya tiene esto (`BarcodeScannerModal`, con los errores de cámara ya corregidos esta sesión).

### 3.2 Foto + IA (reconocimiento visual)

- **Lose It! "Snap It"**: red neuronal entrenada con 230.000 imágenes de comida y 4.000M+ comidas registradas por usuarios desde 2008 sobre GPUs NVIDIA. En pruebas independientes, identificó correctamente **todos** los componentes del plato solo en el **60%** de las fotos — falla sistemáticamente cuando hay 3+ alimentos distintos en el plato ([TechCrunch](https://techcrunch.com/2016/09/29/lose-it-launches-snap-it-to-let-users-count-calories-in-food-photos/), [Nutrola](https://nutrola.app/en/blog/how-reliable-is-lose-it-snap-it-photo-feature)).
- **SnapCalorie**: usa **sensores de profundidad (LiDAR)** para medir el volumen real de la comida en vez de estimar solo de una imagen plana — la razón de que la estimación visual humana de porciones sea sistemáticamente mala. Entrenado con 5.000 comidas donde los ingredientes se pesaron en báscula real (no solo etiquetadas a ojo por humanos después). Resultado: **margen de error <20%**, el doble de preciso que un usuario estimando a ojo ([TechCrunch](https://techcrunch.com/2023/06/26/snapcalorie-computer-vision-health-app-raises-3m/), [Roboflow](https://blog.roboflow.com/count-calories-from-photos-computer-vision/)).
- **MacroFactor AI**: combina foto + texto — el usuario puede añadir una descripción corta junto a la foto ("curry de pollo con arroz y naan") para mejorar la precisión en platos complejos o regionales que el reconocimiento visual solo no resuelve bien. Varios prompts de LLM en cadena descomponen la comida en ingredientes y consultan la base de datos real en vez de inventar valores ([MacroFactor](https://macrofactor.com/ai-food-logging/)).

**Relevancia directa para FoodOS**: ya existe la infraestructura (`ai-provider.ts` con soporte Gemini/OpenAI/Anthropic/Ollama, y el patrón ya usado en `BulkImportModal` para fotos de tickets). Extender esto a "foto de plato → identificación + macros editables" es una extensión natural, no una reconstrucción — y el patrón de "IA propone, usuario confirma antes de guardar" que pide E15-06 del backlog encaja exactamente con lo que hace MacroFactor.

### 3.3 Registro por lenguaje natural / voz

MacroFactor: función **"Describe"** — escribes o dictas *"2 huevos y una tostada con aguacate"* y la app busca coincidencias reales en su base de datos en vez de alucinar valores ([MacroFactor Help](https://help.macrofactorapp.com/en/articles/258-ai-food-logging)). Edamam expone lo mismo como servicio (Natural Language Processing API) para que cualquier app lo integre.

FoodOS ya tiene un asistente de IA conversacional (`Asistente`) — la extensión lógica es que ese mismo chat pueda registrar comidas directamente por texto, no solo sugerir recetas. Esto es literalmente lo que pide **E15-05** del backlog ("Migrar de etiquetas a tool calling") aplicado al Diario.

### 3.4 "Quick Add" — el debate filosófico

MyFitnessPal permite registrar solo un número de kcal sin buscar el alimento. Cronometer se niega explícitamente porque erosiona la calidad de los datos ([foro de Cronometer](https://forums.cronometer.com/discussion/2578/quick-add-feature)). Es una decisión de producto, no un detalle técnico — y FoodOS ya tiene una postura implícita (todo pasa por inventario/recetas/IA con macros reales) que se alinea más con Cronometer que con MyFitnessPal. Vale la pena mantenerla, no añadir un Quick Add "puro".

### 3.5 Importador de recetas por URL

MyFitnessPal permite pegar la URL de una receta de cualquier web y extrae automáticamente la lista de ingredientes, marcando con ✓ verde los que coinciden con la base de datos y con ✗ rojo los que requieren corrección manual ([MyFitnessPal Help](https://support.myfitnesspal.com/hc/en-us/articles/360032271592-How-does-the-Recipe-Importer-on-the-website-work)). No está en el backlog actual de FoodOS (E08) — es una función de bajo esfuerzo relativo (parsing de una URL + matching contra el inventario/base de alimentos que ya existe) con alto valor percibido.

### 3.6 Recientes, frecuentes y repetición

Patrón universal en las apps líderes: alimentos recientes, alimentos frecuentes agrupados por franja horaria (desayuno/comida/cena), "repetir última comida", "copiar de ayer". Todo esto **ya está en el backlog de FoodOS** como E06-04 a E06-07 — la investigación simplemente confirma que son features de tabla, no diferenciadores, así que su prioridad P1 actual es correcta.

---

## 4. Diseño psicológico y retención

### 4.1 El sistema de colores de Noom — por qué NO copiarlo

Noom clasifica los alimentos en verde/amarillo/naranja según densidad calórica. Es intuitivo y coherente con la evidencia sobre densidad calórica y saciedad, **pero** la propia investigación encuentra una crítica consistente: el sistema **sobre-simplifica la calidad nutricional**, clasificando alimentos densos en nutrientes (frutos secos, aceite de oliva, aguacate) como "naranja" solo por su densidad calórica, lo que puede generar **ansiedad innecesaria alrededor de grasas saludables** ([U.S. News](https://health.usnews.com/best-diet/noom-diet), [Rank and Style](https://www.rankandstyle.com/articles/meet-noom-health-app)).

Esto **refuerza, con evidencia externa**, un principio que ya está en `docs/BACKLOG.md` (E11-12 "Mejorar lenguaje no moralizante", E23 "Contenido, lenguaje y confianza"): no clasificar alimentos como buenos/malos por un solo eje. Si en algún momento se plantea un sistema de indicadores visuales de calidad nutricional en FoodOS, el error de Noom es la referencia exacta de lo que evitar.

### 4.2 Streaks y gamificación — funciona, pero con matices

- Las rachas de registro aumentan la consistencia en un **40%** ([MyFoodBuddy](https://foodbuddy.my/blog/how-streaks-keep-you-consistent-with-calorie-tracking-20260612)).
- El mecanismo psicológico es aversión a la pérdida: cuanto más larga la racha, más motivación para no romperla ([Trophy.so](https://trophy.so/blog/streaks-gamification-case-study)).
- La automaticidad de un hábito tarda de media **~66 días** en formarse (investigación UCL), con alta variación individual — las rachas cortas (7-30 días) no bastan por sí solas, hace falta reducir fricción de forma sostenida ([StriveCloud](https://www.strivecloud.io/blog/gamification-features-mhealth)).

FoodOS ya tiene racha de adherencia (`getAdherenceStreak`) y heatmap de 28 días en `MacroAdherencePanel` — es decir, ya implementa el mecanismo con mayor evidencia de impacto. No hace falta añadir XP, ligas ni insignias (E22/E24 del backlog ya tratan esto con cautela apropiada) — el riesgo de sobre-gamificar es convertir el seguimiento nutricional en una competición, que es precisamente lo que E00-03 (decisión sobre el Feed/comunidad) debe resolver con cuidado antes de añadir más mecánicas sociales.

### 4.3 Integración con wearables — una laguna real de FoodOS

MyFitnessPal, Cronometer, Lose It! y Fitia sincronizan en ambas direcciones con Apple Health, Google Fit/Health Connect, Fitbit, Garmin y básculas inteligentes: los pasos y el ejercicio entran automáticamente a la app, y las calorías registradas salen hacia el ecosistema de salud del sistema operativo ([Lifestack](https://lifestack.ai/blog/apps-to-use-with-google-fit), [Fitia](https://fitia.app/learn/article/best-calorie-tracking-apps-sync-fitness-tracker-2025)).

FoodOS hoy solo tiene entrada manual de pasos (`stepsLog`). Es la brecha más clara frente a toda la competencia — aunque hay que ser precisos con el orden de prioridad: dado que PR1 de esta sesión eliminó deliberadamente la doble contabilización de calorías del entrenamiento, cualquier sincronización automática de ejercicio tendría que respetar exactamente esa misma regla (mostrar el gasto como información, nunca sumarlo directamente al presupuesto).

---

## 5. Tabla comparativa

| App | Fuente de datos principal | Modelo TDEE | Logging estrella | Precio |
|---|---|---|---|---|
| **MyFitnessPal** | Crowdsourced (70%) + USDA + marcas | Estático (Mifflin-St Jeor) | Base de datos enorme, Quick Add, importador de recetas | Freemium |
| **Cronometer** | 10+ fuentes de laboratorio, todo verificado | Estático, opción BMR manual | Precisión y micronutrientes (84) | Freemium |
| **Lose It!** | Crowdsourced + 56M ítems | Estático | Snap It (foto con IA, ~60% acierto en platos simples) | Freemium |
| **MacroFactor** | Base curada + IA con foto/texto | **Adaptativo** (deriva TDEE real de peso+ingesta) | "Describe" (lenguaje natural), fastest logger del mercado | Solo pago |
| **Noom** | Base propia | Estático | Colores verde/amarillo/naranja + coaching psicológico | Suscripción cara |
| **YAZIO** | Base propia + OFF | Estático | Ayuno intermitente integrado, IA en foto | Freemium barato |
| **Lifesum** | Base propia | Estático | Diseño pulido, planes de dieta | Freemium |
| **FoodOS (hoy)** | Open Food Facts + IA + manual, con badge de fuente | **Adaptativo** (PR4-7) + guardarraíles de seguridad | Escaneo + foto de ticket + asistente IA | — |

FoodOS ya está, en el eje del motor de cálculo, más cerca de MacroFactor (el más avanzado del mercado) que de ninguna otra app gratuita — con el añadido de que MacroFactor no ofrece guardarraíles de seguridad explícitos (bloqueo <800 kcal, aviso de discrepancia de datos) ni trazabilidad de snapshots inmutables. Eso es una ventaja real, no solo paridad.

---

## 6. Recomendaciones concretas para FoodOS

Priorizadas por impacto/esfuerzo, mapeadas contra `docs/BACKLOG.md` donde ya existe un ticket relacionado.

### Ya validado — mantener el rumbo, sin cambios
- **Motor adaptativo con confirmación humana** (PR4-7): MacroFactor confirma que es el enfoque correcto del mercado, y FoodOS ya es más conservador (guardarraíles, snapshots, cooldown).
- **Badges de fuente de datos** (`dataSource: local/off/ai/manual`): la tasa de error del 27-37% en bases crowdsourced justifica totalmente seguir invirtiendo aquí, no es paranoia.
- **No usar colores tipo semáforo para clasificar alimentos**: el error de Noom con grasas saludables es la prueba. Mantener la postura ya escrita en E11-12/E23.
- **No añadir Quick Add "puro"**: alinea con la postura de Cronometer sobre calidad de datos frente a velocidad.

### Nuevo — recomendado añadir al backlog

| Prioridad sugerida | Función | Por qué | Dónde encaja |
|---|---|---|---|
| P1 | **Foto de plato con IA** (tipo Snap It/MacroFactor, sin LiDAR) | Ya existe `ai-provider.ts` con visión; reutiliza el patrón de `BulkImportModal`. Etiquetar siempre `dataSource: "ai"` con aviso de revisión | Nuevo ticket bajo E06 (Diario) o E15 (IA) |
| P1 | **Registro de comidas por texto natural vía Asistente** | El asistente de IA ya existe; falta que pueda escribir directamente en el diario, no solo sugerir recetas | Encaja en E15-05 (tool calling) |
| P2 | **Importador de recetas por URL** | Bajo esfuerzo relativo, patrón ya resuelto por MyFitnessPal (parseo de ingredientes + matching contra base existente) | Nuevo ticket bajo E08 (Recetas) |
| P2 | **Sincronización con Apple Health / Google Fit / Health Connect** | Única laguna clara frente a todos los competidores estudiados. Debe respetar la regla de PR1: mostrar el gasto de ejercicio como información, nunca sumarlo directamente | Nuevo ticket bajo E19 (PWA/sync) — depende de decidir alcance de privacidad primero |
| P3 | **Extender el "Ver cálculo" (E11-05) citando el % de dispersión típico entre calculadoras** | Contextualiza para el usuario que ±5-10% de diferencia frente a "lo que dice otra app" es normal y esperado, no un error de FoodOS | Ya cubierto conceptualmente por E11-05/E11-06, añadir esta cifra concreta al texto |
| P3 | **Badge "verificado" visible en la búsqueda de alimentos**, no solo en el detalle de inventario | Cronometer y MyFitnessPal solo muestran esto al usuario que profundiza — hacerlo visible en el primer vistazo de resultados de búsqueda es una mejora real sobre el estado del arte, no solo paridad | Extiende E07-08 ("Mostrar claramente la fuente") a la vista de búsqueda, no solo inventario |
| P4 | **Medición de porciones por foto con profundidad (LiDAR)** | Requiere hardware específico (iPhone Pro) y un dataset de entrenamiento propio — fuera de alcance hasta validar que el reconocimiento por foto simple (P1) tiene tracción real | Exploración futura, no antes de medir uso de la función P1 |

### Explícitamente descartado tras la investigación
- Sistema de colores de alimentos tipo Noom.
- Quick Add sin desglose de macros.
- Gamificación tipo ligas/XP/insignias — el mecanismo de mayor evidencia (rachas) ya está implementado; añadir más capas de juego antes de resolver la decisión estratégica del Feed (E00-03) sería construir sobre una base sin decidir.

---

## Fuentes consultadas

- [Cómo funciona la base de datos de MyFitnessPal](https://blog.myfitnesspal.com/how-food-database-works/)
- [How Accurate Is MyFitnessPal? — Nutrola](https://nutrola.app/en/blog/how-accurate-is-myfitnesspal)
- [Why Is MyFitnessPal So Inaccurate? — Nutrola](https://nutrola.app/en/blog/why-is-myfitnesspal-so-inaccurate)
- [Comunidad MyFitnessPal — entradas incorrectas](https://community.myfitnesspal.com/en/discussion/10862172/there-is-so-much-items-in-the-database-with-incorrect-nutritional-values)
- [Cronometer — Data Sources](https://support.cronometer.com/hc/en-us/articles/360018239472-Data-Sources)
- [How Accurate Is Cronometer? — ScienceInsights](https://scienceinsights.org/how-accurate-is-cronometer-what-the-data-shows/)
- [Cronometer — debate sobre Quick Add](https://forums.cronometer.com/discussion/2578/quick-add-feature)
- [MacroFactor — interpretar cambios de gasto energético](https://help.macrofactorapp.com/en/articles/26-how-should-i-interpret-changes-to-my-energy-expenditure)
- [MacroFactor — precisión del algoritmo](https://macrofactor.com/algorithm-accuracy/)
- [MacroFactor — AI Food Logging](https://macrofactor.com/ai-food-logging/)
- [MacroFactor — AI Food Logging (help center)](https://help.macrofactorapp.com/en/articles/258-ai-food-logging)
- [Lose It! Snap It — TechCrunch](https://techcrunch.com/2016/09/29/lose-it-launches-snap-it-to-let-users-count-calories-in-food-photos/)
- [How Reliable Is Snap It — Nutrola](https://nutrola.app/en/blog/how-reliable-is-lose-it-snap-it-photo-feature)
- [SnapCalorie — TechCrunch](https://techcrunch.com/2023/06/26/snapcalorie-computer-vision-health-app-raises-3m/)
- [SnapCalorie — Roboflow](https://blog.roboflow.com/count-calories-from-photos-computer-vision/)
- [USDA FoodData Central vs Open Food Facts — Nutrola](https://nutrola.app/en/blog/open-nutrition-datasets-compared-usda-openfoodfacts-nutrola)
- [Top Nutrition APIs 2026 — SpikeAPI](https://www.spikeapi.com/blog/top-nutrition-apis-for-developers-2026)
- [FatSecret Platform API](https://platform.fatsecret.com/platform-api)
- [MyFitnessPal — Recipe Importer](https://support.myfitnesspal.com/hc/en-us/articles/360032271592-How-does-the-Recipe-Importer-on-the-website-work)
- [Noom — sistema de colores](https://www.noom.com/support/faqs/using-the-app/logging-and-tracking/food-and-water/2025/10/how-nooms-food-color-system-works/)
- [Noom — revisión U.S. News](https://health.usnews.com/best-diet/noom-diet)
- [Streaks y consistencia — MyFoodBuddy](https://foodbuddy.my/blog/how-streaks-keep-you-consistent-with-calorie-tracking-20260612)
- [Gamificación en apps de salud — StriveCloud](https://www.strivecloud.io/blog/gamification-features-mhealth)
- [Streaks — Trophy.so](https://trophy.so/blog/streaks-gamification-case-study)
- [YAZIO vs Lifesum 2026 — Welling](https://www.welling.ai/articles/yazio-vs-lifesum-2026)
- [Apps compatibles con Google Fit — Lifestack](https://lifestack.ai/blog/apps-to-use-with-google-fit)
- [Fitia — sincronización con wearables](https://fitia.app/learn/article/best-calorie-tracking-apps-sync-fitness-tracker-2025)
- [TDEE, BMR y Mifflin-St Jeor — Nutrola](https://nutrola.app/en/blog/understanding-tdee-bmr-mifflin-st-jeor-equation-calorie-goals)
