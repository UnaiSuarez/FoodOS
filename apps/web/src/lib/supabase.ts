import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Cliente de Supabase a partir de variables de entorno (.env.local).
// Si no estan definidas, la app funciona en modo local (localStorage)
// y getSupabase() devuelve null.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;

export function hasSupabaseConfig(): boolean {
  return Boolean(url && anonKey && !url.includes("TU-PROYECTO"));
}

export function getSupabase(): SupabaseClient | null {
  if (!hasSupabaseConfig()) return null;
  if (!client) client = createClient(url!, anonKey!, {
    // detectSessionInUrl:false evita que el cliente auto-consuma el ?code= de PKCE
    // antes de que /auth/callback lo intercambie manualmente.
    auth: { flowType: "pkce", detectSessionInUrl: false },
  });
  return client;
}
