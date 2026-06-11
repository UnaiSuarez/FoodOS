# FoodOS — prototipo web

Prototipo creado a partir de `FoodOS_Documentacion_Tecnica_v8.pdf` (98 paginas).
Incluye la **landing publica** y la **app web funcional** (sin backend todavia,
pero con la integracion de Supabase ya preparada).

## Estructura

| Carpeta / archivo | Que es |
| --- | --- |
| `index.html` + `styles.css` + `script.js` | Landing publica (seccion 16 del PDF) |
| `fooOSappweb/` | App web funcional con localStorage + capa de datos Supabase-ready |
| `fooOSappweb/supabase/schema.sql` | Esquema PostgreSQL completo con RLS, listo para ejecutar |
| `fooOSappweb/docs/data-model.md` | Modelo de datos y mapeo mock → tablas |
| `FoodOSclaude/` | Version alternativa anterior (referencia, no se mantiene) |

## Abrir en local

Desde esta carpeta:

```powershell
python -m http.server 4177
```

- Landing: `http://localhost:4177/`
- App web: `http://localhost:4177/fooOSappweb/` (tambien enlazada desde la landing)

Tambien funciona abriendo los `index.html` directamente, aunque con servidor
los enlaces relativos y las fuentes van mejor.

## Estado actual

- **Landing**: hero animado con parallax, ticker infinito, modulos, demo de
  recomendacion, flujo, stack, mascotas, descarga con QR conceptual y pantalla
  de login maquetada (Google + enlace magico) lista para conectar a Supabase Auth.
- **App**: dashboard, inventario, recetas (con recetas IA locales persistentes),
  feed, carrito, finanzas (presupuesto semanal real de 7 dias), nutricion,
  asistente, 15 mascotas, exportar/importar datos en JSON y boton de cuenta.
- **Persistencia**: localStorage, encapsulada en `fooOSappweb/data-layer.js`.
  El adaptador de Supabase ya esta escrito (auth, pull y push de estado);
  solo falta crear el proyecto y poner las claves.

## Siguientes pasos (en orden)

### 1. Crear la base de datos (≈30 min)

1. Crear cuenta y proyecto free en [supabase.com](https://supabase.com).
2. SQL Editor → pegar y ejecutar `fooOSappweb/supabase/schema.sql`
   (crea las 24 tablas, indices, triggers y politicas RLS).
3. Authentication → Providers: activar **Email** (magic link) y **Google**
   (necesita OAuth client en Google Cloud Console).
4. Copiar `fooOSappweb/supabase-config.example.js` como
   `fooOSappweb/supabase-config.js` y rellenar `url` + `anonKey`
   (Project Settings → API).
5. En `fooOSappweb/index.html`, descomentar las dos lineas marcadas como
   *"Integracion Supabase"*.
6. Probar: boton **Cuenta** en la app → login → los datos se sincronizan
   (pull al iniciar sesion, push automatico con debounce al hacer cambios).

### 2. Endurecer la sincronizacion

- El push actual es *naive* (upsert de todo + borrado de lo ausente),
  suficiente para un usuario/dispositivo. Para multiusuario, pasar a
  mutaciones por accion (insert/update/delete individuales).
- Sembrar las recetas demo en la tabla `recipes` (hoy viven hardcodeadas en
  `script.js`) y publicar el feed real (`feed_posts` ya se lee, falta el push).
- Conectar Realtime de Supabase para los almacenes compartidos.

### 3. APIs externas (cada una independiente)

- **Open Food Facts** (sin clave): sustituir el boton "barcode demo" por
  `https://world.openfoodfacts.org/api/v2/product/{barcode}.json`.
- **Gemini 1.5 Flash** (Google AI Studio, gratis 1.500 req/dia): generacion
  real de recetas, foto → alimento, OCR de tickets. Las llamadas deben ir por
  un backend (API route), nunca con la key en el cliente.
- **Nordigen/GoCardless** (PSD2, free 50 usuarios): conexion bancaria.
- **Cloudinary** (free 25 GB): videos del feed.

### 4. Produccion (segun PDF, secciones 2, 14 y 16)

- Migrar a monorepo Turborepo: `apps/web` (Next.js 14) + `apps/mobile` (Expo SDK 51).
- La landing pasa a ser la ruta `/` con SSG; la app, `/dashboard` tras login.
- Animaciones con GSAP ScrollTrigger (video scrubbing del hero) + Anime.js.
- Deploy en Vercel (hobby) y push notifications con Expo + FCM.

### 5. Pendiente manual (no automatizable)

- Cuentas y claves: Supabase, Vercel, Cloudinary, Firebase FCM, Google AI
  Studio y Nordigen.
- Stores: Google Play (25 USD una vez) y Apple Developer (99 USD/año).
- Assets finales: video del hero para el scrubbing, PNG/Lottie de las 15
  mascotas (prompts ancla en la seccion 23 del PDF) y QR reales de descarga.
