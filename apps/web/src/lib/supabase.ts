import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Cliente de Supabase a partir de variables de entorno (.env.local).
// Si no estan definidas, la app funciona en modo local (localStorage)
// y getSupabase() devuelve null.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;

/**
 * Marcador de protocolo del estado de plan (C0). Se envía en X-Client-Info, la cabecera que supabase-js ya
 * incluye y que CORS ya admite (no se introduce ningún nombre de cabecera nuevo). El servidor lo lee de
 * request.headers (fn_plan_protocol_level) para distinguir clientes que declaran la base de sus objetivos
 * de los anteriores — y poder cerrar la transición de clientes antiguos con datos, no con suposiciones.
 * Sustituye el valor por defecto de supabase-js («supabase-js-web/<versión>»); el protocolo es lo único que
 * el servidor necesita de él.
 */
export const PLAN_PROTOCOL_CLIENT_INFO = "foodos-web plan-protocol/1";

export function hasSupabaseConfig(): boolean {
  return Boolean(url && anonKey && !url.includes("TU-PROYECTO"));
}

export function getSupabase(): SupabaseClient | null {
  if (!hasSupabaseConfig()) return null;
  if (!client) client = createClient(url!, anonKey!, {
    // detectSessionInUrl:false evita que el cliente auto-consuma el ?code= de PKCE
    // antes de que /auth/callback lo intercambie manualmente.
    auth: { flowType: "pkce", detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": PLAN_PROTOCOL_CLIENT_INFO } },
  });
  return client;
}
