# FoodOS — Roadmap de producción

## 1. Mejoras críticas (producción real)

### 1.1 Eliminación de cuenta (GDPR obligatorio)
- Botón "Eliminar mi cuenta" en Ajustes → Cuenta
- Llama a una Supabase Edge Function que ejecuta `admin.deleteUser(uid)`
- Borra también todos los datos del usuario en cascada (tablas con RLS)
- **Coste:** 0 € (Edge Functions gratis hasta 500.000 invocaciones/mes)

### 1.2 Reenvío de email de confirmación
- Si el login falla con "Email not confirmed", mostrar botón "Reenviar email"
- `supabase.auth.resend({ type: 'signup', email })`
- Implementación: 30 min

### 1.3 Error Boundaries por vista
- Si una vista lanza una excepción JS, solo esa vista rompe, no toda la app
- Componente `<ViewErrorBoundary>` con fallback de "Algo salió mal, recarga"
- Implementación: 1–2 horas

### 1.4 Real-time entre dispositivos
- Actualmente los cambios solo sincronizan al iniciar sesión
- Supabase Realtime: suscripción a cambios en las tablas del usuario
- El cliente recibe un evento y re-hidrata el estado automáticamente
- **Coste:** incluido en el plan gratuito (500 conexiones simultáneas, 2M mensajes/mes)
- Implementación: 3–5 horas

---

## 2. Imágenes de recetas personalizadas (Supabase Storage)

### Estado actual
Las recetas IA tienen imagen (URL externa), las recetas custom no tienen imagen.

### Propuesta
- Bucket `recipe-images` en Supabase Storage (público, RLS por usuario)
- Input de subida de imagen en el formulario de receta custom
- Redimensión client-side a WebP ≤ 400x300 px antes de subir
- **Capacidad gratuita:** 1 GB almacenamiento, 2 GB transferencia/mes
  - A 80 KB/imagen → ~12.500 imágenes en 1 GB
- Implementación: 4–6 horas

---

## 3. Real-time — detalle técnico

```
supabase
  .channel('user-data')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'gastos', filter: `user_id=eq.${uid}` }, () => hydrateRemote())
  .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_items', ... }, () => hydrateRemote())
  ...
  .subscribe()
```

---

## 4. Vista Ejercicios (nueva)

### Viabilidad: ALTA

### API gratuita recomendada: wger REST API
- URL: `https://wger.de/api/v2/`
- **100% gratuita y open source**, sin límites de peticiones
- Sin API key necesaria para lectura pública
- Tiene ejercicios en **español** (campo `language=6`)
- Datos disponibles:
  - Nombre, descripción, músculos trabajados (primarios y secundarios)
  - Categoría (cardio, fuerza, estiramientos, etc.)
  - Equipamiento necesario
  - Imágenes de músculos activados (SVG anatómico)
- Ejemplo: `GET https://wger.de/api/v2/exercise/?language=6&format=json`
- Alternativa self-hosted si se necesita más control

### Qué tendría la vista

#### Mis rutinas
- Crear rutinas: nombre + lista de ejercicios + series/repeticiones/descanso
- IA genera rutina según objetivo:
  - Déficit calórico → cardio + fuerza ligera
  - Volumen muscular → fuerza progresiva
  - Mantenimiento → mix equilibrado
- Registro de sesiones: fecha, duración, calorías quemadas (estimación MET)

#### Explorar ejercicios
- Búsqueda por músculo, equipamiento o categoría (desde wger API)
- Ficha de ejercicio con descripción e imagen muscular
- Añadir a rutina con un toque

#### Integración con Nutrición
- Las calorías quemadas en el entrenamiento se descuentan del déficit del día
- El TDEE se ajusta automáticamente los días de entrenamiento

---

## 5. Proyección de peso en Nutrición

### Fórmula
```
déficit_diario = TDEE - calorías_ingeridas_promedio (últimos 7 días)
kg_por_semana = (déficit_diario × 7) / 7700   // 7700 kcal ≈ 1 kg grasa
peso_en_N_dias = peso_actual - (déficit_diario × N / 7700)
```

### Qué mostraría

```
📉 Proyección de peso
───────────────────────────────────────────────
Déficit medio esta semana:   -450 kcal/día
Ritmo de pérdida:            ~0,4 kg/semana

  En 30 días  →  -1,8 kg  (aprox. XX kg)
  En 90 días  →  -5,4 kg  (aprox. XX kg)
  En 180 días →  -10,8 kg (aprox. XX kg)

✅ Ritmo saludable (< 0,5 kg/semana recomendado)

Recomendaciones para llegar antes:
  · Añade 20 min de cardio 3×/semana (+200 kcal/día)
  · Aumenta proteína a 2g/kg para preservar músculo
  · Bebe al menos 2,5 L de agua al día
```

### Advertencias automáticas
- Déficit > 1000 kcal/día → aviso de ritmo agresivo
- Peso objetivo ya alcanzado → felicitación + modo mantenimiento
- Sin datos suficientes (< 3 días de registro) → no se muestra la proyección

### Integración con Ejercicios
- Si el usuario tiene rutinas registradas, el déficit real incluye calorías quemadas
- Proyección más precisa: `déficit = TDEE + kcal_ejercicio - kcal_ingeridas`

---

## 6. PWA offline real

### Estado actual
`manifest.json` existe pero no hay Service Worker. Sin conexión → pantalla en blanco.

### Propuesta
- Next.js + `next-pwa` (Workbox): caché de assets y páginas estáticas
- Modo offline: muestra datos locales del último estado guardado
- Banner "Sin conexión — mostrando datos guardados"
- **Coste:** 0 €, solo dependencia de desarrollo

---

## 7. Notificaciones de caducidad

### Propuesta
- Al cargar la app, registrar una notificación programada via Web Notifications API
- Notificar a las 9:00 si hay items que caducan en los próximos N días (según ajuste del usuario)
- Requiere permiso del usuario (`Notification.requestPermission()`)
- Con Service Worker: notifica aunque la app esté cerrada
- **Coste:** 0 €

---

## Resumen de costes

| Mejora                        | Coste económico | Tiempo estimado |
|-------------------------------|-----------------|-----------------|
| Error Boundaries              | 0 €             | 2 h             |
| Reenvío email confirmación    | 0 €             | 30 min          |
| Eliminación de cuenta (GDPR)  | 0 €             | 3 h             |
| Real-time Supabase            | 0 €             | 4 h             |
| Imágenes recetas (Storage)    | 0 €             | 5 h             |
| Vista Ejercicios + wger API   | 0 €             | 10–15 h         |
| Proyección de peso            | 0 €             | 4 h             |
| PWA offline real              | 0 €             | 3 h             |
| Notificaciones caducidad      | 0 €             | 5 h             |

Todo es gratuito dentro de los límites de Supabase free tier.
