# FoodOS

App unificada de **inventario de alimentos, nutrición y finanzas personales**.
Monorepo basado en la documentación técnica v3.0 (98 págs., en `docs/`).

## Estructura del monorepo

```text
FoodOScodex/
├── apps/
│   ├── web/          ← Next.js 14 (landing + dashboard) — ACTIVA
│   │   ├── public/   ← imágenes optimizadas (webp) y 15 avatares recortados
│   │   └── src/
│   │       ├── app/         ← rutas: / (landing) y /dashboard (app)
│   │       ├── components/  ← landing/ y dashboard/ (vistas React)
│   │       └── lib/         ← estado, data-layer, Supabase, recetas, mascotas
│   ├── mobile/       ← reservada: Expo SDK 51 (ver su README)
│   └── desktop/      ← reservada: Tauri (ver su README)
├── packages/
│   └── types/        ← tipos TypeScript compartidos (@foodos/types)
├── supabase/
│   └── schema.sql    ← esquema completo: 24 tablas + RLS + triggers
├── docs/             ← PDF técnico, modelo de datos, lámina de avatares
├── package.json      ← npm workspaces (raíz)
└── turbo.json        ← preparado para Turborepo cuando haya varias apps
```

## Arrancar en local

```powershell
npm install
npm run dev
```

- Landing: `http://localhost:3000/`
- App: `http://localhost:3000/dashboard`

`npm run build` genera el build de producción (ambas rutas son estáticas).

## Estado actual

- **Landing** (`/`): 100% orientada a producto. Hero con parallax, ticker,
  7 módulos en bento, demo de recomendación contextual, cómo funciona,
  los **15 compañeros con sus avatares reales**, descarga con QR y registro.
- **Dashboard** (`/dashboard`): inventario, recetas, feed, carrito, finanzas,
  nutrición y asistente, todo en React con estado persistente. Exportar/importar
  JSON y botón Cuenta.
- **Nutrición personalizada** (PDF §9): onboarding de perfil físico (edad, sexo,
  altura, peso, % graso, actividad, objetivo, días de gym, alergias/exclusiones),
  TMB/TDEE con Mifflin-St Jeor, 4 modos de objetivo y **ciclado calórico**
  automático gym/descanso. Los macros del día se calculan solos.
- **Recetas que se adaptan** (PDF §5.3, §9.7): escalado por raciones o por kcal
  objetivo y botón "ajustar a mis macros pendientes" (reparte las kcal entre las
  comidas que quedan según la hora). Las recetas IA se generan con el inventario
  real (priorizando lo que caduca), macros pendientes y presupuesto, y son
  **editables antes de guardar** (flag `aiGenerated`).
- **Ahorro** (PDF §8): fuentes de ingreso recurrentes, balance mensual y
  proyección con interés compuesto (6m/1a/5a/10a, fondo de emergencia).
- **Datos**: localStorage hoy. El adaptador de Supabase
  ([apps/web/src/lib/data-layer.ts](apps/web/src/lib/data-layer.ts)) ya
  implementa auth (Google + magic link), pull del estado desde las tablas y
  push automático con debounce. Solo faltan las claves.

## Conectar la base de datos (≈30 min)

1. Crea un proyecto free en [supabase.com](https://supabase.com).
2. SQL Editor → ejecuta `supabase/schema.sql` completo.
3. Authentication → Providers: activa **Email** (magic link) y **Google**
   (requiere OAuth client en Google Cloud Console).
4. Copia `apps/web/.env.local.example` como `apps/web/.env.local` y rellena
   `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   (Project Settings → API).
5. Reinicia `npm run dev`. El botón **Cuenta** del dashboard ya permite
   iniciar sesión; al entrar se hidrata el estado desde la base de datos y
   cada cambio se sincroniza automáticamente.

## Siguientes pasos

### Corto plazo
- [ ] Crear el proyecto de Supabase y conectar (pasos de arriba).
- [ ] Sembrar las recetas demo en la tabla `recipes` (hoy viven en
      `apps/web/src/lib/recipes.ts`) y activar el push del feed.
- [ ] Deploy en Vercel: importar el repo, root directory `apps/web`,
      añadir las dos variables de entorno.

### Medio plazo
- [ ] Sustituir el sync naive (upsert + delete) por mutaciones por acción
      para soportar multiusuario y almacenes compartidos (Realtime).
- [ ] APIs externas: Open Food Facts (barcode, sin clave), Gemini 1.5 Flash
      vía API route (nunca la key en el cliente), Nordigen (banco PSD2),
      Cloudinary (vídeo del feed).
- [ ] Conectar Gemini al generador de recetas (hoy es una simulación local con
      los datos reales del usuario; el prompt de producción está en el PDF §15.6).
- [ ] Registro de comidas por franja horaria (desayuno/comida/cena/snack) y
      sugerencia de cena para cerrar macros (PDF §9, §11.4).
- [ ] Animaciones GSAP ScrollTrigger y video scrubbing del hero (PDF §16-17)
      cuando exista el vídeo.

### Largo plazo
- [ ] `apps/mobile`: Expo SDK 51 (README dentro con los comandos).
- [ ] `apps/desktop`: Tauri envolviendo el deploy web (README dentro).
- [ ] Extraer lógica común a `packages/core` cuando móvil la necesite.
- [ ] Sprites Lottie de las mascotas (9 estados por personaje, PDF §23).

### Pendiente manual (cuentas y pagos)
- Claves: Supabase, Vercel, Google AI Studio, Cloudinary, Nordigen, Firebase FCM.
- Stores: Google Play (25 USD una vez) · Apple Developer (99 USD/año).
- Asset: vídeo del hero para el efecto scrubbing.

## Historial

El prototipo anterior en HTML/CSS/JS vanilla (landing + `fooOSappweb`) quedó
guardado en el historial de git, commit *"Estado previo a la migración a
monorepo Next.js"*.
