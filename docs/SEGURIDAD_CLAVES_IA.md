# Almacenamiento de claves de IA — riesgos y mitigaciones (E15-02)

FoodOS deja que cada usuario conecte su propia clave de API (Gemini, OpenAI
o Anthropic) o apunte a un servidor Ollama propio. Este documento recoge
dónde vive esa clave, qué riesgo real implica y qué mitigaciones existen —
para no depender de la memoria de quien lo lea la próxima vez.

## Dónde vive la clave

- **Solo en `localStorage` del navegador**, bajo la clave interna que usa
  `apps/web/src/lib/ai-config.ts`. Nunca se envía a ningún servidor de
  FoodOS (ni a las rutas `/api/*` propias, ni a Supabase) — confirmado por
  grep: ningún endpoint propio recibe `apiKey` como parámetro.
- Las peticiones que sí usan la clave (`ai-provider.ts`, `ai-inventory.ts`)
  la mandan **directamente desde el navegador** al proveedor elegido
  (`generativelanguage.googleapis.com`, `api.openai.com`,
  `api.anthropic.com`) o al Ollama que el usuario configure.
- La clave nunca se registra en consola (auditado en PR de Fase 0 — ver
  `docs/BACKLOG.md`, E20-04) ni se persiste en Supabase.

## Riesgos reales

1. **XSS**: si un atacante consigue ejecutar JavaScript arbitrario en la
   página, puede leer `localStorage` y robar la clave. Es el riesgo
   principal — mitigado (no eliminado) por la CSP de E15-03/E20-03, que
   restringe qué scripts pueden ejecutarse y a qué dominios puede
   conectarse la página.
2. **Ordenador compartido / público**: `localStorage` persiste entre
   sesiones del mismo navegador. Quien use FoodOS en un equipo compartido y
   configure su clave ahí la deja disponible para el siguiente usuario del
   mismo navegador/perfil.
3. **Extensiones de navegador maliciosas**: cualquier extensión con acceso
   al DOM de la página puede leer `localStorage`, igual que con XSS. No es
   algo que FoodOS pueda mitigar desde el código de la app.
4. **La clave viaja al proveedor de IA elegido** — no es un riesgo de
   FoodOS en sí, pero el usuario debe confiar en la política de privacidad
   de Google/OpenAI/Anthropic (o de su propio Ollama) igual que con
   cualquier integración de terceros. El texto de `AIConfigModal.tsx` ya lo
   deja explícito (ver E15-01).

## Mitigaciones ya aplicadas

- CSP (`middleware.ts`) con `connect-src` acotado a los proveedores reales
  — un script inyectado no puede exfiltrar la clave a un dominio arbitrario
  aunque consiga leerla.
- Texto de privacidad corregido para no minimizar que la clave sale del
  dispositivo (E15-01).
- Auditoría de que ningún log ni ruta propia expone la clave (E15 avanzado
  como parte de E20-04).

## Riesgo residual aceptado (por ahora)

No hay cifrado adicional de la clave dentro de `localStorage` — se guarda
en texto plano, como la inmensa mayoría de apps de este tipo que no operan
su propio backend de IA. Cifrarla en el cliente no añadiría seguridad real
frente a XSS (la clave de descifrado tendría que vivir en el mismo sitio
accesible), así que no se ha implementado.

## Alternativa descartada por ahora: proxy propio

E15-19 del backlog ("Proxy seguro opcional") propone que FoodOS ofrezca un
servidor intermedio que guarde la clave y jamás la exponga al navegador.
Queda fuera de esta entrega a propósito: para un proyecto personal sin
usuarios más allá de quien lo despliega, añadir y mantener un backend con
sus propias claves de servicio, límites de coste y superficie de ataque
adicional no compensa el riesgo que mitiga. Revisar esta decisión si
FoodOS pasa a tener usuarios más allá del propio desarrollador.
