# FoodOS

App unificada de **alimentación, ejercicio y finanzas personales**. Monorepo Next.js 15 con Supabase, sync en tiempo real y PWA offline.

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | Next.js 15 App Router, React, TypeScript |
| Base de datos | Supabase (PostgreSQL + RLS + Realtime) |
| Auth | Supabase Auth — Google OAuth y magic link |
| Estado | React Context + localStorage + sync bidireccional |
| Sync | Debounce push 400 ms · Realtime event-driven (<200 ms) |
| PWA | Service Worker v2 — cache-first estáticos, network-first nav |

## Estructura

```text
FoodOScodex/
├── apps/
│   ├── web/              ← Next.js 15 (landing + dashboard) — ACTIVA
│   │   ├── public/       ← 15 avatares webp, sw.js, manifest.json
│   │   └── src/
│   │       ├── app/      ← rutas: / (landing) y /dashboard
│   │       ├── components/dashboard/views/   ← 13 vistas React
│   │       └── lib/      ← state.tsx, data-layer.ts, nutrition.ts, ai-config.ts
│   ├── mobile/           ← reservada: Expo SDK 51
│   └── desktop/          ← reservada: Tauri
├── packages/types/       ← tipos TypeScript compartidos (@foodos/types)
├── supabase/
│   ├── config.toml       ← configuración estándar del CLI (supabase start/db reset)
│   ├── migrations/       ← fuente de verdad: 26 tablas + RLS + triggers + funciones, en migraciones ordenadas
│   ├── functions/        ← Edge Functions (delete-account)
│   └── schema.sql        ← snapshot legacy DESACTUALIZADO — no es fuente de verdad, ver "Conectar Supabase"
└── docs/                 ← PDF técnico v9 (98 págs.)
```

## Arrancar en local

```bash
npm install
npm run dev
```

- Landing: `http://localhost:3000/`
- Dashboard: `http://localhost:3000/dashboard`

```bash
npm run build   # build de producción
```

## Conectar Supabase

El flujo recomendado usa exclusivamente `supabase/migrations/` — es la **única fuente reproducible**, la que la CLI conoce y ejecuta (`supabase db reset`/`db push` nunca leen `supabase/schema.sql`, ni de forma automática ni manual dentro del flujo de la CLI). `supabase/schema.sql` es un snapshot legacy **desactualizado**, no un espejo del estado final: incluye tablas `feed_*` que una migración posterior (`20260820072811_drop_feed_tables.sql`) elimina, y difiere del baseline real en otros puntos (comparado línea a línea contra el SQL exacto ya aplicado en remoto — ver `20260629120159_initial_schema.sql`). No sustituye un replay completo y no debe usarse como paso del setup ni como referencia de qué existe hoy.

**Proyecto local (desarrollo, sin depender de un proyecto remoto):**

1. [Instala Docker](https://docs.docker.com/get-docker/) (lo usa `supabase start` para levantar Postgres/Auth/Storage local).
2. `supabase start` — levanta el stack local completo.
3. `supabase db reset` — aplica todas las migraciones de `supabase/migrations/` en orden sobre la base local, desde vacío.
4. Copia `.env.local.example` como `apps/web/.env.local` y apunta a las URLs/claves locales que imprime `supabase start`.

**Proyecto remoto (Supabase Cloud):**

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. `supabase link --project-ref <tu-project-ref>` para enlazar el repo con el proyecto.
3. `supabase db push` — aplica las migraciones pendientes de `supabase/migrations/` contra el proyecto remoto, en orden.
4. Authentication → activa **Email** (magic link) y **Google** (OAuth client en Google Cloud Console).
5. Edge Functions → despliega `supabase/functions/delete-account` (`supabase functions deploy delete-account`). Necesita privilegios de service role para borrar la cuenta de `auth.users` — por eso vive como Edge Function y no como llamada directa desde el cliente (ver `deleteAccount()` en `data-layer.ts`). Sin desplegarla, el botón de borrar cuenta en Ajustes falla.
6. Copia `.env.local.example` como `apps/web/.env.local` y rellena:
   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   NEXT_PUBLIC_ADMIN_EMAILS=tu@email.com
   ```
7. `npm run dev` — el botón Cuenta ya sincroniza todo.

## Vistas del dashboard

| Vista | Funcionalidad clave |
|---|---|
| Panel | Resumen del día, accesos rápidos, agua con RPC atómico |
| Registro | Diario de comidas por fecha, agua, balance de macros |
| Inventario | Stock de alimentos, fechas de caducidad, escáner |
| Recetas | IA generativa (inventario + macros pendientes + presupuesto), escalado, edición previa a guardar, modo ahorro máximo |
| Feed | Feed social de recetas, compartir, cocinar desde tarjeta |
| Carrito | Lista de compra generada desde inventario y recetas |
| Finanzas | Fuentes de ingreso, balance mensual, proyección con interés compuesto (6m/1a/5a/10a) |
| Estadísticas | Gráficos SVG históricos de macros, peso y gasto |
| Nutrición | Nutrition Engine v3: TDEE Mifflin-St Jeor + modelo de actividad (vida diaria + entreno declarado, sin doble conteo), 4 objetivos (ganancia muscular nunca es un déficit encubierto), ciclado gym/descanso solo en recomposición, proteína por base de referencia (peso real/ajustado ESPEN/masa magra), motor adaptativo por ritmo de peso observado |
| Asistente | Chat IA contextual con historial del estado del usuario |
| Planificador | Planificación semanal de comidas |
| Ejercicios | Rutinas, explorador wger, generación IA, historial y kcal quemadas → objetivo nutricional |
| Ajustes | Perfil, tema claro/oscuro, tour, onboarding, export/import JSON |

## Sync y realtime

- **Push con debounce** (400 ms): cada cambio de estado se persiste en Supabase automáticamente.
- **Pull en tiempo real** (<200 ms): los cambios de otras sesiones llegan por `postgres_changes`.
- **Agua atómica**: RPC `fn_water_increment` aplica deltas en el servidor — sin conflictos entre pestañas.
- **Event-driven patch**: agua y peso se parchean directamente desde el payload (sin re-fetch); el resto usa debounce de refresco.

## Nutrición

Motor v3 (ver [`docs/NUTRITION_V3_DECISIONES.md`](docs/NUTRITION_V3_DECISIONES.md) para el porqué de cada decisión):

- **TDEE**: Mifflin-St Jeor + modelo de actividad de dos capas (vida diaria vía `LIFESTYLE_ONLY_FACTORS` + entrenamiento declarado vía `replacementIncrementKcal`, diseñado explícitamente para no contar dos veces la misma energía).
- **4 objetivos**: pérdida de grasa, recomposición, mantenimiento, ganancia muscular. Ganancia muscular **nunca** es un déficit encubierto — el factor base siempre es ≥1.0, cualquiera que sea el IMC.
- **Ciclado calórico gym/descanso**: solo en recomposición (IMC≥30: −17% a −20%; IMC<30: −10% a −17%, según sea día de gym o descanso). El resto de objetivos no varía entre días de entreno y descanso.
- **Proteína**: regla propia por base de referencia — peso real, peso ajustado (aproximación ESPEN) o masa magra si hay % de grasa registrado — sin heredar el mismo multiplicador entre bases. Rango real 1.8–2.6 g/kg según objetivo y base.
- **Motor adaptativo**: ajusta el objetivo calórico según si el ritmo de peso observado (no las kcal quemadas del día) coincide con la banda esperada del objetivo elegido, con cobertura de registro y confianza de tendencia mínimas antes de proponer nada. Las sesiones de ejercicio registradas se muestran en el módulo de Ejercicios pero **nunca** se suman de vuelta al presupuesto nutricional — el entrenamiento habitual ya está contado en el TDEE.

## PWA

Service Worker v2 activo en producción:
- Cache-first para JS/CSS/imágenes compilados.
- Network-first con fallback para navegación.
- Banner ámbar automático cuando el dispositivo pierde conexión.

## Pendiente

- [ ] Imágenes propias para recetas (Supabase Storage).
- [ ] Integración bancaria PSD2/Nordigen.
- [ ] `apps/mobile`: Expo SDK 51.
- [ ] `apps/desktop`: Tauri envolviendo el deploy web.
- [ ] Sprites Lottie para las mascotas (9 estados por personaje, PDF §23).
- [ ] Animaciones GSAP ScrollTrigger y video scrubbing del hero (PDF §16-17).
