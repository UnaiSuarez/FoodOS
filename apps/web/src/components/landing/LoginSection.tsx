"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { getSupabase, hasSupabaseConfig } from "@/lib/supabase";
import { Reveal } from "./Reveal";

export function LoginSection() {
  const router = useRouter();
  const [note, setNote] = useState("Sin tarjeta. Sin permanencia. Tus datos son tuyos.");
  const [email, setEmail] = useState("");

  const supabaseReady = hasSupabaseConfig();

  async function handleGoogle() {
    if (!supabaseReady) {
      router.push("/dashboard");
      return;
    }
    const supabase = getSupabase()!;
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/dashboard` },
    });
  }

  async function handleMagicLink(event: FormEvent) {
    event.preventDefault();
    if (!supabaseReady) {
      router.push("/dashboard");
      return;
    }
    const supabase = getSupabase()!;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/dashboard` },
    });
    setNote(error ? `Error: ${error.message}` : `Enlace enviado a ${email}. Revisa tu correo.`);
  }

  return (
    <section id="login" className="section login" aria-labelledby="login-title">
      <Reveal>
        <div className="login-card">
          <div>
            <p className="eyebrow">Empieza hoy</p>
            <h2 id="login-title">
              Tu cocina, organizada <em>en 2 minutos.</em>
            </h2>
            <p className="section-sub">
              Crea tu cuenta, escanea tus primeros alimentos y deja que FoodOS conecte tu
              inventario con tus objetivos y tu presupuesto.
            </p>
          </div>
          <form className="login-form" onSubmit={handleMagicLink}>
            <button className="btn ghost google" type="button" onClick={handleGoogle}>
              <span aria-hidden="true">G</span> Continuar con Google
            </button>
            <div className="login-divider">
              <span>o con tu email</span>
            </div>
            <label>
              Email
              <input
                type="email"
                name="email"
                required
                placeholder="tu@email.com"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <button className="btn primary" type="submit">
              Crear cuenta gratis
            </button>
            <p className="login-note">{note}</p>
          </form>
        </div>
      </Reveal>
    </section>
  );
}
