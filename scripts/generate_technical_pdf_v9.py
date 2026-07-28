from __future__ import annotations

import shutil
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    KeepTogether,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
OUTPUT = ROOT / "output" / "pdf"
PDF_NAME = "FoodOS_Documentacion_Tecnica_v9.pdf"


PALETTE = {
    "ink": colors.HexColor("#172014"),
    "muted": colors.HexColor("#5d6d59"),
    "green": colors.HexColor("#2f8f46"),
    "green_soft": colors.HexColor("#e9f7ec"),
    "amber": colors.HexColor("#b7791f"),
    "blue": colors.HexColor("#2563eb"),
    "red": colors.HexColor("#b91c1c"),
    "line": colors.HexColor("#d7dfd4"),
    "bg": colors.HexColor("#f7faf5"),
    "dark": colors.HexColor("#071006"),
}


styles = getSampleStyleSheet()
styles.add(
    ParagraphStyle(
        name="CoverTitle",
        parent=styles["Title"],
        fontName="Helvetica-Bold",
        fontSize=34,
        leading=40,
        textColor=PALETTE["dark"],
        alignment=TA_CENTER,
        spaceAfter=12,
    )
)
styles.add(
    ParagraphStyle(
        name="CoverSub",
        parent=styles["Normal"],
        fontName="Helvetica",
        fontSize=13,
        leading=18,
        textColor=PALETTE["muted"],
        alignment=TA_CENTER,
        spaceAfter=6,
    )
)
styles.add(
    ParagraphStyle(
        name="H1Custom",
        parent=styles["Heading1"],
        fontName="Helvetica-Bold",
        fontSize=18,
        leading=24,
        textColor=PALETTE["green"],
        spaceBefore=8,
        spaceAfter=8,
        keepWithNext=True,
    )
)
styles.add(
    ParagraphStyle(
        name="H2Custom",
        parent=styles["Heading2"],
        fontName="Helvetica-Bold",
        fontSize=13.5,
        leading=18,
        textColor=PALETTE["ink"],
        spaceBefore=8,
        spaceAfter=5,
        keepWithNext=True,
    )
)
styles.add(
    ParagraphStyle(
        name="BodyCustom",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=9.4,
        leading=13.2,
        textColor=PALETTE["ink"],
        spaceAfter=5,
    )
)
styles.add(
    ParagraphStyle(
        name="SmallCustom",
        parent=styles["BodyText"],
        fontName="Helvetica",
        fontSize=8,
        leading=10.5,
        textColor=PALETTE["muted"],
        spaceAfter=4,
    )
)
styles.add(
    ParagraphStyle(
        name="CodeCustom",
        parent=styles["Code"],
        fontName="Courier",
        fontSize=7.2,
        leading=9,
        textColor=colors.HexColor("#1f2937"),
        backColor=colors.HexColor("#f1f5ef"),
        borderColor=PALETTE["line"],
        borderWidth=0.5,
        borderPadding=5,
        spaceBefore=4,
        spaceAfter=7,
    )
)


def esc(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\u2011", "-")
        .replace("\u2013", "-")
        .replace("\u2014", "-")
    )


def p(text: str):
    return Paragraph(esc(text), styles["BodyCustom"])


def small(text: str):
    return Paragraph(esc(text), styles["SmallCustom"])


def h1(text: str):
    return Paragraph(esc(text), styles["H1Custom"])


def h2(text: str):
    return Paragraph(esc(text), styles["H2Custom"])


def code(text: str):
    return Preformatted(text.replace("\u2011", "-").replace("\u2013", "-").replace("\u2014", "-"), styles["CodeCustom"])


def bullets(items: list[str]):
    data = [[Paragraph(esc(f"- {item}"), styles["BodyCustom"])] for item in items]
    t = Table(data, colWidths=[160 * mm], hAlign="LEFT")
    t.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
                ("TOPPADDING", (0, 0), (-1, -1), 1),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
            ]
        )
    )
    return t


def table(rows: list[list[str]], col_widths: list[float] | None = None):
    if col_widths is None:
        col_widths = [42 * mm, 120 * mm]
    data = [[Paragraph(esc(cell), styles["SmallCustom"]) for cell in row] for row in rows]
    t = Table(data, colWidths=col_widths, hAlign="LEFT", repeatRows=1)
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), PALETTE["green_soft"]),
                ("TEXTCOLOR", (0, 0), (-1, 0), PALETTE["ink"]),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("GRID", (0, 0), (-1, -1), 0.35, PALETTE["line"]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    return t


def section(title: str, *items):
    return [h1(title), *items, PageBreak()]


def keep(*items):
    return KeepTogether(list(items))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(PALETTE["line"])
    canvas.line(18 * mm, 282 * mm, 192 * mm, 282 * mm)
    canvas.setFont("Helvetica", 7.5)
    canvas.setFillColor(PALETTE["muted"])
    canvas.drawString(18 * mm, 287 * mm, "FoodOS - Documentacion Tecnica v9")
    canvas.drawRightString(192 * mm, 287 * mm, "29/06/2026")
    canvas.drawRightString(192 * mm, 10 * mm, f"Pagina {doc.page}")
    canvas.restoreState()


def build_story():
    story = []

    story.extend(
        [
            Spacer(1, 34 * mm),
            Paragraph("FoodOS", styles["CoverTitle"]),
            Paragraph("Documentacion Tecnica Completa v9", styles["CoverSub"]),
            Paragraph("Inventario alimentario, nutricion, finanzas, planificador, ejercicios e IA", styles["CoverSub"]),
            Spacer(1, 12 * mm),
            table(
                [
                    ["Campo", "Valor"],
                    ["Version", "v9 - 29/06/2026"],
                    ["Base revisada", "Repositorio FoodOScodex completo: apps/web, packages/types, supabase, docs y assets publicos"],
                    ["Estado", "Next.js web activa; mobile y desktop reservadas; Supabase preparado; PWA basica activa"],
                    ["Exclusion de seguridad", "Sin valores de API keys, service role keys, passwords, tokens, correos personales ni secretos"],
                    ["PDF anterior", "FoodOS_Documentacion_Tecnica_v8.pdf - 98 paginas, usado como contexto historico"],
                ],
                [38 * mm, 120 * mm],
            ),
            Spacer(1, 20 * mm),
            small(
                "Documento generado programaticamente con ReportLab desde scripts/generate_technical_pdf_v9.py. "
                "La informacion sensible se describe solo por responsabilidad o nombre de variable, nunca por valor."
            ),
            PageBreak(),
        ]
    )

    story.extend(
        section(
            "1. Resumen Ejecutivo",
            p(
                "FoodOS es una aplicacion web Next.js que conecta inventario de alimentos, diario nutricional, recetas, "
                "planificacion semanal, carrito de compra, finanzas personales, estadisticas, ejercicios e IA personal. "
                "La propuesta central sigue siendo cruzar tres preguntas que normalmente viven separadas: que tengo, que "
                "deberia comer y cuanto puedo gastar."
            ),
            bullets(
                [
                    "La web activa vive en apps/web y expone landing publica, dashboard privado/local y una API route de busqueda alimentaria.",
                    "El estado principal se guarda en localStorage y, si Supabase esta configurado, se sincroniza con PostgreSQL usando un adaptador remoto con debounce.",
                    "El modelo tipado compartido esta en packages/types y ya contempla inventario, carrito, finanzas, nutricion, agua, peso, planificador, rutinas y sesiones.",
                    "La base Supabase define 26 tablas publicas con RLS, indices, triggers updated_at y una Edge Function para eliminacion de cuenta.",
                    "La IA es BYOK: la clave del usuario se guarda solo en localStorage, no entra en FoodOSState y no se exporta.",
                    "La v9 documenta el estado real de codigo, no solo el diseno aspiracional de la v8.",
                ]
            ),
            table(
                [
                    ["Modulo", "Estado v9"],
                    ["Landing", "Implementada en / con hero, secciones de producto, mascotas, descarga y registro."],
                    ["Dashboard", "Implementado en /dashboard con 12 vistas: panel, registro, inventario, recetas, feed, carrito, finanzas, estadisticas, nutricion, asistente, planificador y ejercicios."],
                    ["Supabase", "Esquema SQL completo, auth, RLS, realtime parcial, Edge Function delete-account. Requiere variables de entorno para activarse."],
                    ["PWA", "Manifest y service worker basico network-first para / y /dashboard."],
                    ["Mobile/Desktop", "Carpetas reservadas con README; aun no hay implementacion Expo/Tauri."],
                ],
                [35 * mm, 125 * mm],
            ),
        )
    )

    story.extend(
        section(
            "2. Estructura Del Monorepo",
            code(
                """FoodOScodex/
  apps/
    web/                 Next.js 14 activa
      src/app/           rutas /, /dashboard y /api/food-search
      src/components/    landing, dashboard, vistas y modales
      src/lib/           estado, calculos, IA, Supabase, exportacion y food lookup
      public/            PWA, iconos, imagenes y mascotas
    mobile/              reservado para Expo SDK 51
    desktop/             reservado para Tauri
  packages/types/        contratos TypeScript compartidos
  supabase/              schema.sql y Edge Functions
  docs/                  documentacion y activos de referencia
  scripts/               generadores y utilidades"""
            ),
            table(
                [
                    ["Archivo", "Responsabilidad"],
                    ["apps/web/src/lib/state.tsx", "Fuente de estado global, migraciones, selectores, acciones de dominio y proveedor React."],
                    ["apps/web/src/lib/nutrition.ts", "TMB, TDEE, IMC, proteina, ciclado calorico, escalado de recetas, ahorro y kcal de ejercicio."],
                    ["apps/web/src/lib/data-layer.ts", "Persistencia local y adaptador Supabase: auth, pull, push, realtime, borrado de cuenta."],
                    ["apps/web/src/lib/ai-provider.ts", "Recetas IA, chat, plan semanal, importacion de recetas, rutinas y test de conexion."],
                    ["apps/web/src/lib/ai-inventory.ts", "Relleno de alimentos, vision para tickets/fotos y estimacion de comidas externas."],
                    ["apps/web/src/lib/food-lookup.ts", "Open Food Facts, USDA DEMO_KEY, cache de 30 dias y autocompletado."],
                    ["supabase/schema.sql", "Modelo PostgreSQL completo con RLS y tablas de soporte."],
                    ["supabase/functions/delete-account/index.ts", "Borrado GDPR via service role en Edge Function."],
                ],
                [48 * mm, 112 * mm],
            ),
        )
    )

    story.extend(
        section(
            "3. Stack Tecnico",
            table(
                [
                    ["Capa", "Tecnologia"],
                    ["Frontend", "Next.js 14.2, React 18.3, TypeScript 5.5, App Router."],
                    ["Runtime", "Node >= 18.17; npm workspaces; Turborepo preparado."],
                    ["Persistencia local", "localStorage con clave foodos-appweb-state-v1."],
                    ["Backend/DB", "Supabase Auth, PostgreSQL, Row Level Security, Realtime y Edge Functions."],
                    ["PWA", "manifest.json, sw.js y ServiceWorkerRegistrar."],
                    ["IA BYOK", "Gemini, OpenAI, Anthropic y Ollama local."],
                    ["APIs alimentarias", "Open Food Facts, search.openfoodfacts.org y USDA FoodData Central con DEMO_KEY."],
                    ["Ejercicios", "wger REST API para explorar ejercicios."],
                    ["Exportacion", "CSV client-side para diario, finanzas y peso."],
                ],
                [38 * mm, 122 * mm],
            ),
            p(
                "El diseno actual prioriza coste cero: localStorage funciona sin backend; Supabase se activa solo cuando hay "
                "NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY validas; las claves de IA son del usuario y no se "
                "centralizan en un servidor propio."
            ),
        )
    )

    story.extend(
        section(
            "4. Rutas, Navegacion Y Shell",
            bullets(
                [
                    "/ - landing publica con componentes Hero, Features, Showcase, HowItWorks, MascotsSection, DownloadSection, LoginSection y footer.",
                    "/dashboard - aplicacion principal envuelta por FoodOSProvider.",
                    "/api/food-search - proxy server-side hacia search.openfoodfacts.org para evitar CORS y normalizar hits como products.",
                    "El shell lateral contiene navegacion, mascota activa, acciones admin, ajustes y guard de autenticacion si Supabase esta configurado.",
                    "ViewErrorBoundary encapsula cada vista para que una excepcion no rompa toda la aplicacion.",
                    "AppTour y OnboardingFlow guian el primer uso; su estado se guarda en localStorage.",
                ]
            ),
            table(
                [
                    ["Vista", "Funcion principal"],
                    ["Panel", "Resumen del dia: macros, agua, caducidades, presupuesto, sugerencias y plan de hoy."],
                    ["Registro", "Diario de comidas y agua, agrupado por fecha y tipo de comida."],
                    ["Inventario", "Alta manual, barcode, foto, ticket, OFF, consumo parcial y detalle nutricional."],
                    ["Recetas", "Listado, filtro, IA, importacion y detalle con escalado."],
                    ["Feed", "Publicaciones asociadas a recetas y comunidad."],
                    ["Carrito", "Items manuales, sugerencias de stock bajo/plan, compra a inventario y finanzas."],
                    ["Finanzas", "Ingresos, gastos, gastos fijos, 50/30/20, presupuestos y proyecciones."],
                    ["Estadisticas", "KPI, historico financiero, peso, categorias y macros."],
                    ["Nutricion", "Perfil fisico, objetivos, adherencia, peso, proyeccion y proteina/euro."],
                    ["Asistente", "Chat local/IA, acciones [INV] y [RECIPE], mascota y recetas inline."],
                    ["Planificador", "Semana por slots, drag/drop, plan IA y compra semanal."],
                    ["Ejercicios", "Rutinas, exploracion wger e historial de sesiones."],
                ],
                [34 * mm, 126 * mm],
            ),
        )
    )

    story.extend(
        section(
            "5. Estado Global Y Persistencia",
            p(
                "FoodOSProvider hidrata primero localStorage y despues, si hay sesion Supabase, crea filas base, tira del estado remoto, "
                "guarda copia local y se suscribe a realtime. Toda mutacion pasa por mutate(), que clona el estado, aplica la accion, "
                "recalcula objetivos diarios si hay perfil, guarda local y programa push remoto."
            ),
            code(
                """Flujo de mutacion:
usuario -> componente -> mutate(draft)
  -> aplica cambio en draft
  -> si hay profile: calcDailyTargets(profile, isGymDay(profile))
  -> saveLocalState(draft)
  -> remote.schedulePush(draft) con debounce 1800 ms
  -> render React"""
            ),
            table(
                [
                    ["Grupo de estado", "Campos"],
                    ["Inventario/compra", "inventory, cart, activeStorage, inventorySearch, dismissedSuggestions."],
                    ["Finanzas", "expenses, incomeSources, recurringExpenses, savingsGoalPct, weeklyBudget, bankSynced, categoryBudgets."],
                    ["Nutricion", "foodLog, waterLog, weightLog, profile, nutrition."],
                    ["Recetas/feed", "customRecipes, savedRecipeIds, feedPosts, recipeTag."],
                    ["Planificador", "mealPlan, plannerQuickMeals."],
                    ["Ejercicios", "routines, workoutLog."],
                    ["UX", "mascotId, settings, debugDate."],
                ],
                [38 * mm, 122 * mm],
            ),
            bullets(
                [
                    "normalizeState migra modos legacy en espanol, consumed/consumedMeals antiguos, ingredientes string y campos nuevos.",
                    "resetAll borra localStorage y estado en memoria.",
                    "seedDemo carga inventario, carrito, ingresos, gastos fijos, movimientos, feed, comidas, agua y peso demo.",
                    "La fecha debugDate permite simular hoy para depuracion admin.",
                ]
            ),
        )
    )

    story.extend(
        section(
            "6. Modelo De Datos Supabase",
            p(
                "El SQL actual define 26 tablas publicas. La mayoria son de usuario y aplican RLS por user_id; almacenes usan membresia; "
                "recetas y feed permiten lectura publica segun visibilidad. La tabla bank_connections guarda solo IDs de proveedor, no credenciales bancarias."
            ),
            table(
                [
                    ["Dominio", "Tablas"],
                    ["Catalogo/perfil", "mascots, user_profiles."],
                    ["Inventario", "almacenes, almacen_members, inventory_items."],
                    ["Recetas", "recipes, recipe_ingredients, recipe_steps, recipe_saves, recipe_likes."],
                    ["Carrito", "shopping_lists, shopping_items."],
                    ["Feed", "feed_posts, feed_post_likes, feed_comments."],
                    ["Nutricion", "nutrition_goals, food_log, water_log."],
                    ["Finanzas", "gastos, ingresos_fuentes, objetivos_ahorro, bank_connections."],
                    ["IA/soporte", "ingredient_searches, ai_recipe_cache, ai_events, notification_events."],
                ],
                [36 * mm, 124 * mm],
            ),
            bullets(
                [
                    "Triggers set_updated_at en user_profiles, almacenes, inventory_items, recipes, shopping_lists, shopping_items, feed_posts y feed_comments.",
                    "Indices principales por owner/user, fecha, categoria, visibilidad, cache_key y expiry.",
                    "is_almacen_member() es funcion security definer para comprobar acceso a almacenes compartidos.",
                    "ai_recipe_cache es legible por usuarios autenticados; las escrituras deben venir de service role/API route.",
                ]
            ),
        )
    )

    story.extend(
        section(
            "7. Seguridad Y Privacidad",
            bullets(
                [
                    "No se documentan valores de variables de entorno ni claves reales.",
                    "Supabase anon key es publica por diseno; service role key solo vive en Edge Function y nunca en cliente.",
                    "RLS protege filas propias: perfiles, carrito, nutricion, food_log, gastos, ingresos, objetivos, conexiones bancarias y notificaciones.",
                    "Las claves IA BYOK se almacenan en localStorage bajo foodos-ai-config; no se exportan con FoodOSState.",
                    "bank_connections guarda provider, institution_id, requisition_id y account_ids, nunca credenciales bancarias.",
                    "Eliminar cuenta invoca una Edge Function con JWT del usuario y admin.deleteUser(user.id); el borrado en cascada depende de FK on delete cascade.",
                    "Riesgo a vigilar: las llamadas BYOK a proveedores IA se hacen desde el cliente; para produccion multiusuario se recomienda proxy server-side opcional.",
                ]
            ),
            table(
                [
                    ["Variable", "Uso"],
                    ["NEXT_PUBLIC_SUPABASE_URL", "URL publica del proyecto Supabase."],
                    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "Clave anonima publica de Supabase."],
                    ["NEXT_PUBLIC_ADMIN_EMAILS", "Lista de emails admin para mostrar herramientas de desarrollo."],
                    ["SUPABASE_URL", "Edge Function delete-account."],
                    ["SUPABASE_ANON_KEY", "Edge Function para validar JWT de usuario."],
                    ["SUPABASE_SERVICE_ROLE_KEY", "Edge Function para borrar usuario con privilegios admin. No debe llegar al cliente."],
                ],
                [58 * mm, 102 * mm],
            ),
        )
    )

    story.extend(
        section(
            "8. Calculos Nutricionales",
            code(
                """TMB Mifflin-St Jeor:
base = 10 * pesoKg + 6.25 * alturaCm - 5 * edad
hombre = base + 5
mujer  = base - 161

TDEE:
tdee = round(tmb * factorActividad)

IMC:
imc = pesoKg / (alturaM * alturaM)"""
            ),
            table(
                [
                    ["Actividad", "Factor"],
                    ["sedentary", "1.20"],
                    ["light", "1.375"],
                    ["moderate", "1.45"],
                    ["active", "1.65"],
                    ["very_active", "1.90"],
                ],
                [55 * mm, 35 * mm],
            ),
            code(
                """Proteina base:
si bodyFatPct existe:
  base = pesoKg * (1 - bodyFatPct / 100)
si obesidad relativa:
  ideal = 25 * alturaM^2
  adjusted = ideal + (pesoActual - ideal) * 0.33
si no:
  base = pesoActual

Objetivos:
proteina = round(base * 2.0) para fat_loss/recomp
proteina = round(base * 1.8) para maintain/muscle_gain
grasaKcal = kcal * fatPct
carbos = max(0, kcal - proteina*4 - grasaKcal) / 4"""
            ),
            table(
                [
                    ["Modo", "Factor kcal"],
                    ["fat_loss", "0.80 del TDEE."],
                    ["muscle_gain", "1.05 si IMC < 27; 0.90 si IMC >= 27."],
                    ["recomp", "IMC >= 30: 0.83 gym / 0.80 descanso; IMC < 30: 0.90 gym / 0.83 descanso."],
                    ["maintain", "1.00 del TDEE."],
                ],
                [36 * mm, 124 * mm],
            ),
            bullets(
                [
                    "Las calorias nunca bajan de 1200 kcal por proteccion basica.",
                    "Los dias de gym se detectan por profile.gymDays con Date.getDay().",
                    "La adherencia es hit si proteina >= 80% objetivo y kcal entre 80% y 115% objetivo.",
                    "countLowProteinDays cuenta cuantos de los ultimos 3 dias no llegaron al 80% de proteina.",
                ]
            ),
        )
    )

    story.extend(
        section(
            "9. Recetas, Porciones Y Cocina",
            bullets(
                [
                    "Las recetas tienen macros por racion, coste por racion, ingredientes, pasos, imagen, tags y flag aiGenerated.",
                    "CreateRecipeModal calcula macros por racion desde ingredientes cuando hay kcal/proteina/carbos/grasa por 100 g.",
                    "El lookup de ingredientes sigue prioridad: food-db local, inventario, /api/food-search y edicion manual.",
                    "CookModal escala por raciones y, si los ingredientes tienen macros por 100 g, recalcula macros vivos por cantidades reales.",
                    "La conversion a gramos contempla kg, L, oz, lb, cucharada, pizca y ud.",
                    "Al cocinar con descuento activo, actions.cookRecipe descuenta inventario FIFO por caducidad y borra lotes a 0.",
                    "Si faltan ingredientes, CookModal permite enviarlos al carrito con tienda por defecto.",
                ]
            ),
            code(
                """Escalado:
ratio = racionesElegidas / racionesBase
kcal = round(recipe.kcal * ratio)
protein = round(recipe.protein * ratio * 10) / 10
cost = round(recipe.cost * ratio * 100) / 100

Ajuste por kcal:
ratio = targetKcal / recipe.kcal
ratio seguro entre 0.1 y 6"""
            ),
        )
    )

    story.extend(
        section(
            "10. Inventario Y Caducidades",
            bullets(
                [
                    "Almacenes visibles: Todos, Nevera, Congelador y Despensa; en Supabase se mapean a fridge, freezer y pantry.",
                    "Alta manual: nombre, cantidad, unidad, almacen, caducidad, precio, kcal/100 g y proteina/100 g.",
                    "Autocompletado local desde food-db y remoto desde Open Food Facts con debounce de 600 ms.",
                    "Completar datos usa BD local, Open Food Facts/USDA con cache y, como ultimo recurso, IA configurada.",
                    "BarcodeScannerModal usa BarcodeDetector si esta disponible y consulta el endpoint producto de Open Food Facts.",
                    "Foto alimento identifica nombre y macros por vision IA; ticket/foto extrae multiples productos para importacion masiva.",
                    "El inventario se agrupa por nombre, ordena lotes por caducidad y muestra badges de caducado/hoy/manana/dias.",
                    "Consumir descuenta cantidad parcial, registra foodLog y elimina item si queda a 0.",
                ]
            ),
            table(
                [
                    ["Umbral", "Badge"],
                    ["dias < 0", "Caducado - rojo pulse."],
                    ["dias = 0", "Caduca hoy - rojo."],
                    ["dias = 1", "Manana - rojo."],
                    ["dias <= 3", "X dias - amber."],
                    ["dias <= 7", "X dias - amber-soft."],
                    ["resto", "X dias - green."],
                ],
                [40 * mm, 90 * mm],
            ),
        )
    )

    story.extend(
        section(
            "11. Diario, Agua Y Registro De Comidas",
            bullets(
                [
                    "El diario se agrupa por fecha y por mealType: breakfast, lunch, snack y dinner.",
                    "mealType se infiere por hora con mealTypeFromTime si falta en datos antiguos o remotos.",
                    "Registro soporta cuatro tabs: inventario, receta, plato elaborado y comida externa.",
                    "Inventario: seleccion multiproducto, cantidades editables y descuento automatico.",
                    "Receta: seleccion de receta y raciones; registra sin descontar inventario desde este modal.",
                    "Plato elaborado: ingredientes desde inventario/OFF, macros calculados, descuento opcional y guardado opcional como receta.",
                    "Comida externa: descripcion libre, estimacion IA, ajuste manual de macros y coste opcional que genera gasto en Comida.",
                    "Agua se guarda en waterLog por fecha y se suma/resta en pasos de 250/500/750 ml segun vista.",
                ]
            ),
            code(
                """Macros de alimento por cantidad:
si unit es g o ml:
  factor = qty / 100
si unit es kg o L:
  factor = qty * 1000 / 100
si unit es ud:
  la app usa equivalencias segun contexto; en platos, 1 ud ~= 60 g; en recetas, 1 ud ~= 100 g.

totalesDia = sum(foodLog[date == hoy])"""
            ),
        )
    )

    story.extend(
        section(
            "12. Planificador Semanal",
            bullets(
                [
                    "La semana empieza en lunes y se guarda como mealPlan[yyyy-mm-dd].",
                    "Slots: breakfast, almuerzo, lunch, merienda y dinner.",
                    "Acepta recetas existentes y platos rapidos de plannerQuickMeals.",
                    "Desktop usa drag/drop; movil permite seleccionar receta y tocar celda.",
                    "Totales diarios comparan kcal, proteina, grasa y carbos contra objetivos actuales.",
                    "Plan IA genera JSON con IDs validos de recetas y rellena los slots de la semana.",
                    "Comprar semana calcula faltantes de ingredientes frente a inventario y carrito y los envia al carrito.",
                    "Registrar desde el plan abre CookModal si es receta real o registra directo si es plato rapido.",
                ]
            ),
            code(
                """Faltantes de compra:
para cada receta planificada:
  para cada ingrediente:
    inStock = suma qty de items cuyo nombre coincide por primera palabra
    shortfall = max(0, ingrediente.quantity - inStock)
    si shortfall > 0 y no esta en carrito:
      crear CartItem source='plan'"""
            ),
        )
    )

    story.extend(
        section(
            "13. Carrito Y Flujo Compra-Finanzas-Inventario",
            bullets(
                [
                    "El carrito acepta items manuales y sugerencias de stock bajo o plan semanal.",
                    "Stock bajo usa thresholds configurables por unidad y excluye items ya presentes en carrito.",
                    "Completar compra procesa items checked: crea gasto categoria Comida y mueve productos a inventario.",
                    "Mover a despensa mueve checked sin crear gasto.",
                    "Al mover al inventario se intenta enriquecer con food-db local o datos del item existente.",
                    "El historial de compras se deriva de expenses con type expense y category Comida.",
                    "El presupuesto mostrado se compara contra getBudgetLeft y budgetWarnPct.",
                ]
            ),
        )
    )

    story.extend(
        section(
            "14. Finanzas Personales",
            bullets(
                [
                    "Movimientos soportan type expense/income, amount, category, description y date.",
                    "Fuentes recurrentes de ingreso usan weekly, biweekly, monthly o yearly y dayOfMonth opcional.",
                    "Gastos fijos recurrentes se descuentan del balance mensual y se pueden pausar.",
                    "La vista calcula ingresos fijos/mes, ingresos extra 30 dias, gastos fijos, variables 30 dias y ahorro mensual.",
                    "La regla 50/30/20 reparte necesidades, deseos y ahorro; los presupuestos por categoria son editables.",
                    "El presupuesto semanal de comida puede derivarse de categoryBudgets['Comida']/4.33 o del weeklyBudget manual.",
                    "FinanceChart dibuja las ultimas cuatro semanas de gastos variables en canvas.",
                ]
            ),
            code(
                """monthlyAmountOf:
weekly   = amount * 52 / 12
biweekly = amount * 26 / 12
monthly  = amount
yearly   = amount / 12

Proyeccion ahorro:
FV(m, n, r) = r == 0 ? m*n : m * ((1 + r/12)^n - 1) / (r/12)
emergencyFundMonths = ceil((monthlyExpenses * 3) / monthlyAmount)"""
            ),
        )
    )

    story.extend(
        section(
            "15. Estadisticas Y Proyeccion De Peso",
            bullets(
                [
                    "StatsView resume racha de macros, peso actual, tasa de ahorro media y gastos de 30 dias.",
                    "Grafica finanzas de 6 meses desde movimientos explicitos; la nota aclara que no incluye fijos por mes.",
                    "Grafica peso de los ultimos 30 registros.",
                    "Grafica macros de 28 dias con kcal y proteina contra objetivo.",
                    "NutritionView muestra evolucion de macros 7 dias, heatmap de adherencia 28 dias y ranking proteina/euro.",
                    "La proyeccion de peso requiere al menos 3 dias de comidas con 500 kcal o mas.",
                ]
            ),
            code(
                """Proyeccion peso:
avgKcal = promedio de dias validos ultimos 14 dias
dailyDelta = TDEE - avgKcal   # positivo = deficit
weeklyKg = dailyDelta * 7 / 7700
pesoEnDias = currentKg - (dailyDelta * dias) / 7700
diasObjetivo = ceil(((currentKg - targetKg) * 7700) / dailyDelta)"""
            ),
            bullets(
                [
                    "Ritmo agresivo: abs(weeklyKg) > 0.75 kg/semana.",
                    "Ritmo lento: abs(weeklyKg) < 0.2 en objetivos distintos de mantenimiento/recomp.",
                    "Agua recomendada sugerida: pesoKg * 35 ml/dia.",
                ]
            ),
        )
    )

    story.extend(
        section(
            "16. Asistente IA Y BYOK",
            bullets(
                [
                    "Proveedores soportados: Gemini, OpenAI, Anthropic y Ollama.",
                    "Rate limiter local: maximo 15 solicitudes por minuto.",
                    "generateAIRecipe usa inventario, macros pendientes, presupuesto, alergias y caducidades.",
                    "callAIChat inyecta personalidad de mascota, datos actuales y reglas de accion.",
                    "El chat puede devolver tags [INV] y [RECIPE]; la UI los parsea y ejecuta acciones controladas.",
                    "Si la IA falla por cuota/rate/503, AssistantView puede responder con fallback local.",
                    "importRecipeFromText e importRecipeFromImage extraen recetas desde texto o imagen.",
                    "generateAIWeeklyPlan devuelve IDs validos de recetas por dia y slot.",
                    "generateAIRoutine crea rutinas segun objetivo, peso y dias de gym.",
                ]
            ),
            table(
                [
                    ["Funcion", "Salida"],
                    ["generateAIRecipe", "Recipe aiGenerated con ingredientes, pasos, macros, coste, tiempo y tags."],
                    ["callAIChat", "Texto de asistente con accion opcional [INV] o [RECIPE]."],
                    ["importRecipeFromText/Image", "Recipe revisable antes de guardar."],
                    ["generateAIWeeklyPlan", "Record fecha -> slots -> recipeId/null."],
                    ["generateAIRoutine", "Routine con ejercicios, series, repeticiones, descanso y notas."],
                    ["testAIConnection", "Ping JSON para validar proveedor/modelo/clave."],
                ],
                [50 * mm, 110 * mm],
            ),
        )
    )

    story.extend(
        section(
            "17. APIs Externas",
            table(
                [
                    ["API", "Uso actual"],
                    ["Open Food Facts product", "BarcodeScannerModal consulta world.openfoodfacts.org/api/v2/product/{barcode}.json."],
                    ["Open Food Facts search", "/api/food-search consulta search.openfoodfacts.org/search y normaliza hits."],
                    ["USDA FoodData Central", "Fallback para alimentos traducidos ES->EN con DEMO_KEY, pageSize 3."],
                    ["Gemini", "Generacion, chat, vision, importacion de recetas, tickets, alimento por foto y rutinas."],
                    ["OpenAI", "Chat completions y vision en modelos compatibles."],
                    ["Anthropic", "Messages API y vision en modelos compatibles."],
                    ["Ollama", "Servidor local /api/chat, sin clave."],
                    ["wger", "Explorar ejercicios con /api/v2/exerciseinfo/?format=json&language=2&category=...&limit=20."],
                    ["Supabase", "Auth, Postgres, Realtime y Edge Function delete-account."],
                ],
                [45 * mm, 115 * mm],
            ),
            bullets(
                [
                    "Las llamadas externas GET del service worker no se interceptan si el origen no coincide con la app.",
                    "Open Food Facts search tiene timeout de 8-9 segundos segun capa.",
                    "USDA tiene timeout de 5 segundos y solo se usa si existe traduccion local del alimento.",
                    "food-lookup cachea resultados externos 30 dias en localStorage.",
                ]
            ),
        )
    )

    story.extend(
        section(
            "18. Ejercicios Y Rutinas",
            bullets(
                [
                    "ExercisesView tiene tabs: Mis rutinas, Explorar e Historial.",
                    "Rutina manual: nombre, objetivo, duracion, ejercicios, series, repeticiones y descanso.",
                    "Rutina IA: se genera desde perfil nutricional y se previsualiza antes de guardar.",
                    "Explorar wger filtra por categorias abdomen, brazos, espalda, pecho, piernas y hombros.",
                    "Se pueden anadir ejercicios wger a una rutina existente.",
                    "Registrar sesion guarda fecha, duracion, kcal quemadas, notas y series completadas por ejercicio.",
                    "Historial resume sesiones, minutos y kcal de la semana.",
                ]
            ),
            code(
                """Estimacion kcal ejercicio:
kcal = round((MET - 1) * 3.5 * pesoKg / 200 * minutos)
MET por defecto = 5.0 para fuerza moderada
Se resta 1 MET para aproximar gasto neto sobre basal."""
            ),
        )
    )

    story.extend(
        section(
            "19. PWA, Offline Y Exportaciones",
            bullets(
                [
                    "manifest.json inicia en /dashboard, display standalone, scope / y orientacion portrait-primary.",
                    "sw.js precachea / y /dashboard.",
                    "Estrategia fetch: network-first para GET del mismo origen, cacheando respuestas ok y cayendo en cache offline.",
                    "No intercepta APIs externas ni llamadas a Supabase/IA/OFF.",
                    "ServiceWorkerRegistrar registra /sw.js en cliente y silencia errores.",
                    "Ajustes exporta CSV de diario de comidas por mes, finanzas por mes y peso completo.",
                    "Admin en shell puede exportar/importar JSON completo de estado, cargar demo y borrar datos locales.",
                ]
            ),
        )
    )

    story.extend(
        section(
            "20. Landing, Assets Y Mascotas",
            bullets(
                [
                    "La landing esta compuesta por secciones especializadas en apps/web/src/components/landing.",
                    "Los assets publicos incluyen hero, recetas demo, hoja de mascotas y 15 webp individuales.",
                    "Mascotas: zana, basil, froggy, sage, chip, mushi, bruno, pica, okto, kiri, vera, pingo, volt, leo y luna.",
                    "Cada mascota tiene color, tagline, imagen y personalidad opcional que se inyecta en el prompt del asistente.",
                    "MascotWidget usa estados idle, wave, thinking, celebrate, alert, suggest, sleep, success_buy y streak.",
                ]
            ),
        )
    )

    story.extend(
        section(
            "21. Flujos Cruzados Principales",
            table(
                [
                    ["Flujo", "Resumen"],
                    ["Inventario -> Recetas", "getRecipeMatch calcula disponibilidad por coincidencia de nombre y prioriza recetas con mas match y proteina."],
                    ["Recetas -> Nutricion", "CookModal/actions.cookRecipe registran foodLog y actualizan consumido del dia."],
                    ["Recetas -> Inventario", "Cocinar con descuento resta ingredientes FIFO por caducidad."],
                    ["Planificador -> Carrito", "Comprar semana calcula faltantes frente a inventario y carrito."],
                    ["Carrito -> Finanzas", "Completar compra crea gasto categoria Comida."],
                    ["Carrito -> Inventario", "Completar compra o mover a despensa crea items de inventario con datos conocidos."],
                    ["Diario -> Peso", "La proyeccion de peso usa ingesta media del foodLog."],
                    ["Ejercicio -> Deficit", "Actualmente se registra kcal quemada; roadmap propone integrarlas al deficit real."],
                    ["Asistente -> Inventario", "Tag [INV] crea item con cantidad, unidad, almacen, caducidad, precio y macros."],
                    ["Asistente -> Receta", "Tag [RECIPE] crea tarjeta revisable, con acciones guardar, carrito o cocinar."],
                ],
                [45 * mm, 115 * mm],
            ),
        )
    )

    story.extend(
        section(
            "22. Limitaciones Reales Detectadas",
            bullets(
                [
                    "water_log existe en schema.sql, pero data-layer todavia tiene TODO para pull/push remoto de agua.",
                    "food_log en schema tiene meal_type, pero data-layer pull/push aun infiere o no persiste mealType explicitamente.",
                    "Feed remoto: publicar posts propios requiere sembrar antes recipes; el push de feed esta marcado como TODO.",
                    "Supabase sync es naive por MVP: upsert de estado completo y delete de ausentes; para multiusuario conviene mutaciones por accion.",
                    "La IA BYOK desde cliente expone la clave al navegador del usuario; es aceptable para BYOK personal, pero no para claves de negocio.",
                    "Mobile y desktop estan reservadas, no implementadas.",
                    "Los modelos listados en ai-config son los definidos en codigo; conviene revisar disponibilidad antes de lanzar produccion.",
                    "El service worker es offline basico, no una estrategia Workbox completa con cola de mutaciones.",
                ]
            ),
        )
    )

    story.extend(
        section(
            "23. Roadmap De Produccion",
            bullets(
                [
                    "Completar sync remoto de water_log y meal_type.",
                    "Sembrar recetas demo en Supabase y activar publicacion completa de feed.",
                    "Cambiar sync remoto a mutaciones por accion para evitar conflictos multi-dispositivo.",
                    "Endurecer IA con API routes opcionales para usuarios que no quieran exponer claves en cliente.",
                    "Integrar Supabase Storage para imagenes de recetas personalizadas.",
                    "Ampliar PWA offline con Workbox, colas de escritura y banner offline.",
                    "Integrar kcal de workoutLog en proyeccion de deficit y recomendaciones.",
                    "Anadir notificaciones de caducidad con Web Notifications y service worker.",
                    "Crear app Expo reutilizando packages/types y extrayendo core compartido.",
                    "Crear app Tauri envolviendo el deploy web o build estatico.",
                    "Ejecutar auditoria accesibilidad, tests de dominio y pruebas E2E antes de produccion.",
                ]
            ),
        )
    )

    story.extend(
        section(
            "24. Checklist De Puesta En Marcha",
            bullets(
                [
                    "Crear proyecto Supabase y ejecutar supabase/schema.sql completo.",
                    "Activar Email/Magic Link y Google OAuth si se requiere login social.",
                    "Configurar NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY en apps/web/.env.local.",
                    "Desplegar Edge Function delete-account con SUPABASE_URL, SUPABASE_ANON_KEY y SUPABASE_SERVICE_ROLE_KEY en entorno seguro.",
                    "Configurar NEXT_PUBLIC_ADMIN_EMAILS solo si se necesitan herramientas admin.",
                    "Probar alta, login, confirmacion, reenvio, logout y eliminacion de cuenta.",
                    "Probar inventario, cocinar, diario, carrito, gasto automatico, planificador, IA y exportaciones.",
                    "Verificar que ningun secreto real se sube a git ni aparece en PDFs o capturas.",
                ]
            ),
            p(
                "Esta v9 queda alineada con el codigo actual del repositorio a 29/06/2026. La documentacion v8 sigue siendo util "
                "como vision amplia, pero v9 es la referencia tecnica operativa para continuar desarrollo."
            ),
        )
    )

    if story and isinstance(story[-1], PageBreak):
        story.pop()
    return story


def build_pdf():
    DOCS.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)

    pdf_path = DOCS / PDF_NAME
    out_path = OUTPUT / PDF_NAME

    doc = SimpleDocTemplate(
        str(pdf_path),
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=20 * mm,
        bottomMargin=18 * mm,
        title="FoodOS Documentacion Tecnica v9",
        author="Codex",
        subject="Documentacion tecnica FoodOS",
    )
    doc.build(build_story(), onFirstPage=footer, onLaterPages=footer)
    shutil.copyfile(pdf_path, out_path)
    return pdf_path, out_path


if __name__ == "__main__":
    p1, p2 = build_pdf()
    print(f"PDF docs: {p1}")
    print(f"PDF output: {p2}")
