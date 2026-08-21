# Investigación: registro por foto (BitePal, Foodvisor, Cal AI) y apps de entrenamiento

Investigación de campo (agosto 2026). Complementa a `docs/INVESTIGACION_APPS_NUTRICION.md`, que cubre las apps de conteo clásicas (MyFitnessPal, Cronometer, MacroFactor, Noom…) y de dónde salen los datos de **alimentos**. Este documento cubre lo que allí no estaba:

1. **Cómo funciona realmente el registro por foto** — el pipeline de visión de BitePal, Foodvisor, Cal AI, Lose It! Snap It y SnapCalorie, con los números de precisión medidos por estudios independientes.
2. **Apps de entrenamiento** — de dónde sacan el catálogo de ejercicios, cómo lo modelan (músculos, equipo, media), cómo el usuario "marca" un ejercicio/serie, cómo se calcula el progreso (e1RM, RIR/RPE, volumen) y de dónde salen las kcal quemadas.

Cada afirmación va con su fuente. Al final, recomendaciones concretas contra el código actual de FoodOS.

---

# PARTE 1 — Registro por foto: cómo funciona por dentro

## 1.1 El pipeline canónico (todas las apps hacen lo mismo, con variantes)

Todas las apps de "foto → calorías" ejecutan la misma cadena de 5 pasos. Lo que las diferencia es qué tecnología meten en cada paso:

```text
[1] Captura      → foto (a veces + descripción de texto, a veces + profundidad/LiDAR)
[2] Detección    → ¿qué alimentos hay en el plato? (segmentación + clasificación)
[3] Porción      → ¿cuánto hay de cada uno? (el paso que TODOS fallan)
[4] Lookup       → cruzar cada alimento contra una BD nutricional real
[5] Confirmación → el usuario corrige antes de guardar (y eso realimenta el modelo)
```

El paso **[3] Porción es el cuello de botella real**, no el [2]. Un estudio comparativo de 7 plataformas comerciales publicado en JMIR concluye literalmente que *"ninguna de las plataformas fue capaz de estimar la cantidad de comida"* ([JMIR / PMC7752530](https://pmc.ncbi.nlm.nih.gov/articles/PMC7752530/)). Reconocer que hay arroz es fácil; saber si son 80 g o 250 g es el problema no resuelto.

## 1.2 Precisión medida: los números que importan

Estudio JMIR con 185 imágenes en condiciones estandarizadas y reales (variando luz, recipiente, ángulo, desorden). Precisión **top-1** (el primer resultado es el correcto) y **top-5** (está entre los 5 primeros):

| Plataforma | Top-1 | Top-5 |
|---|---|---|
| Calorie Mama API | 62,9 % | 87,6 % |
| Bitesnap | 48,9 % | 71,0 % |
| **Foodvisor** | **46,2 %** | **71,5 %** |
| Clarifai | 38,2 % | 64,0 % |
| IBM Watson | 25,3 % | 43,5 % |
| LogMeal | 24,2 % | 44,1 % |
| Google Vision API | 9,1 % | 24,2 % |

Fuente: [JMIR, comparación de plataformas de reconocimiento de imagen de alimentos](https://pmc.ncbi.nlm.nih.gov/articles/PMC7752530/).

**Lectura clave para diseño de producto**: el hueco entre top-1 y top-5 es enorme (Foodvisor: 46 % → 71 %). Eso significa que **mostrar 3-5 candidatos y dejar elegir al usuario sube la precisión ~25 puntos porcentuales sin tocar el modelo**. Es la mejora de UX más barata que existe en este dominio.

Otros números de referencia:

- Un estudio de 2024 en *Nutrients* midió errores relativos entre **0,10 % y 38,3 %** en estimación de calorías por foto, según el plato ([vía Cal AI accuracy](https://www.caloriescanai.com/cal-ai/accuracy)).
- Foodvisor en pruebas de terceros: **±16,2 % MAPE**, mejor en cocina europea (francesa, italiana, española, mediterránea), peor en cadenas americanas y cocina panasiática ([Calorie Tracker Lab](https://calorietrackerlab.com/reviews/foodvisor/)).
- Lose It! "Snap It": identificó **todos** los componentes del plato solo en el **60 %** de las fotos; falla sistemáticamente con 3+ alimentos distintos ([Nutrola](https://nutrola.app/en/blog/how-reliable-is-lose-it-snap-it-photo-feature)).
- Consenso del sector: ~**80 % de acierto en la primera foto, 90-95 % tras una corrección rápida del usuario** ([CalorieScan AI](https://www.caloriescanai.com/cal-ai)).

## 1.3 Foodvisor — el enfoque "CNN propia + estimación geométrica"

Foodvisor es la referencia del enfoque clásico (pre-LLM), y sigue siendo instructivo porque su truco de porción es replicable sin hardware especial:

- Usa **redes neuronales convolucionales (CNN)** entrenadas específicamente sobre imágenes de comida para detectar los alimentos del plato ([Unite.AI](https://www.unite.ai/foodvisor-app-uses-deep-learning-to-monitor-maintain-your-diet/)).
- Para el peso: **mide el área de cada alimento en la imagen** y usa los **datos de autofocus de la cámara** para estimar la distancia teléfono↔plato. Con área + distancia + tipo de alimento (densidad conocida) extrapola la cantidad ([Unite.AI](https://www.unite.ai/foodvisor-app-uses-deep-learning-to-monitor-maintain-your-diet/), [RTInsights](https://www.rtinsights.com/foodvisor-ai-food-tracking/)).
- El usuario **puede corregir cualquier dato antes de que la comida se registre**, y la app pide activamente que se le reporten los alimentos que no supo identificar; esas imágenes vuelven al servidor y alimentan reentrenamientos periódicos de la red ([itmunch](https://itmunch.com/foodvisor-automatically-traces-eat-applying-deep-learning/)).
- Vende su **Vision API a empresas** bajo acuerdo comercial ([api-evangelist/foodvisor](https://github.com/api-evangelist/foodvisor)).

**El bucle de datos es el activo real**: correcciones del usuario → reentrenamiento → mejor modelo → más usuarios. Es un foso competitivo que una app pequeña no puede replicar… salvo que use un LLM generalista, que es exactamente lo que ha pasado desde 2024.

## 1.4 BitePal — el enfoque "LLM + gamificación afectiva"

BitePal es la generación nueva: no entrena visión propia, orquesta modelos multimodales y compite en **experiencia**, no en precisión.

- **Foto → puntuación nutricional + highlights + consejo simple**, no solo macros. Escanea también etiquetas de producto para extraer los datos nutricionales ([bitepal.app](https://bitepal.app/), [aichief](https://aichief.com/ai-lifestyle-tools/bitepal/)).
- Acepta también **entrada por texto** además de foto ([aipure](https://aipure.ai/products/bitepal)).
- **Timeline cronológico en vez de categorías**: comida, actividad, hidratación y ayuno intermitente aparecen todos en un único feed ordenado por hora, "como una red social pero de conductas de salud", en vez del típico desglose desayuno/comida/cena ([guía BitePal](https://wellness.alibaba.com/nutrition/bitepal-app-review-guide)).
- **Mapache virtual** que crece, reacciona a tus comidas, celebra el progreso y da consejos. Es su mecanismo de retención central — la reseña de 2026 lo llama *"un mecanismo de consistencia genuinamente efectivo para usuarios a los que les cuesta registrar"* ([Nutrola](https://nutrola.app/en/blog/bitepal-review-2026)).
- Reverso: **3,4M descargas pero críticas legítimas por huecos de precisión y facturación agresiva** ([Nutrola](https://nutrola.app/en/blog/bitepal-review-2026)).

**Lo importante de BitePal no es su IA, es su tesis de producto**: reducir la ansiedad del conteo (puntuación + mascota + tono no moralizante) en vez de maximizar exactitud. Es la posición opuesta a Cronometer.

FoodOS ya tiene **15 avatares/mascotas** (`apps/web/public`, `lib/mascots.ts`) sin un rol funcional fuerte. El patrón BitePal muestra la vía: la mascota como *feedback afectivo del cumplimiento*, no como decoración de perfil.

## 1.5 Cal AI — la validación de mercado del enfoque LLM

- Pipeline: foto → modelo de visión que identifica alimentos y **estima porciones** → multiplica contra una **base de datos nutricional** → devuelve macros en segundos ([CalorieScan AI](https://www.caloriescanai.com/cal-ai)).
- Precisión: ~10 % de error en platos simples, mucho peor con **aceites ocultos, salsas y platos mixtos** ([CalorieScan AI](https://www.caloriescanai.com/cal-ai/accuracy)).
- Contexto de negocio: lanzada en mayo de 2024 por fundadores adolescentes, bootstrapped a ~30M$ ARR y 15M+ descargas, **adquirida por MyFitnessPal en diciembre de 2025** ([askvora](https://askvora.com/blog/cal-ai-acquisition-photo-food-logging)). Free tier ~3 escaneos/día, premium ~9,99 $/mes.

Traducción: el líder histórico de la categoría (MFP, con la base de datos más grande del mundo) tuvo que **comprar** una app de 18 meses cuya única ventaja era el flujo de foto. **La fricción de registro venció al tamaño de la base de datos.**

## 1.6 SnapCalorie — resolver la porción con profundidad real

- Usa **sensores de profundidad (LiDAR)** para medir el volumen real del alimento en lugar de inferirlo de una imagen plana.
- Entrenado con 5.000 comidas cuyos ingredientes se **pesaron en báscula real**, no etiquetados a ojo a posteriori.
- Resultado: **margen de error <20 %**, el doble de preciso que un humano estimando a ojo ([TechCrunch](https://techcrunch.com/2023/06/26/snapcalorie-computer-vision-health-app-raises-3m/), [Roboflow](https://blog.roboflow.com/count-calories-from-photos-computer-vision/)).

Su base científica es **Nutrition5k** de Google: ~5.000 platos distintos, 20k vídeos cortos y 3,5k imágenes RGB-D capturadas con Intel RealSense, con ingredientes, cantidades y macros calculados desde la base del USDA. ~3.000 imágenes llevan **mapa de profundidad** asociado ([Nutrition5k, arXiv](https://arxiv.org/pdf/2103.03375), [dataset en GitHub](https://github.com/google-research-datasets/Nutrition5k)).

## 1.7 El estado del arte 2025-2026: LLM multimodal + RAG contra una BD real

Aquí está el hallazgo más accionable de toda la parte 1.

**DietAI24** (publicado en *Communications Medicine*, 2025) combina LLM multimodal + **RAG contra la base FNDDS** para anclar el reconocimiento visual en una base nutricional autorizada **en vez de confiar en el conocimiento interno del modelo**. Identifica alimentos, estima porciones y calcula **65 nutrientes**. Resultado: **63 % de reducción del MAE** en estimación de peso del alimento y de cuatro nutrientes clave frente a los métodos existentes, en platos mixtos reales (p < 0,05) ([Nature, Communications Medicine](https://www.nature.com/articles/s43856-025-01159-0)).

Complementos del mismo frente de investigación:

- **Objeto de referencia**: los modelos rinden *notablemente mejor* cuando hay un objeto de escala conocido en la foto (una moneda, un tenedor, una mano). Algunos pipelines detectan el objeto de referencia con YOLOv8 antes de pasar la imagen al LLM ([dev.to / GPT-4o + SAM](https://dev.to/beck_moulton/beyond-just-a-photo-building-a-pixel-perfect-calorie-estimator-with-sam-and-gpt-4o-1foj)).
- **Segmentación previa**: usar SAM (Segment Anything) para aislar cada alimento antes de estimar volumen mejora mucho platos con varios componentes ([dev.to](https://dev.to/wellallytech/beyond-just-a-photo-building-a-pixel-perfect-calorie-estimator-with-sam-and-gpt-4o-1foj)).
- **Gemini vs GPT**: Gemini 2.5 Flash estimó algo mejor masa, volumen y energía, pero **se negaba ocasionalmente** a estimar masa/volumen, por lo que algunos sistemas eligen GPT por estabilidad del flujo ([comparativa, arXiv](https://arxiv.org/pdf/2511.08215)).
- **MacroFactor** aplica la misma idea en producto: encadena varios prompts de LLM que descomponen la comida en ingredientes y **consultan la base de datos real** en vez de inventar valores, y permite añadir una descripción de texto junto a la foto ("curry de pollo con arroz y naan") ([MacroFactor](https://macrofactor.com/ai-food-logging/)).

**Conclusión operativa para FoodOS**: el patrón correcto no es "pregúntale las kcal al LLM". Es **LLM identifica y estima gramos → el gramaje se multiplica contra Open Food Facts / el inventario del usuario → el usuario confirma**. Esto es RAG, es lo que hace el estado del arte académico y lo que hace MacroFactor, y FoodOS ya tiene las dos mitades (`lib/ai-provider.ts` y `lib/food-db.ts` / `lib/food-lookup.ts`) sin unirlas todavía en un flujo de foto de plato.

## 1.8 Proveedores si no quieres construirlo

| Proveedor | Qué ofrece | Modelo de precio |
|---|---|---|
| **Passio Nutrition-AI** | SDK iOS/Android/Flutter/React Native + REST. Reconocimiento **on-device y en nube**, código de barras, logging por **voz**, BD de 2,5M+ ítems | Tokens: una foto ≈ 20-30k tokens; 2,50 $/M tokens por encima del plan ([Passio](https://www.passio.ai/cost-breakdown)) |
| **LogMeal** | API de imagen: alimentos, grupos de alimentos, platos, ingredientes, recetas + nutrición | Por plan ([LogMeal](https://logmeal.com/api/pricing/)) |
| **Foodvisor Vision API** | Su modelo propio, para empresas | Acuerdo comercial ([ref](https://github.com/api-evangelist/foodvisor)) |
| **Calorie Mama** | El más preciso del estudio JMIR (62,9 % top-1) | API de pago |

El on-device de Passio es la única opción con ventaja real de **privacidad** (la foto de comida no sale del móvil), un argumento comercial que ninguna app de las analizadas usa hoy.

---

# PARTE 2 — Apps de entrenamiento

## 2.1 De dónde sacan los ejercicios: las cinco fuentes reales

Existen exactamente cinco caminos, y toda app cae en uno o en una mezcla:

### (a) Datasets abiertos — gratis, sin fricción legal

| Fuente | Tamaño | Licencia | Notas |
|---|---|---|---|
| **free-exercise-db** (yuhonas) | 800+ ejercicios, un JSON por ejercicio, validados contra un JSON Schema estricto | **Unlicense (dominio público)** — sin atribución ni restricciones | Incluye imágenes, frontend buscable, CI que valida y despliega. Origen del dataset: Ollie Jennings ([GitHub](https://github.com/yuhonas/free-exercise-db)) |
| **everkinetic/data** | `exercises.json` | Abierto | Proyecto separado, otra genealogía del mismo tipo de dato ([GitHub](https://github.com/everkinetic/data/blob/main/exercises.json)) |
| **wger** | Catálogo colaborativo con traducciones | AGPL-3.0, **licencia por ejercicio** dentro del propio dato | Self-hostable, API REST ([GitHub](https://github.com/wger-project/wger)) |

### (b) APIs comerciales

- **ExerciseDB** (vía RapidAPI): 1.500+ ejercicios (algunas ediciones citan 5.000+) con parte del cuerpo objetivo, equipo, **GIFs animados**, imágenes e instrucciones paso a paso ([GitHub](https://github.com/bootstrapping-lab/exercisedb-api), [exercisedb.dev](https://static.exercisedb.dev/)). Ventaja: media visual lista. Desventaja: dependencia de RapidAPI.
- **WorkoutX** y similares: capas free-tier limitadas (~500 req/mes) sobre catálogos de ~1.400 ejercicios ([comparativa](https://workoutxapp.com/blog/best-free-exercise-api-2026.html)).

### (c) Catálogo curado internamente (el camino de las apps serias)

- **Fitbod**: 800+ ejercicios, con **entrenadores propios que puntúan cada ejercicio** por idoneidad según objetivo (fuerza / hipertrofia / fitness) y nivel (novato → avanzado) ([Fitbod](https://fitbod.me/blog/fitbod-algorithm/)).
- **Hevy**: 400+ ejercicios con filtros por equipo, músculo y tipo; el usuario puede **crear ejercicios propios** si falta alguno ([Hevy](https://www.hevyapp.com/features/exercise-library/)).
- **JEFIT**: 1.400+ ejercicios ([JEFIT](https://www.jefit.com/blog/best-strength-training-apps-for-2026-7-options-tested-by-lifters)).
- **Alpha Progression**: 795 ejercicios ([Alpha Progression](https://alphaprogression.com/en)).

Observa el rango: **400-1.500 ejercicios es el estándar del mercado**. Más no es mejor — Hevy compite arriba con 400.

### (d) Contenido de vídeo producido en casa

**Nike Training Club**: cada sesión está grabada y guiada en vídeo por un **Nike Master Trainer**, con producción profesional ([Nike](https://www.nike.com/ntc-app)). Es otro producto: no es un catálogo de datos, es una biblioteca audiovisual. Coste de producción altísimo, imposible de replicar sin equipo de contenido.

### (e) Programas licenciados de terceros

**Boostcamp**: 100+ programas licenciados de coaches reales (PPL, PHUL, PHAT, StrongLifts 5×5) con su lógica de progresión semanal ya codificada, y una biblioteca de 11.000+ programas ([Boostcamp](https://www.boostcamp.app/)). Compiten en **programación**, no en ejercicios.

### El caso concreto de FoodOS: qué devuelve wger

`ExercisesView.tsx:949` ya llama a `https://wger.de/api/v2/exerciseinfo/`. El modelo de datos real de ese endpoint es:

```text
id, uuid, created, last_update, last_update_global,
category            → { id, name }
muscles[]           → { id, name, name_en, is_front, image_url_main, image_url_secondary }
muscles_secondary[] → idem
equipment[]         → { id, name }
license             → { id, full_name, short_name, url }
license_author
images[] · videos[] · variation_group · author_history · total_authors_history
translations[]      → { id, uuid, name, description, language, aliases, notes,
                        license, license_title, license_author, ... }
```

Tres cosas que hoy FoodOS **no** está aprovechando y que ya vienen gratis en esa respuesta:

1. **`muscles[].image_url_main` / `image_url_secondary`** — wger sirve las siluetas del cuerpo con el músculo resaltado. Es exactamente el "muscle map" que Hevy y Fitbod presentan como feature visual, y está a un `<img>` de distancia.
2. **`muscles` vs `muscles_secondary`** — habilita el gráfico de *series por grupo muscular por semana*, que es LA métrica de la que vive Hevy ([Hevy](https://www.hevyapp.com/features/sets-per-muscle-group-per-week/)).
3. **`variation_group`** — permite ofrecer "sustituir por una variante" cuando falta equipo, sin ninguna heurística propia.

Además: la llamada actual usa `limit=20` y `language=2` (inglés) por categoría. wger tiene `translations[]` con **español** disponible; hoy el explorador muestra ejercicios en inglés dentro de una app en español.

## 2.2 Cómo se modela un ejercicio (el esquema mínimo del sector)

Convergen todas las fuentes en el mismo esquema:

```text
Ejercicio
├─ nombre (+ alias/traducciones)
├─ categoría / patrón de movimiento
├─ músculo primario[]        ← dirige el gráfico de volumen semanal
├─ músculos secundarios[]    ← cuentan como fracción de serie en apps serias
├─ equipo requerido[]        ← el filtro más usado en la práctica
├─ tipo de métrica: peso×reps | reps | tiempo | distancia | peso corporal±lastre
├─ instrucciones paso a paso
├─ media: imagen / GIF / vídeo
└─ metadatos de programación: idoneidad por objetivo y por nivel (Fitbod)
```

El campo que más se olvida y más rompe una app es **el tipo de métrica**: plancha (tiempo), dominadas (reps o reps+lastre), remo (distancia+tiempo) y press banca (peso×reps) no se registran igual. Si el modelo asume `peso × reps` para todo, media biblioteca queda inservible.

## 2.3 Cómo el usuario "marca" un ejercicio: la UX de logging

Patrón universal, idéntico en Hevy, Strong, Alpha Progression y JEFIT:

1. Se añaden ejercicios desde la biblioteca a la sesión.
2. Cada ejercicio tiene **filas de series**, con el peso/reps de la última vez **pre-rellenados en gris** como objetivo.
3. El usuario ajusta y **marca la serie como completada** (un check por fila) — esa es la unidad atómica del registro, no el ejercicio entero.
4. **El check dispara automáticamente el temporizador de descanso**, ajustable en pasos de 15 s o saltable ([Hevy](https://www.hevyapp.com/features/track-workouts/)).
5. Tipos de serie marcados aparte: calentamiento, dropset, fallo.
6. **RPE/RIR opcional por serie**, activable en ajustes, en escala de 10 puntos ([Hevy](https://www.hevyapp.com/how-to-track-workouts/)).
7. **Feedback háptico en cada interacción**, porque se usa con las manos sudadas y sin mirar bien la pantalla.
8. **Live Activity / notificación persistente** para que el temporizador siga visible con la pantalla bloqueada ([Hevy](https://www.hevyapp.com/features/live-activity/)).

Puntos de diseño no negociables que salen de aquí: la sesión es **stateful y en vivo** (se abre, se rellena durante 60-90 min, se cierra), tiene que **sobrevivir a que se cierre la app**, y el objetivo es **cero teclado**: pre-rellenar y que el usuario solo confirme.

FoodOS hoy registra la sesión como un **formulario post-hoc** (duración + kcal, `ExercisesView.tsx:725-788`). Es un modelo de datos distinto, no una versión reducida del anterior: sin series, no hay e1RM, ni PRs, ni volumen, ni progresión.

## 2.4 Cómo se calcula el progreso

### e1RM (1RM estimado) — el eje del progreso en fuerza

Nadie testea el 1RM real; se estima desde series de trabajo:

- **Epley (1985)**: `1RM = w × (1 + r/30)`. Es el **default más común en apps** y funciona bien en series duras de ~2-8 reps; Fitbod lo cita explícitamente ([Arvo](https://arvo.guru/resources/one-rep-max-formulas), [Fitbod](https://fitbod.me/blog/fitbod-algorithm/)).
- **Brzycki (1993)**: `1RM = w × 36/(37 − r)`. Más conservadora; mejor en 1-6 reps y al volver de un parón.
- Recomendación de las calculadoras serias: **promediar varias fórmulas** (Epley, Brzycki, Lombardi, Mayhew, Wathen) da estimaciones más fiables que cualquiera sola ([Strength Journeys](https://www.strengthjourneys.xyz/articles/how-do-i-calculate-my-e1rm-estimated-one-rep-max)).
- **Corrección por RIR**: 5 reps con RIR 2 no equivale a 5 reps al fallo. Si se registra RIR/RPE, hay que ajustar la intensidad efectiva antes de aplicar la fórmula ([Trainer Studio](https://www.trainerstudio.com/en/tools/1rm-calculator)).

### Volumen y landmarks

- Métrica central: **series efectivas por grupo muscular por semana**. El consenso que aplican las apps para hipertrofia es **10-20 series/músculo/semana** ([Fitbod](https://fitbod.me/blog/fitbod-algorithm/)).
- Rangos por objetivo, también consenso: fuerza 1-6 reps (~85-100 % 1RM, descansos 3-5 min); hipertrofia 6-12 reps; fitness general, reps más altas y descansos cortos ([Fitbod](https://fitbod.me/blog/fitbod-algorithm/)).

### El modelo de recuperación de Fitbod (el más documentado del mercado)

Cada vez que genera una sesión, Fitbod **puntúa los 800+ ejercicios y los rankea para ti**:

1. **Recuperación muscular**: cada grupo muscular tiene un **porcentaje de recuperación 0-100 %** derivado del historial reciente. Prioriza los bien recuperados, sobre la base de que el músculo entrenado necesita **48-72 h** para volver a entrenarse a intensidad completa.
2. **Idoneidad** por objetivo y nivel, puntuada por entrenadores propios.
3. **Feedback histórico**: aprende qué ejercicios añades, quitas o marcas como favoritos y despriorriza los que no te gustan.
4. **Compatibilidad con el split** (Push/Pull/Legs) o maximización de frescura muscular.
5. **Equipo disponible**: filtro duro.
6. **Peso sugerido**: desde el **e1RM (Epley)**, refinado continuamente con lo que realmente levantas. Para ejercicios nuevos, siembra el peso inicial con **datos agregados de millones de usuarios con perfil similar**.
7. **Variación dinámica**: alterna días pesados y ligeros en vez de repetir el mismo esquema.
8. Si un músculo sigue fatigado pero debe entrenarse, sugiere **variantes de menor intensidad** en vez de excluirlo.
9. Con Apple Health / Fitbit / Strava conectados, el **cardio también cuenta** para la fatiga.

Fuentes: [Fitbod algorithm](https://fitbod.me/blog/fitbod-algorithm/), [Fitbod Help Center](https://help.fitbod.me/hc/en-us/articles/360004429814-How-Fitbod-Creates-Your-Workout), [Fitbod muscle recovery](https://fitbod.me/blog/muscle-recovery/).

Es replicable con una heurística simple: `recuperación = f(horas desde el último estímulo, volumen de ese estímulo)` con una ventana de 48-72 h, sobre los campos `muscles` / `muscles_secondary` que **wger ya devuelve**.

## 2.5 De dónde salen las calorías quemadas (y por qué casi todas mienten)

### El estándar: METs

- **1 MET** = gasto en reposo ≈ **3,5 ml de O₂ por kg de peso por minuto**.
- Fórmula del sector: `kcal = MET × peso(kg) × horas`.
- La fuente autorizada es el **Compendium of Physical Activities**, cuya **actualización de 2024** cubre el coste energético de **más de 1.000 actividades**, añade 300+ nuevas (incluida una sección de videojuegos) y suma compendios separados para **mayores** y para **usuarios de silla de ruedas** ([pacompendium.com](https://pacompendium.com/), [KU Medical Center](https://www.kumc.edu/about/news/news-archive/compendium-of-physical-activities.html)).
- Los números que dan relojes y apps **muy probablemente vienen de ahí** ([KUMC](https://www.kumc.edu/about/news/news-archive/compendium-of-physical-activities.html)).

### El problema con la fuerza

- El modelo MET **asume esfuerzo constante durante toda la sesión**, y el entrenamiento de fuerza tiene ratios trabajo/descanso muy variables según ejercicio, carga, rango de reps y descansos ([traincalc](https://traincalc.com/guides/why-calorie-burn-estimates-dont-match)).
- Las apps de fuerza de terceros estiman con **tablas MET genéricas** y no miden nada: son **más consistentes** que Apple precisamente porque ignoran pulso y movimiento.
- **EPOC** (gasto post-ejercicio) suma un **6-15 %** según intensidad, y **ya suele estar incluido** en las estimaciones — sumarlo a mano lo duplica ([wellness.alibaba](https://wellness.alibaba.com/fitlife/calories-burned-during-strength-training)).

### El dato demoledor sobre los wearables

- El Apple Watch mide **frecuencia cardiaca con <5 % de error**, pero falla las **calorías en ~28 % de media**.
- En **entrenamiento de resistencia sobreestima ~52 %** en pruebas controladas.
- En general, sobreestimación del **20-40 %** ([MacRumors](https://www.macrumors.com/2025/06/05/apple-watch-gets-fitness-metric-wrong/), [Empirical Health](https://www.empirical.health/blog/apple-watch-calories-accuracy/), [Nutrola](https://nutrola.app/en/blog/how-accurate-are-fitness-tracker-calorie-burn-estimates)).

**Esto valida retroactivamente la decisión de PR1 de FoodOS** (no sumar las kcal del entrenamiento al presupuesto y mostrarlas solo como información). Si la señal de entrada tiene un sesgo del +28 al +52 %, sumarla al presupuesto de comida es sistemáticamente contraproducente. Merece la pena dejar esto escrito en `docs/DECISIONES_PRODUCTO.md` con estas fuentes, porque es de esas decisiones que alguien intenta "arreglar" cada seis meses.

FoodOS usa hoy **MET 5,0 fijo** para fuerza (`ExercisesView.tsx:725`). Está en el rango correcto y es defendible; la mejora barata no es afinar el número, sino **etiquetarlo como estimación** (ya se hace: `(estimado)`, línea 841) y **derivar el MET de la categoría del ejercicio** en vez de usar una constante.

## 2.6 Tabla comparativa — apps de entrenamiento

| App | Catálogo | Fuente | Diferenciador | Modelo |
|---|---|---|---|---|
| **Hevy** | 400+ | Curado interno + ejercicios de usuario | UX de logging + social + gráficos de volumen por músculo | Freemium |
| **Strong** | Curado interno | Interno | Logging rapidísimo, calculadora de discos, gráficos de PR | Freemium |
| **Fitbod** | 800+ | Curado interno, puntuado por entrenadores | **Generación algorítmica** con recuperación muscular 0-100 % | Suscripción |
| **JEFIT** | 1.400+ | Curado interno + rutinas de comunidad | Catálogo grande + planes Elite | Freemium |
| **Alpha Progression** | 795 | Curado interno | Periodización, deloads, prescribe peso/reps/RIR por serie | Freemium |
| **Boostcamp** | — | **Programas licenciados** (100+ / 11.000+) | Programas de coaches reales con progresión codificada | Gratis |
| **wger** | Colaborativo | Open source, API REST, licencia por ejercicio | Self-hosted, datos abiertos, multiidioma | AGPL-3.0 |
| **Nike Training Club** | Vídeo | **Producción propia** con Master Trainers | Sesiones guiadas en vídeo | Gratis/marca |
| **FoodOS (hoy)** | wger (20/categoría, en inglés) | wger + generación IA | Integración nutrición↔ejercicio en una sola app | — |

---

# PARTE 3 — Qué significa esto para FoodOS

Ordenado por relación valor/esfuerzo, contra el código que ya existe.

## Alto valor, bajo esfuerzo

1. **Top-5 en vez de top-1 en cualquier reconocimiento por IA.** El estudio JMIR muestra +25 puntos de precisión solo por mostrar candidatos en vez de un único resultado. Aplica igual al escaneo de tickets (`BulkImportModal`) que a una futura foto de plato. Coste: cambiar el prompt para pedir un array de candidatos con confianza y renderizar un selector.
2. **Usar `translations[]` de wger en español.** Hoy `ExercisesView.tsx:949` pide `language=2` (inglés) en una app en español. Cambio de una línea + fallback a inglés si falta la traducción.
3. **Mostrar las siluetas musculares de wger.** `muscles[].image_url_main` ya viene en la respuesta que se está descargando y descartando. Es la feature visual que las apps comerciales venden como premium.
4. **Quitar `limit=20`.** Se está viendo una fracción arbitraria del catálogo por categoría.
5. **Dejar por escrito la política de kcal de ejercicio** en `docs/DECISIONES_PRODUCTO.md`, con las fuentes de §2.5 (sobreestimación del 28-52 % de los wearables). Protege la decisión de PR1 de futuras "mejoras".

## Alto valor, esfuerzo medio

6. **Foto de plato → RAG contra Open Food Facts, no kcal inventadas por el LLM.** Es el patrón de DietAI24 (−63 % MAE) y de MacroFactor. FoodOS tiene las dos mitades sin conectar: `lib/ai-provider.ts` y `lib/food-db.ts` / `lib/food-lookup.ts`. Flujo correcto: **el LLM identifica alimentos y estima gramos → los gramos se multiplican contra la BD real → el usuario confirma antes de guardar**. Encaja con E15-06 del backlog.
7. **Foto + texto opcional.** MacroFactor deja añadir una descripción corta junto a la foto y sube mucho la precisión en platos regionales o complejos. Coste marginal: un input de texto.
8. **Sugerir un objeto de referencia en la captura** ("pon un tenedor o una mano al lado"). La investigación muestra mejora notable con escala conocida, y no requiere ni modelo ni hardware — solo copy en la pantalla de cámara.
9. **Registro de sesión por series.** Es el salto de modelo de datos que separa un formulario de un tracker: filas de series con peso/reps, check por serie, temporizador de descanso automático al marcar, prellenado con la última sesión, RIR opcional. Desbloquea de golpe e1RM, PRs, volumen semanal y progresión. Es el mayor cambio de esta lista y el más estructural.

## Valor medio / a evaluar

10. **Dar rol funcional a las mascotas.** FoodOS tiene 15 avatares sin función; BitePal demuestra que la mascota reactiva al cumplimiento es un mecanismo de retención real. Cuidado con el equilibrio: `docs/BACKLOG.md` (E11-12, E23) ya fija lenguaje no moralizante, y una mascota que se "entristece" cruza esa línea. La versión sana: celebra la consistencia, nunca castiga.
11. **Recuperación muscular estilo Fitbod.** Con `muscles`/`muscles_secondary` de wger y el historial de sesiones, una heurística de 48-72 h da un mapa de recuperación sin ML. Solo tiene sentido *después* del punto 9 (sin series, no hay volumen que decaer).
12. **MET por categoría de ejercicio** en vez del 5,0 constante, tomando valores del Compendium 2024.
13. **free-exercise-db como respaldo offline.** Dominio público (Unlicense), 800+ ejercicios con imágenes, sin restricciones. FoodOS es una PWA con modo offline y hoy el explorador de ejercicios depende de una llamada de red a wger.de.

## Explícitamente NO copiar

- **La estimación de porción "a ciegas" sin confirmación.** Ninguna plataforma comercial sabe estimar cantidad ([JMIR](https://pmc.ncbi.nlm.nih.gov/articles/PMC7752530/)); guardar el resultado sin revisión humana es propagar un error de hasta el 38 %.
- **Sumar las kcal del wearable/ejercicio al presupuesto de comida.** Sesgo de +28-52 %.
- **La facturación agresiva de BitePal**, que es la crítica principal a una app por lo demás bien diseñada.
- **Perseguir el tamaño del catálogo de ejercicios.** Hevy compite en la cima con 400. El foso está en la UX de logging, no en el número.
