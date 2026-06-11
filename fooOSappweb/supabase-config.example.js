// FoodOS — Configuracion de Supabase (plantilla).
//
// PASOS PARA ACTIVAR LA BASE DE DATOS REAL:
//   1. Crea un proyecto en https://supabase.com (plan free).
//   2. En el SQL Editor de Supabase ejecuta `supabase/schema.sql`.
//   3. Copia este archivo como `supabase-config.js` (mismo directorio).
//   4. Rellena url y anonKey desde Supabase > Project Settings > API.
//   5. En `index.html` descomenta las dos lineas marcadas con
//      "Integracion Supabase" (CDN de supabase-js y este config).
//
// La anon key es publica por diseño: la seguridad real la dan las
// politicas RLS que ya estan definidas en schema.sql.
// NUNCA pongas aqui la service_role key.

window.FOODOS_SUPABASE = {
  url: "https://TU-PROYECTO.supabase.co",
  anonKey: "TU_ANON_KEY_PUBLICA",
};
