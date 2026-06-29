"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getSupabase } from "@/lib/supabase";

function CallbackHandler() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) { router.replace("/"); return; }

    const code = searchParams.get("code");

    if (code) {
      // PKCE flow: intercambia el código por sesión, luego redirige al dashboard.
      supabase.auth.exchangeCodeForSession(code).then(({ error }) => {
        router.replace(error ? "/?error=auth" : "/dashboard");
      });
    } else {
      // Implicit flow (hash tokens): el cliente Supabase los procesa automáticamente
      // con detectSessionInUrl. Esperamos un tick para que termine y comprobamos sesión.
      supabase.auth.getSession().then(({ data }) => {
        router.replace(data.session ? "/dashboard" : "/");
      });
    }
  }, [router, searchParams]);

  return (
    <div style={STYLE}>
      <p style={{ opacity: 0.6, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase" }}>FoodOS</p>
      <p>Iniciando sesión…</p>
    </div>
  );
}

const STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100vh",
  gap: 8,
  background: "var(--bg)",
  color: "var(--text)",
};

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<div style={STYLE}><p>Cargando…</p></div>}>
      <CallbackHandler />
    </Suspense>
  );
}
