# Backlog maestro de FoodOS

## 1. Convenciones

### Prioridad

| Nivel  | Significado                                                                     |
| ------ | ------------------------------------------------------------------------------- |
| **P0** | Error, riesgo de confianza, seguridad, datos incorrectos o bloqueo estructural. |
| **P1** | Mejora crítica para que FoodOS parezca y funcione como producto profesional.    |
| **P2** | Mejora importante de usabilidad, retención o claridad.                          |
| **P3** | Evolución posterior del producto.                                               |
| **P4** | Exploración futura; no construir hasta validar la base.                         |

### Esfuerzo

| Tamaño | Referencia                             |
| ------ | --------------------------------------- |
| **XS** | Menos de 1 día.                        |
| **S**  | 1–2 días.                              |
| **M**  | 3–5 días.                              |
| **L**  | 1–2 semanas.                           |
| **XL** | Más de 2 semanas o requiere dividirse. |

### Estados propuestos

`Pendiente` · `En diseño` · `Preparado` · `En desarrollo` · `En revisión` · `Bloqueado` · `Hecho` · `Descartado`

---

# 2. Trabajo ya completado y excluido

No deben crearse tickets nuevos para estos puntos salvo regresiones:

| Elemento                                          | Estado |
| ------------------------------------------------- | ------ |
| Evitar doble conteo de calorías del entrenamiento | Hecho  |
| Mostrar gasto del entrenamiento como información  | Hecho  |
| Objetivo de fibra                                 | Hecho  |
| Preferencia de reparto grasa/carbohidratos        | Hecho  |
| Versionado inicial del modelo de actividad        | Hecho  |
| Snapshots nutricionales inmutables                | Hecho  |
| Tablas de propuestas de ajuste                    | Hecho  |
| Bloqueo automático por debajo de 800 kcal         | Hecho  |
| Aviso por objetivo inferior al 70 % del TDEE      | Hecho  |
| Aviso por objetivo inferior a la TMB estimada     | Hecho  |
| Avisos cuando macros proceden de IA               | Hecho  |
| Arreglo de rutinas IA truncadas                   | Hecho  |
| Evitar que ejercicios terminen en inventario      | Hecho  |
| Errores de cámara específicos                     | Hecho  |
| Bloqueo de scroll detrás del menú móvil           | Hecho  |
| Reducción global de movimiento                    | Hecho  |
| Trampa y restauración de foco en modales          | Hecho  |

---

# ÉPICA E00 — Definición estratégica del producto

**Objetivo:** decidir qué es FoodOS antes de seguir añadiendo módulos.

**Dependencia:** ninguna. Bloquea varias decisiones de navegación y diseño.

| ID     |  P | Esf. | Ticket                                     | Criterios de aceptación                                                                     |
| ------ | -: | ---: | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| E00-01 | P0 |    S | Definir la promesa principal de FoodOS     | Existe una frase aprobada que explica el producto en menos de 20 palabras.                  |
| E00-02 | P0 |    M | Decidir el alcance definitivo de Finanzas  | Queda documentado si será presupuesto alimentario o gestor financiero completo.             |
| E00-03 | P0 |    S | Decidir el futuro del Feed                 | Se elige entre eliminarlo, convertirlo en Inspiración o desarrollar comunidad real.         |
| E00-04 | P1 |    S | Definir los tres pilares del producto      | Cada función actual pertenece claramente a Alimentación, Organización o Progreso.           |
| E00-05 | P1 |    M | Crear mapa funcional de módulos            | Existe un mapa con entradas, salidas y relaciones entre todos los módulos.                  |
| E00-06 | P1 |    M | Identificar las cinco acciones principales | Quedan fijadas las acciones que deben realizarse en menos de dos interacciones.             |
| E00-07 | P1 |    S | Definir usuario principal y secundarios    | Se documenta para quién se diseña primero y qué necesidades quedan fuera.                   |
| E00-08 | P2 |    S | Definir principios de producto             | Se aprueban reglas como «reducir fricción», «no moralizar» y «diferenciar estimaciones».    |
| E00-09 | P2 |    M | Auditar funciones sin uso claro            | Cada función recibe estado: mantener, ocultar, rediseñar, fusionar o eliminar.              |
| E00-10 | P2 |    M | Definir métricas de éxito                  | Se fijan activación, registro semanal, retención, comidas registradas y planes completados. |

---

# ÉPICA E01 — Rutas, navegación y arquitectura técnica

**Objetivo:** sustituir la navegación basada únicamente en estado por rutas reales.

**Archivos probables:** `DashboardShell.tsx`, `app/dashboard`, componentes de vistas y modales.

| ID     |  P | Esf. | Ticket                                      | Criterios de aceptación                                            |
| ------ | -: | ---: | -------------------------------------------- | -------------------------------------------------------------------- |
| E01-01 | P0 |    L | Crear rutas independientes por sección      | Cada sección tiene URL propia y puede abrirse directamente.        |
| E01-02 | P0 |    M | Sincronizar la navegación con el historial  | Atrás y Adelante cambian correctamente entre secciones.            |
| E01-03 | P0 |    M | Conservar sección al recargar               | Una recarga mantiene al usuario en la misma vista.                 |
| E01-04 | P1 |    M | Crear rutas para detalles de recetas        | Una receta puede enlazarse mediante identificador.                 |
| E01-05 | P1 |    M | Crear rutas para alimentos del inventario   | Un lote o producto puede abrirse mediante URL propia.              |
| E01-06 | P1 |    M | Crear rutas para rutinas y sesiones         | Las rutinas pueden abrirse, editarse y compartirse mediante ruta.  |
| E01-07 | P1 |    M | Adaptar modales a rutas interceptadas       | Cerrar un detalle devuelve a la ruta anterior sin perder contexto. |
| E01-08 | P1 |    S | Añadir títulos y metadatos por ruta         | Cada sección genera un título de página adecuado.                  |
| E01-09 | P1 |    M | Crear página 404 interna                    | Una entidad inexistente muestra recuperación y acceso al módulo.   |
| E01-10 | P2 |    S | Conservar filtros en query parameters       | Búsqueda, etiqueta y orden pueden compartirse y restaurarse.       |
| E01-11 | P2 |    S | Restaurar posición de scroll por ruta       | Volver a una sección recupera la posición anterior.                |
| E01-12 | P2 |    M | Añadir navegación programática centralizada | No quedan llamadas aisladas a `setView` como sistema principal.    |

---

# ÉPICA E02 — Autenticación, sesión y carga inicial

**Objetivo:** eliminar la pantalla rudimentaria de «Comprobando sesión…».

**Archivos probables:** `DashboardShell.tsx`, proveedor de estado, capa Supabase y layout.

| ID     |  P | Esf. | Ticket                                             | Criterios de aceptación                                                          |
| ------ | -: | ---: | ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| E02-01 | P0 |    M | Sustituir la pantalla de comprobación por skeleton | Se muestra el shell real sin métricas inventadas mientras se resuelve la sesión. |
| E02-02 | P0 |    M | Distinguir carga, error y sesión caducada          | Cada estado tiene mensaje y acciones diferentes.                                 |
| E02-03 | P0 |    M | Añadir tiempo máximo de comprobación               | Una sesión colgada termina en un estado recuperable.                             |
| E02-04 | P1 |    M | Añadir botón Reintentar                            | El usuario puede repetir la comprobación sin recargar toda la aplicación.        |
| E02-05 | P1 |    L | Evaluar autenticación de Supabase en servidor      | Existe prueba técnica y decisión documentada sobre cookies y middleware.         |
| E02-06 | P1 |    M | Evitar parpadeo de tema al iniciar                 | El tema correcto se aplica antes de mostrar la interfaz.                         |
| E02-07 | P1 |    M | Distinguir sesión online de estado local           | La aplicación explica cuándo los cambios solo están en el dispositivo.           |
| E02-08 | P1 |    M | Definir comportamiento offline sin sesión validada | No se destruyen ni ocultan datos locales innecesariamente.                       |
| E02-09 | P2 |    S | Añadir indicador de sincronización inicial         | Se comunica cuándo los datos están actualizados.                                 |
| E02-10 | P2 |    M | Instrumentar duración de autenticación             | Se registra cuánto tarda la resolución de sesión y su tasa de error.             |

---

# ÉPICA E03 — Sistema de diseño y tokens

**Objetivo:** convertir los estilos actuales en un sistema coherente y mantenible.

**Archivos probables:** `globals.css`, `dashboard.css`, nuevos componentes UI y módulos CSS.

| ID     |  P | Esf. | Ticket                               | Criterios de aceptación                                                          |
| ------ | -: | ---: | --------------------------------------- | -------------------------------------------------------------------------------- |
| E03-01 | P0 |    M | Inventariar colores actuales         | Todos los colores quedan clasificados por función y uso.                         |
| E03-02 | P0 |    M | Redefinir paleta semántica            | Marca, éxito, información, advertencia y peligro dejan de compartir significado. |
| E03-03 | P0 |    M | Neutralizar el tema claro             | Las tarjetas principales son blancas o neutras, no verde intenso.                |
| E03-04 | P0 |    S | Corregir el color fijo del anillo     | El centro del anillo utiliza tokens compatibles con ambos temas.                 |
| E03-05 | P1 |    M | Definir colores globales de macros    | Proteína, carbohidratos, grasa y fibra usan colores constantes.                  |
| E03-06 | P1 |    S | Crear escala tipográfica              | Todos los tamaños quedan definidos mediante tokens.                              |
| E03-07 | P1 |    S | Elevar el mínimo de texto secundario  | No quedan textos funcionales de 9–10 px.                                         |
| E03-08 | P1 |    S | Añadir números tabulares globales     | Todas las métricas monetarias, nutricionales y deportivas quedan alineadas.      |
| E03-09 | P1 |    S | Crear escala de espaciado             | Se utiliza una escala común de 4, 8, 12, 16, 24, 32, 48 y 64.                    |
| E03-10 | P1 |    S | Unificar radios                       | Campos, botones, tarjetas y modales tienen radios definidos.                     |
| E03-11 | P1 |    S | Unificar sombras                      | Las tarjetas normales no utilizan sombras pesadas.                               |
| E03-12 | P1 |    M | Sustituir iconos Unicode              | La navegación y acciones usan una librería SVG coherente.                        |
| E03-13 | P1 |    S | Reducir textura de ruido              | El ruido se elimina de formularios y superficies densas.                         |
| E03-14 | P1 |    L | Crear componentes UI base             | Existen Button, IconButton, Card, Badge, Field, Tabs, Dialog y EmptyState.       |
| E03-15 | P2 |    M | Crear documentación visual            | Cada componente tiene ejemplos, variantes y estados.                             |
| E03-16 | P2 |   XL | Dividir `dashboard.css`               | Los estilos quedan separados por tokens, componentes y módulos.                  |
| E03-17 | P2 |    M | Eliminar estilos inline repetidos     | Los patrones recurrentes se convierten en clases o componentes.                  |
| E03-18 | P2 |    M | Auditar estilos muertos               | Se eliminan selectores no utilizados y duplicados.                               |

---

# ÉPICA E04 — Shell, navegación y experiencia móvil

**Objetivo:** reducir la sobrecarga de la navegación y mejorar el uso con una mano.

| ID     |  P | Esf. | Ticket                                 | Criterios de aceptación                                                           |
| ------ | -: | ---: | ----------------------------------------- | ------------------------------------------------------------------------------------ |
| E04-01 | P0 |    M | Agrupar la navegación por dominios     | Las doce entradas dejan de aparecer como opciones equivalentes.                   |
| E04-02 | P0 |    M | Añadir `aria-current`                  | La sección activa se comunica visualmente y a lectores de pantalla.               |
| E04-03 | P1 |    L | Crear barra inferior móvil             | Hoy, Diario, Añadir, Plan y Más son accesibles con el pulgar.                     |
| E04-04 | P1 |    M | Crear acción universal Añadir          | Desde cualquier sección puede registrarse comida, alimento, peso, gasto o sesión. |
| E04-05 | P1 |    M | Reducir altura de cabecera             | El título no consume una parte excesiva del viewport.                             |
| E04-06 | P1 |    S | Mover herramientas admin               | No aparecen en la cabecera de uso habitual.                                       |
| E04-07 | P1 |    M | Añadir estado de sincronización        | La cabecera distingue guardado, sincronizando, offline y error.                   |
| E04-08 | P1 |    M | Crear versión colapsada de sidebar     | La navegación puede compactarse sin perder claridad.                              |
| E04-09 | P1 |    M | Añadir menú Más en móvil               | Las funciones secundarias están accesibles sin drawer constante.                  |
| E04-10 | P2 |    M | Añadir buscador global                 | Busca recetas, alimentos, ajustes y rutinas.                                      |
| E04-11 | P2 |    M | Crear paleta `Ctrl/Cmd + K`            | Permite navegar y ejecutar acciones frecuentes.                                   |
| E04-12 | P2 |    S | Añadir tecla `/` para búsqueda         | Funciona salvo cuando el foco está en un campo.                                   |
| E04-13 | P2 |    M | Permitir fijar accesos favoritos       | El usuario puede personalizar accesos rápidos.                                    |
| E04-14 | P2 |    M | Añadir breadcrumbs en vistas profundas | Los detalles muestran siempre su contexto.                                        |

---

# ÉPICA E05 — Dashboard «Hoy»

**Objetivo:** convertir el Panel en un centro de decisión, no en una colección de widgets.

| ID     |  P | Esf. | Ticket                                | Criterios de aceptación                                                  |
| ------ | -: | ---: | ---------------------------------------- | ------------------------------------------------------------------------ |
| E05-01 | P0 |    M | Definir jerarquía de tarjetas         | Estado del día y siguiente acción aparecen primero.                      |
| E05-02 | P0 |    L | Rediseñar la tarjeta principal de hoy | Muestra consumido, restante, proteína y estado del día claramente.       |
| E05-03 | P1 |    M | Unificar recomendaciones              | Caducidad, proteína, hora y presupuesto producen una sola recomendación. |
| E05-04 | P1 |    M | Mostrar razones de la recomendación   | El usuario entiende por qué se sugiere una receta.                       |
| E05-05 | P1 |    S | Reducir duplicación de la mascota     | Solo queda una representación principal de la mascota.                   |
| E05-06 | P1 |    M | Hacer compactos agua y pasos          | No compiten con la información nutricional principal.                    |
| E05-07 | P1 |    M | Crear resumen del plan del día        | Las comidas previstas pueden abrirse y registrarse.                      |
| E05-08 | P1 |    M | Priorizar alertas accionables         | Cada alerta incluye una acción concreta.                                 |
| E05-09 | P1 |    M | Añadir estado «sin configurar»        | El Panel guía al usuario cuando faltan perfil o inventario.              |
| E05-10 | P2 |    L | Permitir personalizar tarjetas        | Pueden ocultarse, mostrarse y reordenarse.                               |
| E05-11 | P2 |    M | Crear modo compacto                   | Reduce espacio y densidad para usuarios avanzados.                       |
| E05-12 | P2 |    M | Añadir tendencia semanal mínima       | Muestra una única tendencia útil sin duplicar Estadísticas.              |
| E05-13 | P2 |    S | Eliminar textos redundantes           | Las tarjetas no explican lo que ya resulta evidente.                     |
| E05-14 | P2 |    M | Añadir skeleton específico            | La carga conserva exactamente el layout final.                           |

---

# ÉPICA E06 — Diario y registro de comidas

**Objetivo:** registrar comidas en segundos.

| ID     |  P | Esf. | Ticket                                     | Criterios de aceptación                                             |
| ------ | -: | ---: | --------------------------------------------- | ----------------------------------------------------------------------- |
| E06-01 | P0 |   XS | Convertir nombres clicables en botones     | Todas las entradas pueden abrirse con teclado.                      |
| E06-02 | P0 |   XS | Eliminar referencia admin del estado vacío | Un usuario normal no recibe instrucciones sobre botones invisibles. |
| E06-03 | P1 |    M | Enfocar buscador al abrir registro         | El usuario puede escribir inmediatamente.                           |
| E06-04 | P1 |    M | Añadir alimentos recientes                 | Se muestran las últimas selecciones utilizadas.                     |
| E06-05 | P1 |    M | Añadir alimentos frecuentes por hora       | Desayunos, comidas y cenas se sugieren contextualmente.             |
| E06-06 | P1 |    M | Añadir «Repetir última comida»             | Una comida completa se duplica con revisión previa.                 |
| E06-07 | P1 |    M | Añadir «Copiar de ayer»                    | Se puede copiar una comida o el día completo.                       |
| E06-08 | P1 |    L | Crear registro múltiple                    | Se añaden varios alimentos a una comida en una operación.           |
| E06-09 | P1 |    M | Guardar comida habitual                    | Una combinación puede reutilizarse como plantilla.                  |
| E06-10 | P1 |    M | Añadir selector de raciones habituales     | Incluye 100 g, 150 g, unidad y última cantidad usada.               |
| E06-11 | P1 |    M | Crear selector de fecha                    | El usuario navega a un día sin recorrer listas.                     |
| E06-12 | P1 |    M | Crear vista semanal                        | Resume consumo y permite abrir cada día.                            |
| E06-13 | P1 |    M | Implementar carga progresiva               | El historial no renderiza indefinidamente todos los días.           |
| E06-14 | P1 |    M | Confirmar «Reiniciar día»                  | Explica qué datos se eliminan y devuelve inventario.                |
| E06-15 | P1 |    S | Añadir deshacer a Reiniciar día            | El estado completo puede restaurarse.                               |
| E06-16 | P2 |    M | Añadir entrada mediante texto natural      | Analiza una frase y presenta vista previa editable.                 |
| E06-17 | P2 |    M | Añadir duplicado rápido desde una entrada  | Una comida puede copiarse a hoy u otra fecha.                       |
| E06-18 | P2 |    S | Mostrar estado de guardado                 | La edición optimista comunica éxito o fallo.                        |
| E06-19 | P2 |    M | Reducir duplicación del panel de agua      | El Diario muestra detalle y Hoy solo un resumen.                    |

---

# ÉPICA E07 — Inventario

**Objetivo:** simplificar la entrada sin perder la profundidad actual.

| ID     |  P | Esf. | Ticket                                      | Criterios de aceptación                                        |
| ------ | -: | ---: | ---------------------------------------------- | ------------------------------------------------------------------ |
| E07-01 | P0 |    S | Eliminar macros ficticios predeterminados   | Kcal y proteína empiezan vacías o como propuesta visible.      |
| E07-02 | P0 |    S | Eliminar precio predeterminado              | No puede guardarse 2,80 € accidentalmente.                     |
| E07-03 | P0 |    S | Revisar caducidad predeterminada            | No se asignan cuatro días a todos los alimentos.               |
| E07-04 | P0 |    S | Validar todos los valores numéricos         | No se guardan cantidades negativas, `NaN` o tamaños inválidos. |
| E07-05 | P1 |    M | Crear modo Añadir rápido                    | Solo pide nombre, cantidad, lugar y caducidad.                 |
| E07-06 | P1 |    M | Crear sección de datos avanzados            | Precio, macros, marca e imagen quedan colapsados.               |
| E07-07 | P1 |    L | Convertir autocompletado en combobox        | Funciona con teclado, lector de pantalla y selección activa.   |
| E07-08 | P1 |    M | Mostrar claramente la fuente                | Local, OFF, IA y manual se distinguen.                          |
| E07-09 | P1 |    M | Agrupar lotes por producto                  | Se muestra cantidad total y lotes ordenados por caducidad.     |
| E07-10 | P1 |    M | Añadir acciones masivas                     | Mover, eliminar, añadir a lista y cambiar caducidad.           |
| E07-11 | P1 |    M | Crear vista tabla para escritorio           | Permite ordenar por nombre, cantidad, lugar y caducidad.       |
| E07-12 | P1 |    M | Mantener vista tarjetas en móvil            | La interfaz sigue siendo táctil y legible.                     |
| E07-13 | P1 |    S | Añadir filtro «Caduca pronto»               | Muestra productos dentro del umbral configurado.               |
| E07-14 | P1 |    S | Añadir filtro «Stock bajo»                  | Utiliza los umbrales de usuario.                               |
| E07-15 | P1 |    M | Detectar posibles duplicados                | Antes de guardar, propone fusionar con un producto existente.  |
| E07-16 | P1 |    M | Crear historial de movimientos              | Se registra entrada, consumo, compra y devolución.             |
| E07-17 | P2 |    M | Recordar última ubicación por producto      | Sugiere nevera, despensa o congelador.                          |
| E07-18 | P2 |    M | Añadir estimación de caducidad explicada    | La propuesta siempre se identifica como estimada.               |
| E07-19 | P2 |    L | Añadir importación masiva revisable         | Los elementos de ticket se corrigen antes de guardarse.        |
| E07-20 | P2 |    M | Mejorar experiencia de cámara no compatible | Ofrece entrada manual y explicación sin callejón sin salida.   |
| E07-21 | P2 |    L | Añadir historial de precios por producto    | Cada compra actualiza precio y tienda.                          |
| E07-22 | P3 |    L | Añadir comparador de precio por unidad      | Compara formatos, tiendas y compras anteriores.                |
| E07-23 | P3 |    S | Mostrar NOVA/Nutri-Score como dato neutro   | Se muestra la letra/grupo tal cual en la ficha de producto, sin semáforo de color ni juicio de valor — ver `INVESTIGACION_VISION_Y_ENTRENAMIENTO.md` (riesgo Noom) y E11-12/E23 (lenguaje no moralizante). Preferir NOVA sobre Nutri-Score si solo se implementa uno: Nutri-Score penaliza por densidad calórica y clasifica mal grasas saludables (aceite de oliva, frutos secos). |

---

# ÉPICA E08 — Recetas

**Objetivo:** hacer que descubrir y cocinar recetas sea claro, rápido y fiable.

| ID     |  P | Esf. | Ticket                                  | Criterios de aceptación                                            |
| ------ | -: | ---: | ------------------------------------------ | ------------------------------------------------------------------ |
| E08-01 | P0 |    S | Unificar formato monetario              | Todos los costes usan `Intl.NumberFormat` de `es-ES`.              |
| E08-02 | P1 |    M | Unificar filtros duplicados             | Disponibilidad y ahorro no tienen controles paralelos redundantes. |
| E08-03 | P1 |    M | Separar Ordenar de Filtrar              | El usuario entiende qué cambia contenido y qué cambia orden.       |
| E08-04 | P1 |    M | Reducir acciones visibles por tarjeta   | Solo Cocinar y Ver quedan visibles; el resto va en menú.           |
| E08-05 | P1 |    M | Mostrar ingredientes faltantes          | Se enumeran los productos que faltan y su coste aproximado.        |
| E08-06 | P1 |    M | Mostrar cantidad disponible real        | El porcentaje considera cantidades, no solo nombres.               |
| E08-07 | P1 |    L | Endurecer matching de ingredientes      | Se evitan coincidencias como leche entera y leche de coco.         |
| E08-08 | P1 |    M | Introducir identificadores normalizados | Inventario y recetas pueden vincular productos equivalentes.       |
| E08-09 | P1 |    M | Crear sistema de imágenes coherente     | Todas las tarjetas tienen proporción y placeholder uniforme.       |
| E08-10 | P1 |    M | Añadir subida de imagen propia          | Una receta personalizada puede guardar fotografía.                 |
| E08-11 | P1 |    M | Mejorar vista previa IA                 | Muestra fuente, macros estimados, coste y alérgenos.               |
| E08-12 | P1 |    M | Permitir regeneración parcial           | Puede regenerarse título, pasos o ingredientes por separado.       |
| E08-13 | P1 |    M | Añadir sustituciones                    | Sugiere alternativas compatibles con inventario y alergias.        |
| E08-14 | P1 |    M | Añadir escalado de raciones             | Ingredientes, macros y coste se recalculan proporcionalmente.      |
| E08-15 | P1 |    M | Unificar flujo Cocinar                  | Recetas, Feed, Plan y Asistente usan el mismo modal.               |
| E08-16 | P2 |    M | Añadir favoritos y colecciones          | Las recetas pueden organizarse en listas personales.               |
| E08-17 | P2 |    M | Guardar filtros frecuentes              | Puede recuperarse «baratas y altas en proteína».                   |
| E08-18 | P2 |    M | Crear modo batch cooking                | Agrupa preparaciones y reutiliza ingredientes.                     |
| E08-19 | P2 |    M | Añadir temporizador por paso            | El modo cocina puede controlar tiempos.                            |
| E08-20 | P3 |    M | Añadir valoración posterior             | Registra gusto, dificultad real y si se repetiría.                 |

---

# ÉPICA E09 — Planificador semanal

**Objetivo:** convertir la planificación en una herramienta práctica en móvil y escritorio.

| ID     |  P | Esf. | Ticket                                   | Criterios de aceptación                                 |
| ------ | -: | ---: | ------------------------------------------- | ------------------------------------------------------------ |
| E09-01 | P0 |    S | Corregir referencias al botón IA         | Todos los mensajes enlazan a la ubicación real.         |
| E09-02 | P1 |    L | Crear vista móvil diaria                 | No se obliga a utilizar una cuadrícula de 35 celdas.    |
| E09-03 | P1 |    M | Añadir selector Día / 3 días / Semana    | Cada dispositivo puede elegir densidad.                 |
| E09-04 | P1 |    M | Mejorar navegación entre semanas         | Existe acceso claro a anterior, siguiente y actual.     |
| E09-05 | P1 |    L | Crear vista previa del plan IA           | El plan no se aplica antes de revisarse.                |
| E09-06 | P1 |    M | Mostrar celdas que serán reemplazadas    | El usuario sabe qué contenido cambiará.                 |
| E09-07 | P1 |    M | Permitir bloquear días y comidas         | La regeneración respeta elementos bloqueados.           |
| E09-08 | P1 |    M | Calcular objetivo por tipo de día        | Cada fecha utiliza gimnasio o descanso correctamente.   |
| E09-09 | P1 |    M | Mostrar ingredientes faltantes semanales | El coste y la lista se ven antes de comprar.            |
| E09-10 | P1 |    M | Crear plantillas semanales               | Semana habitual, barata, proteína alta y batch cooking. |
| E09-11 | P1 |    M | Permitir duplicar día o semana           | Se reutiliza una planificación anterior.                |
| E09-12 | P1 |    M | Permitir mover comidas con teclado       | El drag and drop no es la única interacción.            |
| E09-13 | P1 |    S | Añadir acción «Limpiar semana» segura    | Incluye confirmación y deshacer.                        |
| E09-14 | P2 |    M | Añadir coste diario y semanal comparado  | Muestra desviación respecto al presupuesto.             |
| E09-15 | P2 |    M | Añadir macros restantes por día          | Identifica días incompletos o excesivos.                |
| E09-16 | P2 |    M | Marcar comidas cocinadas                 | El plan distingue previsto, registrado y omitido.       |
| E09-17 | P2 |    M | Recomendar preparación anticipada        | Detecta ingredientes o pasos compartidos.               |

---

# ÉPICA E10 — Lista de compra

**Objetivo:** crear un flujo completo desde planificación hasta compra e inventario.

| ID     |  P | Esf. | Ticket                                      | Criterios de aceptación                                               |
| ------ | -: | ---: | ------------------------------------------------ | --------------------------------------------------------------------------- |
| E10-01 | P0 |   XS | Impedir cantidad cero                       | El formulario y la lógica rechazan valores no positivos.              |
| E10-02 | P0 |    M | Sustituir confirmación en toast por diálogo | Superar presupuesto requiere una decisión persistente.                |
| E10-03 | P1 |    L | Crear flujo Revisar compra                  | Se revisan productos, cantidades, precios, tienda y total.            |
| E10-04 | P1 |    M | Integrar movimiento al inventario           | Los productos comprados entran al inventario durante la finalización. |
| E10-05 | P1 |    M | Proponer caducidades al finalizar           | Cada producto permite confirmar o editar la fecha.                    |
| E10-06 | P1 |    M | Registrar el gasto real                     | Finanzas recibe el total y la tienda confirmados.                     |
| E10-07 | P1 |    M | Distinguir estimado y real                  | La interfaz nunca presenta el precio estimado como definitivo.        |
| E10-08 | P1 |    M | Crear modo compra móvil                     | Checkboxes grandes, total fijo y uso offline.                         |
| E10-09 | P1 |    M | Ordenar por categoría o pasillo             | La compra puede organizarse según la tienda.                          |
| E10-10 | P1 |    M | Agrupar por tienda                          | Los artículos de tiendas distintas quedan separados.                  |
| E10-11 | P1 |    S | Añadir deshacer último marcado              | Un toque accidental puede revertirse.                                 |
| E10-12 | P1 |    M | Mejorar «Añadir todo»                       | Informa qué se fusionó y qué se añadió.                               |
| E10-13 | P1 |    M | Resolver unidades incompatibles             | No suma gramos y unidades sin conversión.                             |
| E10-14 | P2 |    M | Añadir compartir lista                      | Permite compartir mediante enlace o texto.                            |
| E10-15 | P2 |    L | Añadir colaboración de hogar                | Varios usuarios pueden actualizar la misma lista.                     |
| E10-16 | P2 |    M | Añadir productos habituales                 | Sugiere compras recurrentes según historial.                          |
| E10-17 | P2 |    M | Comparar presupuesto antes y después        | Muestra impacto estimado de la compra.                                |

---

# ÉPICA E11 — Nutrición

**Objetivo:** hacer comprensible y fiable un motor nutricional avanzado.

| ID     |  P | Esf. | Ticket                                             | Criterios de aceptación                                             |
| ------ | -: | ---: | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| E11-01 | P0 |    M | Implementar confirmación real del déficit agresivo | No basta con un toast; el usuario revisa y confirma explícitamente. |
| E11-02 | P0 |    M | Definir UX del modelo de actividad versionado      | El usuario entiende qué modelo utiliza su perfil.                   |
| E11-03 | P0 |    L | Diseñar migración al próximo modelo de actividad   | La actualización nunca reinterpreta perfiles silenciosamente.       |
| E11-04 | P1 |    M | Dividir Nutrición en pestañas                      | Objetivos, Hoy, Peso y Tendencias quedan separados.                 |
| E11-05 | P1 |    M | Añadir «Ver cálculo»                               | Explica TMB, TDEE, factor, objetivo y macros.                       |
| E11-06 | P1 |    M | Diferenciar valor y rango recomendado              | No se presenta un único número con falsa precisión.                 |
| E11-07 | P1 |    S | Explicar el parámetro fisiológico                  | El campo sexo indica su uso exclusivo en la fórmula.                |
| E11-08 | P1 |    M | Permitir objetivos manuales                        | El usuario puede introducir kcal y macros bajo advertencia.         |
| E11-09 | P1 |    M | Mostrar fecha y versión del cálculo                | La interfaz identifica el snapshot activo.                          |
| E11-10 | P1 |    M | Crear historial de cálculos                        | Se pueden consultar cambios de perfil y objetivos.                  |
| E11-11 | P1 |    M | Añadir restauración de configuración anterior      | Un snapshot previo puede reutilizarse con confirmación.             |
| E11-12 | P1 |    M | Mejorar lenguaje no moralizante                    | Se eliminan términos de fracaso, culpa o castigo.                   |
| E11-13 | P1 |    M | Adaptar tendencia al objetivo corporal             | Subir o bajar peso no se pinta bien o mal sin contexto.             |
| E11-14 | P1 |    M | Añadir explicación de fibra                        | Se muestra objetivo, consumo y principales fuentes.                 |
| E11-15 | P1 |    M | Añadir seguimiento de micronutrientes opcional     | Solo se muestra cuando existen datos fiables.                       |
| E11-16 | P2 |    M | Crear objetivo semanal                             | Permite interpretar variaciones diarias sin dramatizarlas.          |
| E11-17 | P2 |    L | Crear propuestas de ajuste revisables              | Usa la tabla ya creada de `nutrition_adjustment_proposals`.         |
| E11-18 | P2 |    M | Mostrar por qué se propone un ajuste               | Incluye tendencia, adherencia y periodo utilizado.                  |
| E11-19 | P2 |    M | Añadir caducidad de datos físicos                  | Solicita revisar peso o actividad tras un tiempo definido.          |
| E11-20 | P3 |   XL | Construir motor adaptativo                         | Solo después de validar snapshots y propuestas manuales.            |

---

# ÉPICA E12 — Entrenamientos y ejercicios

**Objetivo:** convertir Ejercicios en una experiencia coherente y útil a largo plazo.

| ID     |  P | Esf. | Ticket                                  | Criterios de aceptación                                      |
| ------ | -: | ---: | -------------------------------------------- | ------------------------------------------------------------------ |
| E12-01 | P0 |    S | Sustituir `confirm()` nativo            | La eliminación de rutina utiliza el diálogo de FoodOS.       |
| E12-02 | P0 |    S | Ampliar botones de series                | Todos los controles táctiles alcanzan al menos 40–44 px.     |
| E12-03 | P1 |    M | Convertir pestañas en tabs accesibles   | Incluye roles, selección, paneles y navegación por flechas.  |
| E12-04 | P1 |    M | Unificar estilos con el design system   | No existen botones, radios o tarjetas visualmente paralelos. |
| E12-05 | P1 |    M | Añadir edición de rutinas               | Nombre, días, ejercicios, series y notas son modificables.   |
| E12-06 | P1 |    M | Permitir sustituir ejercicio            | Se mantiene el grupo muscular y objetivo.                    |
| E12-07 | P1 |    M | Crear vista previa IA editable          | La rutina se revisa antes de guardarse.                      |
| E12-08 | P1 |    M | Permitir regenerar un único día         | No es necesario regenerar toda la rutina.                    |
| E12-09 | P1 |    L | Registrar peso y repeticiones por serie | La sesión guarda el rendimiento real.                        |
| E12-10 | P1 |    M | Añadir RIR o RPE                        | El usuario puede registrar esfuerzo opcionalmente.           |
| E12-11 | P1 |    M | Añadir temporizador de descanso         | Puede iniciarse desde cada serie.                            |
| E12-12 | P1 |    M | Mostrar sesión anterior                 | Cada ejercicio presenta carga y repeticiones previas.        |
| E12-13 | P1 |    M | Detectar récord personal                | Se celebran récords sin alterar datos nutricionales.         |
| E12-14 | P1 |    M | Mostrar kcal como estimación            | Incluye metodología y margen orientativo.                    |
| E12-15 | P2 |    L | Crear gráficos de progresión            | Evolución por ejercicio y volumen semanal.                   |
| E12-16 | P2 |    M | Añadir plantillas de rutina             | PPL, torso-pierna, full body y personalizada.                |
| E12-17 | P2 |    M | Duplicar o reprogramar sesión           | Permite mover una sesión a otra fecha.                       |
| E12-18 | P2 |    M | Añadir notas de lesión o limitación     | La IA y filtros respetan restricciones.                      |
| E12-19 | P3 |    L | Calcular volumen por grupo muscular     | Se muestra distribución semanal.                             |
| E12-20 | P3 |    M | Añadir integración con el plan semanal  | Los días de entrenamiento se ven en Hoy y Planificador.      |

---

# ÉPICA E13 — Finanzas y presupuesto

**Objetivo:** mejorar confianza, claridad y coherencia con la estrategia elegida.

| ID     |  P | Esf. | Ticket                                             | Criterios de aceptación                                    |
| ------ | -: | ---: | ------------------------------------------------------- | ---------------------------------------------------------------- |
| E13-01 | P0 |   XS | Eliminar consejo de fondo indexado                 | FoodOS no recomienda productos financieros concretos.      |
| E13-02 | P0 |    S | Corregir «mensual» frente a «30 días»              | Cada métrica indica exactamente el periodo utilizado.      |
| E13-03 | P0 |    S | Eliminar importes ficticios por defecto            | Los formularios monetarios empiezan vacíos.                |
| E13-04 | P0 |    M | Unificar cálculo de gastos fijos                   | Gráficos y resúmenes usan las mismas inclusiones.          |
| E13-05 | P1 |    M | Reestructurar según la decisión E00-02             | La sección refleja claramente su alcance final.             |
| E13-06 | P1 |    M | Reorganizar formularios colapsables                | No aparecen todos abiertos simultáneamente.                |
| E13-07 | P1 |    M | Añadir selector de periodo                         | Mes natural, últimos 30 días y periodo personalizado.      |
| E13-08 | P1 |    M | Explicar proyecciones                              | Muestra ahorro, interés, inflación y horizonte asumidos.   |
| E13-09 | P1 |    S | Etiquetar proyecciones como estimaciones           | No se presentan como resultados garantizados.              |
| E13-10 | P1 |    M | Hacer editable la regla 50/30/20                   | Se trata como referencia, no norma.                        |
| E13-11 | P1 |    M | Renombrar categorías moralizantes                  | «Deseos» puede convertirse en «Gasto flexible».            |
| E13-12 | P1 |    M | Añadir comparación con periodo anterior            | Incluye diferencia absoluta y porcentual.                  |
| E13-13 | P1 |    M | Mostrar gasto alimentario por tienda                | Permite comparar hábitos reales de compra.                 |
| E13-14 | P1 |    M | Mostrar coste medio por comida                      | Relaciona recetas, compras y presupuesto.                  |
| E13-15 | P2 |    M | Añadir presupuestos por categoría configurables    | Cada categoría puede tener límite propio.                  |
| E13-16 | P2 |    M | Añadir objetivos de ahorro con aportaciones reales | No se estima el progreso solo por ritmo mensual.           |
| E13-17 | P2 |    M | Añadir edición de movimientos                       | Importe, fecha, categoría y descripción pueden corregirse. |
| E13-18 | P2 |    S | Añadir deshacer al borrar movimiento                | La eliminación no es irreversible de inmediato.            |
| E13-19 | P3 |   XL | Integración bancaria                                | No comenzar hasta decidir alcance y privacidad.            |

---

# ÉPICA E14 — Progreso y estadísticas

**Objetivo:** presentar tendencias comprensibles y relacionadas con objetivos.

| ID     |  P | Esf. | Ticket                                  | Criterios de aceptación                                              |
| ------ | -: | ---: | -------------------------------------------- | -------------------------------------------------------------------------- |
| E14-01 | P0 |    M | Corregir semántica del peso             | El color depende de pérdida, volumen, mantenimiento o recomposición. |
| E14-02 | P0 |    M | Unificar datos financieros del gráfico  | Coinciden con el resumen del mismo periodo.                          |
| E14-03 | P1 |    S | Renombrar Estadísticas como Progreso    | El nombre refleja mejor el contenido.                                |
| E14-04 | P1 |    M | Añadir selector de periodo              | 7 días, 30 días, 3 meses, 6 meses y año.                             |
| E14-05 | P1 |    L | Añadir tooltips a gráficos              | Cada punto o barra muestra valor y fecha.                             |
| E14-06 | P1 |    M | Añadir líneas de objetivo               | Se compara claramente real y recomendado.                            |
| E14-07 | P1 |    M | Añadir media móvil de peso              | Reduce ruido de variaciones diarias.                                 |
| E14-08 | P1 |    M | Añadir comparación con periodo anterior | Todas las métricas importantes incluyen tendencia.                   |
| E14-09 | P1 |    M | Añadir tablas accesibles                | Cada gráfico tiene alternativa textual desplegable.                  |
| E14-10 | P1 |    M | Aumentar etiquetas pequeñas             | No hay textos de 9 px en gráficos.                                    |
| E14-11 | P1 |    M | Añadir adherencia semanal               | Kcal, proteína, fibra, agua y entrenamiento.                          |
| E14-12 | P1 |    M | Separar progreso por dominio            | Nutrición, peso, entrenamiento y presupuesto.                        |
| E14-13 | P2 |    M | Añadir hitos explicados                 | Se celebran tendencias sostenidas, no fluctuaciones aisladas.        |
| E14-14 | P2 |    M | Añadir exportación del periodo          | CSV o imagen con las métricas seleccionadas.                         |
| E14-15 | P2 |    M | Añadir anotaciones de contexto          | Viajes, enfermedad o cambios de objetivo pueden marcarse.            |
| E14-16 | P3 |    M | Crear resumen semanal automático        | Resume cambios y propone una siguiente acción prudente.              |

---

# ÉPICA E15 — Asistente IA

**Objetivo:** hacerlo seguro, transparente y capaz de ejecutar acciones estructuradas.

| ID     |  P | Esf. | Ticket                                 | Criterios de aceptación                                                         |
| ------ | -: | ---: | ------------------------------------------- | -------------------------------------------------------------------------------------- |
| E15-01 | P0 |   XS | Corregir texto de privacidad           | Aclara que la clave no pasa por servidores de FoodOS, pero sí por el proveedor. |
| E15-02 | P0 |    M | Revisar almacenamiento de claves       | Se documentan riesgos y mitigaciones.                                           |
| E15-03 | P0 |    M | Añadir política CSP estricta           | Se limita la ejecución y carga de recursos no autorizados.                      |
| E15-04 | P0 |    M | Validar acciones con esquemas          | Ningún JSON de IA muta estado sin validación.                                   |
| E15-05 | P1 |    L | Migrar de etiquetas a tool calling     | Inventario y recetas usan acciones estructuradas.                               |
| E15-06 | P1 |    M | Añadir confirmación previa             | Toda acción que modifica datos muestra una vista previa.                       |
| E15-07 | P1 |    M | Mostrar qué datos se envían            | El usuario conoce el contexto compartido con el proveedor.                     |
| E15-08 | P1 |    M | Añadir coste aproximado                | Se muestra advertencia cuando el proveedor puede cobrar.                        |
| E15-09 | P1 |    M | Añadir borrar historial desde el chat  | No requiere entrar en configuración profunda.                                  |
| E15-10 | P1 |    M | Añadir conversaciones separadas        | Se pueden crear, nombrar y eliminar conversaciones.                             |
| E15-11 | P1 |    M | Sincronizar historial opcionalmente    | Se distingue claramente local y nube.                                           |
| E15-12 | P1 |    M | Añadir acciones deshacer               | Una mutación reciente puede revertirse.                                        |
| E15-13 | P1 |    M | Detener rotación mientras se lee       | Los mensajes contextuales no cambian inesperadamente.                          |
| E15-14 | P1 |    M | Unificar flujo de receta IA            | Usa la misma vista previa que Recetas.                                          |
| E15-15 | P1 |    M | Añadir fuentes de datos en respuestas  | Distingue inventario, cálculo, base externa y estimación.                       |
| E15-16 | P2 |    M | Añadir comandos sugeridos contextuales | Cambian según inventario, hora y sección.                                       |
| E15-17 | P2 |    M | Añadir modelo de permisos de acciones  | El usuario puede prohibir borrar, crear gastos o modificar objetivos.           |
| E15-18 | P2 |    M | Registrar auditoría de acciones IA     | Guarda qué solicitó, qué propuso y qué se confirmó.                             |
| E15-19 | P3 |    L | Proxy seguro opcional                  | Permite no almacenar la clave en el navegador.                                  |

---

# ÉPICA E16 — Feed e Inspiración

**Objetivo:** evitar que una función simulada reduzca la confianza del producto.

| ID     |  P | Esf. | Ticket                                                | Criterios de aceptación                                                 |
| ------ | -: | ---: | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| E16-01 | P0 |   XS | Ocultar «Cargar posts demo» a usuarios normales       | Solo está disponible en modo desarrollo.                                |
| E16-02 | P0 |    S | Corregir persistencia de likes                        | No puede darse like varias veces tras recargar.                        |
| E16-03 | P0 |    S | Unificar Cocinar con Recetas                          | No se salta el modal de raciones e inventario.                          |
| E16-04 | P1 |    M | Aplicar decisión estratégica E00-03                   | El módulo se elimina, renombra o reconstruye.                           |
| E16-05 | P1 |    M | Eliminar términos «público» y «comunidad» si es local | La interfaz describe honestamente el contenido.                         |
| E16-06 | P1 |    M | Crear Inspiración editorial                           | Muestra colecciones y recetas recomendadas sin fingir actividad social. |
| E16-07 | P2 |    M | Añadir guardados y colecciones                        | Sustituye parte del valor superficial de likes.                         |
| E16-08 | P2 |    M | Añadir publicación privada                            | Permite crear una bitácora personal de recetas cocinadas.               |
| E16-09 | P3 |   XL | Diseñar backend social real                           | Incluye perfiles, follows, likes, comentarios y paginación.             |
| E16-10 | P3 |   XL | Diseñar moderación y privacidad                       | Reportes, bloqueo, eliminación y visibilidad.                           |
| E16-11 | P4 |   XL | Lanzar comunidad pública                              | Solo después de resolver seguridad, moderación y masa crítica.          |

---

# ÉPICA E17 — Ajustes, cuenta y privacidad

**Objetivo:** ordenar configuración, datos personales y operaciones destructivas.

| ID     |  P | Esf. | Ticket                                     | Criterios de aceptación                                    |
| ------ | -: | ---: | ----------------------------------------------- | ------------------------------------------------------------------ |
| E17-01 | P0 |    M | Separar borrar local, nube y cuenta        | Cada operación explica exactamente su alcance.             |
| E17-02 | P0 |    M | Validar importaciones mediante esquema     | Datos incompatibles no se aplican parcialmente.            |
| E17-03 | P0 |    M | Añadir versión al archivo exportado        | La importación sabe qué migraciones necesita.              |
| E17-04 | P0 |    M | Crear copia de seguridad antes de importar | Puede restaurarse el estado previo.                        |
| E17-05 | P1 |    L | Dividir Ajustes por categorías             | Cuenta, Perfil, Apariencia, Avisos, IA, Datos y Avanzado.  |
| E17-06 | P1 |    M | Añadir navegación interna                  | No existe una columna interminable de paneles.             |
| E17-07 | P1 |    M | Añadir búsqueda de ajustes                 | Busca por nombre y descripción.                            |
| E17-08 | P1 |    M | Mover perfil nutricional a Perfil          | Evita duplicación entre Ajustes y Nutrición.               |
| E17-09 | P1 |    M | Añadir opción ocultar mascota              | Se aplica globalmente.                                     |
| E17-10 | P1 |    M | Añadir densidad de interfaz                | Cómoda, normal y compacta.                                 |
| E17-11 | P1 |    M | Añadir tamaño de texto                     | Respeta preferencias de accesibilidad.                     |
| E17-12 | P1 |    S | Añadir formato horario                     | 12 o 24 horas.                                             |
| E17-13 | P1 |    S | Añadir primer día de semana                | Lunes o domingo.                                           |
| E17-14 | P1 |    S | Añadir unidades                            | Métrico como predeterminado y futura ampliación.           |
| E17-15 | P1 |    M | Crear botón de instalación PWA             | Utiliza el prompt de instalación cuando está disponible.   |
| E17-16 | P1 |    S | Mostrar versión y changelog                | El usuario puede conocer cambios recientes.                |
| E17-17 | P1 |    M | Crear página de privacidad                 | Explica almacenamiento, Supabase, IA y servicios externos. |
| E17-18 | P2 |    M | Mostrar dispositivos o sesiones activas    | Permite cerrar sesiones cuando Supabase lo soporte.        |
| E17-19 | P2 |    M | Añadir exportación completa visible        | JSON y CSV no quedan ocultos en herramientas admin.        |
| E17-20 | P2 |    M | Crear modo desarrollador explícito         | Herramientas demo y fecha simulada requieren activación.   |

---

# ÉPICA E18 — Accesibilidad

**Objetivo:** alcanzar WCAG 2.2 AA en flujos principales.

| ID     |  P | Esf. | Ticket                                    | Criterios de aceptación                                        |
| ------ | -: | ---: | ---------------------------------------------- | -------------------------------------------------------------------- |
| E18-01 | P0 |    M | Auditar contraste completo                | Todos los textos funcionales cumplen AA.                       |
| E18-02 | P0 |    M | Corregir token `hint`                     | Cumple contraste en oscuro y claro.                            |
| E18-03 | P0 |    M | Auditar elementos clicables no semánticos | No quedan `div`, `span` o `strong` como botones.               |
| E18-04 | P0 |    M | Añadir nombres accesibles a iconos        | Todos los icon buttons tienen `aria-label`.                    |
| E18-05 | P0 |    M | Asociar labels a todos los inputs         | No se depende solo de placeholders.                            |
| E18-06 | P1 |    M | Añadir focus visible consistente          | Teclado muestra siempre dónde está el foco.                    |
| E18-07 | P1 |    M | Convertir tabs al patrón ARIA             | Incluye flechas y asociación con paneles.                      |
| E18-08 | P1 |    L | Convertir autocompletados en combobox     | Cumplen el patrón ARIA correspondiente.                        |
| E18-09 | P1 |    M | Añadir `inert` al fondo                   | Menús, onboarding y diálogos bloquean contenido posterior.     |
| E18-10 | P1 |    M | Mejorar onboarding con foco               | Al cambiar de paso, el foco va al título.                      |
| E18-11 | P1 |    M | Mejorar tour para lectores de pantalla    | Comunica paso, título, descripción y controles.                |
| E18-12 | P1 |    M | Añadir alternativas para gráficos         | Cada gráfico dispone de tabla o resumen.                       |
| E18-13 | P1 |    M | Evitar depender solo del color            | Estados incluyen icono, texto o patrón.                        |
| E18-14 | P1 |    M | Auditar objetivos táctiles                | Acciones frecuentes alcanzan 44 × 44 px en móvil.              |
| E18-15 | P1 |    S | Respetar zoom y tamaño de fuente          | La interfaz funciona al 200 %.                                 |
| E18-16 | P2 |    M | Añadir pruebas Axe                        | Los flujos principales fallan CI si introducen errores graves. |
| E18-17 | P2 |    M | Probar con teclado completo               | Todos los flujos principales son realizables sin ratón.        |
| E18-18 | P2 |    M | Probar con lector de pantalla             | Se documentan resultados en NVDA o VoiceOver.                  |

---

# ÉPICA E19 — PWA, offline y sincronización

**Objetivo:** hacer visible y fiable la arquitectura local-first.

| ID     |  P | Esf. | Ticket                                       | Criterios de aceptación                                            |
| ------ | -: | ---: | ------------------------------------------------- | -------------------------------------------------------------------------- |
| E19-01 | P0 |    M | Mostrar estado de sincronización             | Guardado local, pendiente, sincronizado y error son distinguibles. |
| E19-02 | P0 |    L | Definir estrategia de conflictos             | Cambios simultáneos no se sobrescriben silenciosamente.            |
| E19-03 | P0 |    L | Probar sincronización entre dos dispositivos | Existe batería de pruebas reproducible.                            |
| E19-04 | P1 |    M | Añadir cola de cambios offline               | Las mutaciones se reintentan al recuperar conexión.                |
| E19-05 | P1 |    M | Mostrar cambios pendientes                   | El usuario conoce cuántas operaciones faltan por sincronizar.      |
| E19-06 | P1 |    M | Añadir reintento manual                      | Un error no requiere recargar toda la aplicación.                  |
| E19-07 | P1 |    M | Revisar estrategia del service worker        | Se documenta qué se cachea y cómo se invalida.                     |
| E19-08 | P1 |    M | Añadir aviso de nueva versión                | Permite actualizar sin estado inconsistente.                       |
| E19-09 | P1 |    M | Proteger contra versión antigua del estado   | Se ejecutan migraciones antes de sincronizar.                      |
| E19-10 | P1 |    M | Crear experiencia offline por módulo         | Se conoce qué funciones trabajan sin red y cuáles no.              |
| E19-11 | P1 |    M | Bloquear IA offline con explicación          | No parece un fallo inesperado.                                     |
| E19-12 | P1 |    M | Mantener lista de compra plenamente offline  | Marcado y precios se sincronizan después.                          |
| E19-13 | P2 |    M | Añadir instalación desde la aplicación       | Funciona en navegadores compatibles.                               |
| E19-14 | P2 |    M | Añadir iconos y splash PWA completos         | Se revisan tamaños, tema y modo standalone.                        |
| E19-15 | P2 |    M | Medir tasa de errores de sincronización      | Existe telemetría sin recoger datos sensibles innecesarios.        |

---

# ÉPICA E20 — Rendimiento, seguridad y observabilidad

**Objetivo:** asegurar que la aplicación siga siendo estable al crecer.

| ID     |  P | Esf. | Ticket                                    | Criterios de aceptación                                        |
| ------ | -: | ---: | ------------------------------------------------ | -------------------------------------------------------------------- |
| E20-01 | P0 |    S | Ejecutar auditoría actual de dependencias | Cada hallazgo se clasifica por explotabilidad real.            |
| E20-02 | P0 |    M | Actualizar dependencias vulnerables       | No quedan vulnerabilidades altas aplicables al runtime.        |
| E20-03 | P0 |    M | Añadir CSP                                | Limita scripts, conexiones, imágenes y contenido embebido.     |
| E20-04 | P0 |    M | Auditar exposición de claves IA           | Ningún log o error imprime la clave.                           |
| E20-05 | P0 |    M | Auditar RLS de todas las tablas           | Un usuario no puede leer o modificar datos ajenos.             |
| E20-06 | P0 |    M | Probar eliminación completa de cuenta     | No quedan datos o Storage huérfanos.                           |
| E20-07 | P1 |    M | Integrar monitorización de errores        | Los errores de vistas y red llegan a un servicio central.      |
| E20-08 | P1 |    S | Añadir identificador de error             | El usuario puede comunicar un código sin copiar un stack.      |
| E20-09 | P1 |    M | Medir Web Vitals                          | LCP, CLS e INP se observan por ruta.                           |
| E20-10 | P1 |    M | Auditar renders innecesarios              | Cambiar un filtro local no clona ni sincroniza todo el estado. |
| E20-11 | P1 |    L | Separar contextos o utilizar selectores   | Una mutación pequeña no rerenderiza todo el dashboard.         |
| E20-12 | P1 |    M | Virtualizar listas largas                 | Diario, inventario y movimientos mantienen rendimiento.        |
| E20-13 | P1 |    M | Revisar imágenes remotas                  | Carga, tamaños, dominios y placeholders están controlados.     |
| E20-14 | P1 |    M | Añadir límites de tamaño de archivos      | Tickets e imágenes demasiado grandes se comprimen o rechazan. |
| E20-15 | P1 |    M | Añadir rate limiting visible de IA        | El usuario recibe un estado comprensible.                      |
| E20-16 | P1 |    M | Registrar fallos de snapshots             | No bloquean al usuario pero quedan observables.                |
| E20-17 | P2 |    M | Crear presupuesto de bundle               | CI avisa si una ruta supera el límite acordado.                |
| E20-18 | P2 |    M | Añadir análisis de CSS no utilizado       | Reduce crecimiento del bundle y deuda visual.                  |
| E20-19 | P2 |    M | Añadir logs estructurados                 | Se evita depender de mensajes libres en consola.               |
| E20-20 | P2 |    L | Crear panel interno de salud del sistema  | Errores, sincronización, IA y latencia se consultan juntos.    |

---

# ÉPICA E21 — Pruebas, CI y calidad

**Objetivo:** proteger los flujos conectados que hacen diferencial a FoodOS.

| ID     |  P | Esf. | Ticket                                  | Criterios de aceptación                                   |
| ------ | -: | ---: | -------------------------------------------- | ----------------------------------------------------------------- |
| E21-01 | P0 |    L | Configurar Playwright                   | Los flujos críticos se ejecutan en CI.                    |
| E21-02 | P0 |    M | Probar alimento → receta → inventario   | Cocinar descuenta la cantidad correcta.                   |
| E21-03 | P0 |    M | Probar comida → borrar → deshacer       | Inventario y diario se restauran juntos.                  |
| E21-04 | P0 |    M | Probar plan → lista de compra           | Solo se añaden ingredientes realmente faltantes.          |
| E21-05 | P0 |    M | Probar compra → inventario → finanzas   | La operación mantiene consistencia entre módulos.         |
| E21-06 | P0 |    M | Probar cambio de perfil nutricional     | Objetivos, snapshot y avisos se actualizan correctamente. |
| E21-07 | P0 |    M | Probar bloqueo de menos de 800 kcal     | No existe ruta alternativa que omita el guardarraíl.      |
| E21-08 | P0 |    M | Probar confirmación de déficit agresivo | El perfil no se acepta sin interacción requerida.         |
| E21-09 | P1 |    M | Probar navegación por rutas             | Recarga, Atrás y enlaces profundos funcionan.             |
| E21-10 | P1 |    M | Probar tema claro y oscuro              | No existen colores fijos incompatibles.                   |
| E21-11 | P1 |    M | Añadir regresión visual                 | Se capturan Dashboard, Inventario, Recetas y móvil.       |
| E21-12 | P1 |    M | Probar viewports móviles                | 320, 375, 390, 430 y tablet.                              |
| E21-13 | P1 |    M | Probar offline y reconexión             | Los cambios pendientes se sincronizan una vez.            |
| E21-14 | P1 |    M | Probar dos sesiones simultáneas         | Agua, peso y listas no pierden cambios.                   |
| E21-15 | P1 |    M | Probar importaciones antiguas           | Los estados previos migran sin corrupción.                |
| E21-16 | P1 |    M | Probar rutinas IA largas                | El resultado completo se valida y guarda.                 |
| E21-17 | P1 |    M | Probar errores de cámara                | Cada error muestra la respuesta correcta.                 |
| E21-18 | P1 |    M | Añadir comprobación Axe                 | Los errores graves bloquean el merge.                     |
| E21-19 | P1 |    S | Añadir comprobación de bundle           | El crecimiento excesivo bloquea o avisa.                  |
| E21-20 | P2 |    M | Crear datos de prueba estables          | Las pruebas no dependen de contenido demo mutable.        |
| E21-21 | P2 |    M | Crear checklist manual de release       | Incluye auth, sync, móvil, PWA, IA y borrado.             |

---

# ÉPICA E22 — Onboarding, activación y retención

**Objetivo:** conseguir que un nuevo usuario obtenga valor antes de explorar toda la aplicación.

| ID     |  P | Esf. | Ticket                                        | Criterios de aceptación                                  |
| ------ | -: | ---: | -------------------------------------------------- | ---------------------------------------------------------------- |
| E22-01 | P0 |    S | Vaciar datos físicos precargados              | Edad, altura y peso no pueden guardarse accidentalmente. |
| E22-02 | P1 |    M | Reordenar onboarding por valor                | Objetivo y primera acción aparecen antes que la mascota. |
| E22-03 | P1 |    M | Hacer mascota opcional                        | Puede omitirse sin perder acceso a la aplicación.        |
| E22-04 | P1 |    M | Crear primera experiencia guiada              | El usuario añade alimentos y recibe una recomendación.   |
| E22-05 | P1 |    M | Añadir checklist inicial                      | Muestra progreso en cinco tareas relevantes.             |
| E22-06 | P1 |    M | Sustituir tour largo por ayuda contextual     | La ayuda aparece cuando se utiliza cada módulo.          |
| E22-07 | P1 |    M | Permitir abandonar y continuar onboarding     | El progreso se conserva.                                 |
| E22-08 | P1 |    M | Mostrar beneficio antes de pedir permisos     | Notificaciones y cámara se solicitan contextualmente.    |
| E22-09 | P1 |    M | Crear onboarding diferente según objetivo     | Salud, ahorro y organización priorizan pasos distintos.  |
| E22-10 | P2 |    M | Añadir correos o notificaciones de activación | Solo con consentimiento y valor claro.                   |
| E22-11 | P2 |    M | Crear resumen de primera semana               | Celebra uso y explica qué mejorar.                       |
| E22-12 | P2 |    M | Medir abandono por paso                       | Se conoce dónde se pierde activación.                    |

---

# ÉPICA E23 — Contenido, lenguaje y confianza

**Objetivo:** hacer que FoodOS comunique con precisión y sin ansiedad.

| ID     |  P | Esf. | Ticket                                    | Criterios de aceptación                                     |
| ------ | -: | ---: | ------------------------------------------------ | ------------------------------------------------------------------ |
| E23-01 | P0 |    M | Auditar afirmaciones de salud             | No se presentan estimaciones como diagnósticos o certezas.  |
| E23-02 | P0 |    M | Auditar afirmaciones financieras          | No se dan recomendaciones de inversión específicas.         |
| E23-03 | P0 |    M | Diferenciar datos verificados y estimados | Se aplica a macros, kcal, precios y gasto deportivo.        |
| E23-04 | P1 |    M | Crear guía de tono                        | Claro, humano, no moralizante y sin alarmismo.              |
| E23-05 | P1 |    M | Unificar nombres de secciones             | Diario, Lista, Progreso e Inspiración mantienen coherencia. |
| E23-06 | P1 |    S | Unificar unidades y espacios              | Se utiliza «48 g», «250 ml» y «1,50 €».                     |
| E23-07 | P1 |    S | Unificar singular y plural                | Día/días, producto/productos y gramo/gramos.                |
| E23-08 | P1 |    M | Revisar estados vacíos                    | Cada vacío explica valor y siguiente acción.                |
| E23-09 | P1 |    M | Revisar mensajes de error                 | Incluyen causa probable y recuperación.                     |
| E23-10 | P1 |    M | Revisar textos de botones                 | Cada acción describe el resultado, no la implementación.    |
| E23-11 | P1 |    M | Añadir ayuda sobre fórmulas               | Mifflin, ESPEN y fibra tienen explicaciones breves.         |
| E23-12 | P2 |    M | Preparar internacionalización             | Textos salen de componentes y se centralizan.               |
| E23-13 | P3 |    L | Añadir inglés                             | Solo después de centralizar textos y formatos.              |

---

# ÉPICA E24 — Analítica de producto y experimentación

**Objetivo:** priorizar con datos sin recopilar información sensible innecesaria.

| ID     |  P | Esf. | Ticket                                   | Criterios de aceptación                                            |
| ------ | -: | ---: | ------------------------------------------------ | -------------------------------------------------------------------------- |
| E24-01 | P1 |    M | Definir eventos de producto              | Se documentan eventos mínimos y propósito de cada uno.             |
| E24-02 | P1 |    M | Implementar analítica con consentimiento | No se activa sin base legal y configuración adecuada.              |
| E24-03 | P1 |    S | Medir activación                         | Perfil, primeros alimentos, primera comida y primer plan.          |
| E24-04 | P1 |    S | Medir fricción del registro              | Tiempo y pasos hasta registrar una comida.                         |
| E24-05 | P1 |    S | Medir uso por módulo                     | Se conoce qué secciones aportan valor y cuáles no.                 |
| E24-06 | P1 |    S | Medir errores de flujo                   | Cámara, IA, sincronización, compras y guardado.                    |
| E24-07 | P2 |    M | Crear dashboard interno                  | Activación, retención y uso semanal se visualizan.                 |
| E24-08 | P2 |    M | Preparar feature flags                   | Los rediseños pueden probarse de forma gradual.                    |
| E24-09 | P2 |    M | Definir pruebas de usabilidad            | Se realizan tareas concretas con usuarios reales.                  |
| E24-10 | P2 |    S | Medir impacto del nuevo registro rápido  | Se compara tiempo y tasa de finalización.                          |
| E24-11 | P2 |    S | Medir impacto de navegación agrupada     | Se observa descubrimiento y cambios de sección.                    |
| E24-12 | P3 |    M | Añadir experimentos controlados          | Solo para decisiones importantes, no para cambiar botones al azar. |

---

# ÉPICA E25 — Funciones futuras condicionadas

Estas funciones no deben comenzar hasta completar la base correspondiente.

| ID     |  P | Esf. | Función                                   | Condición previa                                      |
| ------ | -: | ---: | ------------------------------------------------ | -------------------------------------------------------------- |
| E25-01 | P3 |   XL | Hogares compartidos                       | Modelo de permisos, conflictos y listas robusto.      |
| E25-02 | P3 |   XL | Lista colaborativa en tiempo real         | Sincronización y offline probados.                    |
| E25-03 | P3 |   XL | Integración Apple Health / Health Connect | Privacidad, consentimiento y normalización definidos. |
| E25-04 | P3 |   XL | Aplicación móvil Expo                     | Dashboard responsive y rutas estabilizadas.           |
| E25-05 | P4 |   XL | Aplicación escritorio Tauri               | PWA y experiencia web maduras.                        |
| E25-06 | P3 |   XL | Integración bancaria                      | Alcance financiero decidido y seguridad auditada.     |
| E25-07 | P4 |   XL | Comunidad pública                         | Backend social y moderación terminados.               |
| E25-08 | P3 |   XL | Motor nutricional adaptativo              | Snapshots, propuestas y suficientes datos históricos. |
| E25-09 | P3 |    L | Reconocimiento avanzado de tickets        | Flujo de revisión masiva estable.                     |
| E25-10 | P3 |    L | Sustituciones IA avanzadas                | Matching normalizado y fuentes nutricionales fiables. |
| E25-11 | P3 |    L | Coach semanal automático                  | Métricas, tono y seguridad nutricional validados.     |

---

# 3. Orden recomendado de ejecución

## Fase 0 — Decisiones y riesgos

1. E00: estrategia de producto.
2. E13-01 a E13-04: confianza financiera.
3. E15-01 a E15-04: privacidad y acciones IA.
4. E17-01 a E17-04: datos e importaciones.
5. E20-01 a E20-06: dependencias, CSP, RLS y borrado.
6. E11-01 a E11-03: seguridad nutricional y modelo de actividad.

## Fase 1 — Cimientos profesionales

1. E01: rutas.
2. E02: sesión y carga.
3. E03: tokens y componentes.
4. E04: navegación.
5. E18: accesibilidad base.
6. E21: Playwright y flujos críticos.

## Fase 2 — Experiencia diaria

1. E05: Dashboard Hoy.
2. E06: registro rápido.
3. E07: inventario simplificado.
4. E08: recetas.
5. E10: finalización de compra.

## Fase 3 — Planificación y progreso

1. E09: Planificador.
2. E11: Nutrición.
3. E12: Entrenamientos.
4. E14: Progreso.
5. E13: presupuesto.

## Fase 4 — IA, activación y retención

1. E15: asistente estructurado.
2. E22: onboarding.
3. E23: contenido y tono.
4. E24: analítica.
5. E16: Inspiración o Feed.

## Fase 5 — Expansión

Solo después de medir estabilidad y uso:

* Hogares.
* Integraciones.
* Comunidad.
* Aplicaciones nativas.
* Motor adaptativo.

---

# 4. Primera entrega recomendada

## Milestone «Base profesional»

### Debe incluir

* Rutas reales.
* Skeleton de sesión.
* Tema claro corregido.
* Formato monetario global.
* Valores ficticios eliminados.
* Navegación agrupada.
* Barra móvil inferior.
* Botón universal Añadir.
* Feed demo oculto.
* Texto de privacidad IA corregido.
* Consejo de inversión eliminado.
* Confirmación real de déficit agresivo.
* Validación de importaciones.
* Accesibilidad de botones y campos.
* Playwright para cinco flujos críticos.
* Estado de sincronización visible.

### Criterio de salida

El milestone no termina hasta que:

* `tsc --noEmit` pasa.
* Todos los tests unitarios pasan.
* Los flujos E2E principales pasan.
* No existen errores graves de Axe.
* Tema oscuro y claro han sido verificados.
* Se comprueba móvil en 375 × 812.
* El despliegue de preview no presenta errores de consola.
* No existen regresiones de sincronización o nutrición.

---

# 5. Definition of Done global

Un ticket solo puede pasar a Hecho cuando:

1. Cumple todos sus criterios de aceptación.
2. Tiene estados de carga, vacío, error y éxito cuando correspondan.
3. Funciona en tema oscuro y claro.
4. Funciona con teclado.
5. Funciona en móvil y escritorio.
6. No introduce textos sin localizar o formatos inconsistentes.
7. Incluye pruebas proporcionales al riesgo.
8. No altera datos existentes sin migración.
9. No introduce errores de TypeScript.
10. No introduce errores de consola.
11. No empeora la sincronización offline.
12. No presenta estimaciones como datos verificados.
13. Incluye analítica solo cuando sea necesaria y consentida.
14. Ha sido comprobado en preview antes del merge.
15. Incluye documentación cuando cambia comportamiento o arquitectura.

---

# 6. Resumen cuantitativo

| Prioridad | Tipo de trabajo                                                                 |
| --------- | --------------------------------------------------------------------------------- |
| **P0**    | Confianza, datos, seguridad, rutas, autenticación y correcciones estructurales. |
| **P1**    | Rediseño profesional, navegación, experiencia diaria y accesibilidad.           |
| **P2**    | Personalización, automatización, productividad y análisis avanzado.             |
| **P3–P4** | Integraciones, comunidad, móvil nativo y expansión futura.                      |

El backlog contiene trabajo sobre:

* Estrategia.
* Arquitectura.
* Autenticación.
* Diseño.
* Navegación.
* Dashboard.
* Diario.
* Inventario.
* Recetas.
* Planificador.
* Compra.
* Nutrición.
* Entrenamientos.
* Finanzas.
* Estadísticas.
* IA.
* Feed.
* Ajustes.
* Accesibilidad.
* PWA.
* Sincronización.
* Seguridad.
* Rendimiento.
* Pruebas.
* Onboarding.
* Contenido.
* Analítica.
* Expansión futura.

La prioridad no debe ser construirlo todo a la vez. La prioridad es impedir que el backlog se transforme en una criatura de 300 cabezas que devore cada sprint y después pida postre.

Primero hay que estabilizar confianza, rutas y sistema visual. Después reducir la fricción diaria. Finalmente ampliar el producto solo donde el uso real demuestre valor.
