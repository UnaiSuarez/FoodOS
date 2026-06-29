# FoodOS

App unificada de **alimentación, ejercicio y finanzas personales**. Monorepo Next.js 14 con Supabase, sync en tiempo real y PWA offline.

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | Next.js 14 App Router, React, TypeScript |
| Base de datos | Supabase (PostgreSQL + RLS + Realtime) |
| Auth | Supabase Auth — Google OAuth y magic link |
| Estado | React Context + localStorage + sync bidireccional |
| Sync | Debounce push 400 ms · Realtime event-driven (<200 ms) |
| PWA | Service Worker v2 — cache-first estáticos, network-first nav |

## Estructura

```text
FoodOScodex/
├── apps/
│   ├── web/              ← Next.js 14 (landing + dashboard) — ACTIVA
│   │   ├── public/       ← 15 avatares webp, sw.js, manifest.json
│   │   └── src/
│   │       ├── app/      ← rutas: / (landing) y /dashboard
│   │       ├── components/dashboard/views/   ← 13 vistas React
│   │       └── lib/      ← state.tsx, data-layer.ts, nutrition.ts, ai-config.ts
│   ├── mobile/           ← reservada: Expo SDK 51
│   └── desktop/          ← reservada: Tauri
├── packages/types/       ← tipos TypeScript compartidos (@foodos/types)
├── supabase/
│   ├── schema.sql        ← 25 tablas + RLS + triggers
│   └── migrations/       ← migraciones incrementales
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

1. Crea un proyecto en [supabase.com](https://supabase.com).
2. SQL Editor → ejecuta `supabase/schema.sql` y luego cada archivo en `supabase/migrations/`.
3. Authentication → activa **Email** (magic link) y **Google** (OAuth client en Google Cloud Console).
4. Copia `.env.local.example` como `apps/web/.env.local` y rellena:
   ```
   NEXT_PUBLIC_SUPABASE_URL=...
   NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   NEXT_PUBLIC_ADMIN_EMAILS=tu@email.com
   ```
5. `npm run dev` — el botón Cuenta ya sincroniza todo.

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
| Nutrición | TMB/TDEE Mifflin-St Jeor, 4 modos de objetivo, ciclado calórico gym/descanso, ESPEN adjusted weight, rango proteína 5 puntos, integración con kcal quemadas |
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

- **TMB/TDEE** con Mifflin-St Jeor y multiplicador de actividad.
- **4 modos**: déficit, mantenimiento, volumen limpio, pérdida acelerada.
- **Ciclado calórico** automático: kcal distintas en días de gym vs. descanso.
- **Proteína**: fórmula ESPEN con peso ajustado para obesidad; rango 5 puntos (1.6–2.4 g/kg).
- **Integración ejercicio**: las kcal quemadas hoy se suman al objetivo efectivo del día.

## PWA

Service Worker v2 activo en producción:
- Cache-first para JS/CSS/imágenes compilados.
- Network-first con fallback para navegación.
- Banner ámbar automático cuando el dispositivo pierde conexión.

## Pendiente

- [ ] Notificaciones de caducidad (Web Notifications + SW push).
- [ ] Imágenes propias para recetas (Supabase Storage).
- [ ] Integración bancaria PSD2/Nordigen.
- [ ] Deploy en Vercel (root directory `apps/web`, añadir las dos variables de entorno).
- [ ] `apps/mobile`: Expo SDK 51.
- [ ] `apps/desktop`: Tauri envolviendo el deploy web.
- [ ] Sprites Lottie para las mascotas (9 estados por personaje, PDF §23).
- [ ] Animaciones GSAP ScrollTrigger y video scrubbing del hero (PDF §16-17).
