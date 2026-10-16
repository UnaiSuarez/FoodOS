# Propuesta visual del Planificador (sin tocar la aplicación)

Rama `design/planificador-propuesta` desde `origin/main` = `01a9e65` (tras #152). Prototipo aislado: `index.html` (un solo fichero, sin dependencias). **Datos ficticios** marcados «(demo)»; «hoy» simulado = viernes 16 oct 2026. No se ha modificado `PlannerView`, estilos compartidos, sincronización, cálculos, esquema ni C0/V4.

Abrir `index.html`; los botones de la barra oscura superior (no forman parte de la app) alternan tema y semana poblada/vacía. Parámetros para capturas: `?theme=dark&data=empty&week=1&day=2&open=picker|cook|place`.

## Distribución
- **Escritorio (≥ 900 px)**: semana completa, 7 columnas × 5 franjas (Desayuno, Almuerzo, Comida, Merienda, Cena; con su MealType actual: Almuerzo y Merienda = Snack, y se dice en pantalla). Cada tarjeta muestra el nombre **completo en varias líneas** (sin puntos suspensivos, sin tooltip como único acceso), tipo (Receta / Plato rápido), kcal y proteína, y **tres botones siempre visibles** de ≥ 44 px: «Cocinar y registrar» (receta) o «Registrar» (plato rápido), «Cambiar», «Quitar». Hueco vacío: borde discontinuo y un único «+ Añadir» (un hueco vacío no es una comida obligatoria). Fila «Total» por día. La biblioteca de recetas queda debajo (búsqueda + «Colocar…»).
- **Móvil/tablet (< 900 px)**: tira de 7 días (cada botón ≥ 44 × 56 px, también a 360 px) + lista de las cinco franjas del día elegido en tarjetas de ancho completo. Nunca se comprimen siete columnas. El resto de la semana se alcanza con la tira.
- **Tres barras separadas**: semana (Anterior · rango · Siguiente · Hoy), día (tira, solo móvil) y acciones de la semana (✨ Plan IA, 🛒 Comprar semana; Compra usa las fechas de la semana mostrada, no el plan sugerido del carrito).
- La distribución no visible usa `display:none`: en cada ancho solo existe una copia de los controles en el árbol de accesibilidad (medido: 87 controles en escritorio, 32 en móvil, 0 botones de la semana en móvil).

## Honestidad de #152 (conservada)
Leyenda visible: «Cocinar y registrar» (receta) abre el diálogo donde se elige descontar o no; «Registrar» (plato rápido) anota directamente; planificar no registra. El diálogo de cocinar muestra raciones, kcal, fecha y tipo del hueco, y la casilla de descuento. Sin vínculo plan→diario ni marcado automático de «consumido».

## Navegación y selección
- Semana anterior/siguiente conserva la **posición** del día elegido (martes sigue siendo martes); «Hoy» vuelve a la semana y al día actuales. La selección vive en el estado de la vista, no se persiste. Las fechas se calculan con `new Date(y, m, d+n)` local y claves `YYYY-MM-DD` locales (sin UTC; seguro con el cambio horario y de mes/año).
- Día elegido: botón con `aria-pressed="true"` y relleno sólido; hoy: `aria-current="date"`, etiqueta «HOY» y color distinto. Ninguno de los dos estados depende solo del color.
- Se retira el modo «seleccionar receta y tocar celda» y el arrastre como **única** vía: la alternativa completa es «Añadir/Cambiar» (selector con búsqueda y plato rápido) y «Colocar…» (elige día y franja con `<select>`). El arrastre con ratón desde la biblioteca puede conservarse como atajo opcional en la implementación.
- «Cambiar» sustituye **solo** la entrada de esa franja; «Quitar» solo esa entrada; los botones son hermanos, nunca anidados, y no disparan selección de la celda.

## Foco y teclado (verificado con Playwright/Edge en escritorio)
1. «Añadir» abre un diálogo (`role="dialog"`, `aria-modal`, fondo `inert`) y el foco pasa al buscador; Tab queda atrapado dentro (12 Tab seguidos no salen).
2. Esc o «Cerrar» cierra y **devuelve el foco al botón que abrió**.
3. Tras elegir, el foco va al botón «Cambiar» de ese mismo hueco (el «Añadir» ya no existe); tras «Quitar», al «Añadir» del mismo hueco. Tras pulsar un día, el foco se queda en ese día y una región `aria-live` anuncia «viernes 16 de octubre: N de 5 franjas…»; el cambio de semana actualiza el rango (`aria-live`).
4. Los diálogos tienen cabecera y pie fijos y solo el cuerpo hace scroll: «Cancelar/Confirmar» siempre alcanzables.
5. Foco visible: contorno de 3 px (`--focus`) con 6,7:1 en claro y 8,8:1 en oscuro.

## Contraste (medido sobre colores compuestos, no solo axe)
Claro: nombre 18,2:1; meta kcal 8,4:1; nota de franja 7,8:1; primario 6,5:1; «Quitar» 7,3:1; etiquetas 7,5–7,9:1; hoy 8,0:1; **borde de hueco vacío 4,4:1** y de botones 4,7:1 (≥ 3:1). Oscuro: todos los textos ≥ 7,8:1; bordes 5,8:1 y 4,9:1. Los tokens propios (`--pl-*`) se definen por tema; los tokens de la app no se modifican. axe (WCAG 2 A/AA): 0 violaciones en escritorio, 390 y 360 px, en ambos temas.

## Qué se ha comprobado y qué no
- Hecho: inspección visual de capturas, teclado real con Playwright (Edge), cálculo de contraste, tamaños de objetivo (sin controles < 44 px), ausencia de scroll horizontal global (escritorio, 768, 390, 360), nombres sin recortar.
- Táctil: solo emulado (`hasTouch`), sin dispositivo físico. Zoom del navegador y lector de pantalla: no probados.
- Prototipo: lógica simulada (no usa el estado real, el CookModal real ni el carrito).

## Capturas (`capturas/`)
`escritorio|movil|movil360|tablet` × `light|dark` × `full|empty`, más diálogos (`-picker`, `-cook`, `-place`). La semana poblada incluye un nombre muy largo (viernes, Comida) y platos rápidos.

## Decisiones para revisar
1. ¿Retirar el modo «seleccionar y tocar celda» a favor de Añadir/Cambiar/Colocar? (Reduce estados ocultos; el arrastre queda opcional.)
2. ¿Mantener «Total» por día con kcal/objetivo y proteína (sin nuevas reglas) o simplificarlo en móvil?
3. ¿Tarjetas de escritorio con tres botones siempre visibles (más altas, ~190 px) o reducir a un menú «⋯» (menos visible, peor para táctil)? Propongo lo primero.
