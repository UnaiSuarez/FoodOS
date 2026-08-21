# Checklist manual de release — E21-21 (P2)

Comprobación manual antes de mandar a producción lo que la suite automática (`npm run test`, `npm run test:e2e`, CI) no cubre: dispositivos reales, cuentas reales de Supabase, service worker instalado, y flujos de varios pasos que dependen de percepción humana (¿se ve bien?, ¿se siente lento?) más que de aserciones exactas.

No sustituye a `tsc --noEmit` / `vitest run` / `playwright test` — se hace **después** de que los tres pasen en CI, como último filtro antes de mergear a `main` o de desplegar.

## Cómo usarlo

Copia esta lista a un comentario de PR o a un documento aparte por release, marca cada punto, y anota cualquier hallazgo con el ticket correspondiente del [`BACKLOG.md`](./BACKLOG.md). Si algo falla, no se despliega hasta corregirlo o decidir explícitamente aplazarlo.

---

## 1. Autenticación (`AccountModal.tsx`, `LoginSection.tsx`, `/auth/callback`)

- [ ] Registro con email/contraseña crea la cuenta y deja sesión iniciada.
- [ ] Login con email/contraseña funciona con credenciales correctas y muestra un error claro con incorrectas (no un error genérico o silencioso).
- [ ] Login con OAuth (si está activo) completa el flujo y vuelve a `/auth/callback` sin quedarse colgado.
- [ ] Cerrar sesión vuelve al estado sin cuenta y dashboard sigue usable en local-only.
- [ ] Recuperar contraseña (si aplica) envía el correo y el enlace funciona.
- [ ] Sin sesión, la app funciona igual (modo local-only, ver `useFoodOS().authUser === null`) — no debe bloquear ninguna función básica.

## 2. Sincronización (`data-layer.ts`, `state.tsx` — `remote.schedulePush`, `remoteReady`, `realtimeConnected`)

- [ ] Con sesión activa, un cambio (añadir alimento, registrar comida, gasto) se refleja en la cabecera como "Sincronizando…" y luego "Guardado en la nube" — no se queda en "Sincronizando" indefinidamente.
- [ ] Cerrar y reabrir la app (o recargar) con sesión activa recupera los datos desde Supabase, no solo desde `localStorage`.
- [ ] Con dos pestañas/dispositivos con la misma cuenta abiertos a la vez, un cambio en uno aparece en el otro sin recargar manualmente (realtime) — o al menos tras recargar, sin perder el cambio de ninguno de los dos. *(Ver [[e21-14-pendiente]] — sesiones simultáneas de verdad, aplazado a checklist manual porque no hay backend real de Supabase en CI.)*
- [ ] Cortar la red a mitad de una escritura (DevTools → offline) no corrompe el estado local; al reconectar, sincroniza sin duplicar ni perder la entrada.
- [ ] El indicador de error de sincronización (`SyncStatusBadge`) aparece si Supabase da un error real (p. ej. clave de API inválida en `.env.local`), y no se queda en un estado ambiguo.

## 3. Móvil (viewport real, no solo DevTools)

- [ ] Probado en al menos un dispositivo iOS real (Safari) y uno Android real (Chrome) — DevTools emula el viewport pero no gestos, teclado nativo ni Safari-specific bugs.
- [ ] La barra de tabs inferior no tapa contenido interactivo (botones "Guardar", inputs) al abrir el teclado virtual.
- [ ] Los modales son usables con una mano — botones de cerrar/confirmar alcanzables sin estirar el pulgar.
- [ ] Cámara (escaneo de código de barras, registrar comida por foto) pide permiso correctamente y funciona con la cámara trasera.
- [ ] Rotar el dispositivo (portrait ↔ landscape) no rompe el layout ni pierde el estado de un formulario a medias.
- [ ] Gestos de scroll dentro de modales/listas largas no hacen scroll de la página de fondo (bloqueado por `use-inert-background.ts`, pero verificar en dispositivo real).

## 4. PWA (`public/manifest.json`, `public/sw.js`)

- [ ] "Instalar aplicación" aparece en Chrome/Edge de escritorio y funciona.
- [ ] En iOS Safari, "Compartir → Añadir a pantalla de inicio" instala un icono funcional (iOS no soporta el prompt nativo de instalación).
- [ ] La app instalada abre en modo standalone (sin barra de navegador), con el icono y nombre correctos.
- [ ] Con la app instalada y sin red, abrir la app muestra contenido (aunque sea desde caché/local-only) en vez de una pantalla en blanco o el error offline del navegador.
- [ ] Los accesos directos del manifest (`shortcuts`) funcionan desde el icono (long-press en Android, right-click en escritorio).
- [ ] Actualizar el `sw.js` (nuevo deploy) no dejar a usuarios con una versión vieja cacheada indefinidamente — verificar que el nuevo SW se activa tras recargar.

## 5. IA (`ai-provider.ts` — `generateAIRoutine`, recetas con IA, clave personal en Ajustes)

- [ ] "Conectar IA personal" guarda la clave de API y las llamadas subsiguientes la usan (verificar en Network que no se manda a un endpoint propio con la clave del servidor).
- [ ] Generar una rutina de ejercicio con IA da un resultado completo y coherente, no una respuesta truncada o con campos vacíos.
- [ ] Generar una receta con IA respeta macros/inventario/presupuesto declarados, no ingredientes inventados sin relación.
- [ ] Un error de la API de IA (clave inválida, cuota agotada, timeout) muestra un mensaje claro al usuario, no un fallo silencioso ni una pantalla rota.
- [ ] Sin clave de IA configurada, las funciones de IA están claramente desactivadas/ocultas, no dan un error confuso al intentar usarlas.
- [ ] El rate limiter (`fix/persist-ai-rate-limiter`) sigue aplicando el límite tras recargar la página, no solo en memoria de la sesión.

## 6. Borrado de datos (`SettingsView.tsx` — "Zona de peligro")

- [ ] "Borrar datos de este dispositivo" (con sesión activa) borra solo `localStorage`, no la cuenta ni los datos en Supabase — verificar que tras recargar, los datos vuelven desde la nube.
- [ ] "Borrar todos los datos" (sin sesión) borra de verdad todo el estado local y vuelve al onboarding o a un estado limpio, no a un estado a medias.
- [ ] "Eliminar cuenta permanentemente" borra la cuenta de Supabase (auth + datos asociados) y no dejar sesión "zombie" que siga funcionando tras el borrado.
- [ ] Tras eliminar la cuenta, intentar iniciar sesión con las mismas credenciales falla como se espera (la cuenta ya no existe).
- [ ] Ambas acciones piden confirmación explícita (no un solo click) y explican qué se borra, dado que son irreversibles.

---

## Notas

- Este checklist no cubre rendimiento (Lighthouse, Core Web Vitals) ni SEO — fuera del alcance de E21-21, valorar un ticket aparte si hace falta.
- Las comprobaciones de sincronización y borrado de cuenta requieren un proyecto de Supabase real (no el `.env.local.disabled` usado para tests con datos locales) — usar un proyecto de pruebas dedicado, nunca datos de usuarios reales.
- Si se automatiza alguno de estos puntos en el futuro (p. ej. con un backend de Supabase de pruebas en CI), muévelo de aquí a la suite de Playwright y bórralo de esta lista.
