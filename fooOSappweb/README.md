# fooOSappweb

App web funcional de FoodOS. Hoy guarda todo en `localStorage`; la integracion
con Supabase ya esta preparada y se activa rellenando la configuracion (abajo).

## Abrir

Con el servidor de la carpeta `FoodOScodex`:

```text
http://localhost:4177/fooOSappweb/
```

Tambien puedes abrir `index.html` directamente.

## Arquitectura de datos

```text
script.js          → logica de la app; lee/escribe estado via FoodOSData
data-layer.js      → window.FoodOSData: adaptador local (localStorage)
                     + adaptador remoto (Supabase) con auth, pullState y pushState
supabase-config.example.js → plantilla de claves (copiar como supabase-config.js)
supabase/schema.sql        → esquema completo: 24 tablas + RLS + triggers
docs/data-model.md         → mapeo estado mock ↔ tablas reales
```

- `FoodOSData.persist(state)` guarda **siempre** en localStorage; si hay sesion
  de Supabase ademas programa un push remoto con debounce (1,8 s).
- Al iniciar sesion se hace `pullState()`: lee las tablas y reconstruye el
  estado con la misma forma que usa la app.
- Sin configuracion, la app funciona 100% local: el boton **Cuenta** explica
  los pasos para conectar.

## Conectar la base de datos (paso a paso)

1. Crea un proyecto free en supabase.com.
2. SQL Editor → ejecuta `supabase/schema.sql`.
3. Authentication → Providers → activa **Email** y (opcional) **Google**.
4. Copia `supabase-config.example.js` como `supabase-config.js` y rellena
   `url` y `anonKey` (Project Settings → API). La anon key es publica; la
   seguridad la dan las politicas RLS del esquema.
5. En `index.html` descomenta las dos lineas del bloque
   *"Integracion Supabase"* (CDN de supabase-js y supabase-config.js).
6. Recarga la app → **Cuenta** → entra con Google o enlace magico.

Que cubre ya el adaptador (`data-layer.js`):

- Auth: Google OAuth, magic link, sesion persistente, sign out.
- Bootstrap por usuario: perfil, almacenes Nevera/Congelador/Despensa
  (+ membresia para cumplir las policies) y lista de compra activa.
- Pull: inventario, carrito, gastos, ingresos, objetivo nutricional,
  food log de hoy, presupuesto, mascota y feed publico.
- Push (debounce): perfil, objetivo, inventario, carrito, gastos, ingresos
  y food log de hoy.

TODOs documentados en el codigo:

- Push del feed (necesita sembrar `recipes` primero).
- Mutaciones por accion en lugar de sync completo (multiusuario).
- Likes/comentarios por usuario (`feed_post_likes`, `recipe_saves`).

## Funciones incluidas

- Dashboard con alertas, macros, presupuesto semanal (ventana real de 7 dias)
  y sugerencia diaria.
- Inventario con caducidades, consumo, busqueda, filtros por almacen,
  barcode demo y foto IA demo.
- Recetas con imagenes, semaforo de disponibilidad, tags, modal de detalle y
  recetas IA locales **persistentes** entre recargas.
- Feed social con likes, comentarios y guardado real de recetas (toggle).
- Carrito con resumen, marcado, mover a despensa y compra → finanzas + inventario.
- Finanzas con balance, grafico semanal, desglose por categoria y presupuesto.
- Nutricion con objetivos, comidas del dia y borrado individual.
- Asistente con insights mock (ticket OCR, banco, plan semanal, proteina/EUR).
- Selector de 15 mascotas, exportar/importar datos JSON, boton Cuenta.

## Pendiente manual

- Crear el proyecto Supabase y las claves (pasos arriba).
- Open Food Facts para barcode real, Gemini para IA real (via backend),
  Cloudinary para video, Nordigen para banco. Ver README raiz, paso 3.
- PNG/Lottie finales de las 14 mascotas restantes (Zana ya tiene PNG).
