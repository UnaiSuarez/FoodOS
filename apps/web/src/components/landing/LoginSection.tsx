"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { getSupabase, hasSupabaseConfig } from "@/lib/supabase";
import { Reveal } from "./Reveal";

type Mode = "register" | "login";

export function LoginSection() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");

  const supabaseReady = hasSupabaseConfig();

  async function handleGoogle() {
    if (!supabaseReady) { void router.push("/dashboard"); return; }
    const sb = getSupabase()!;
    await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/dashboard` },
    });
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!supabaseReady) { void router.push("/dashboard"); return; }
    setLoading(true);
    setError("");
    setNote("");
    const sb = getSupabase()!;

    if (mode === "register") {
      const { error: err } = await sb.auth.signUp({ email, password });
      if (err) {
        setError(translateError(err.message));
      } else {
        setNote(`Cuenta creada. Revisa ${email} para confirmarla y luego inicia sesión.`);
      }
    } else {
      const { error: err } = await sb.auth.signInWithPassword({ email, password });
      if (err) {
        setError(translateError(err.message));
      } else {
        void router.push("/dashboard");
      }
    }
    setLoading(false);
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

          <form className="login-form" onSubmit={handleSubmit}>
            <button className="btn ghost google" type="button" onClick={handleGoogle}>
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" style={{ flexShrink: 0 }}>
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
              </svg>
              Continuar con Google
            </button>

            <div className="login-divider"><span>o con email</span></div>

            {/* Tabs */}
            <div className="login-tabs">
              <button
                type="button"
                className={`login-tab ${mode === "register" ? "active" : ""}`}
                onClick={() => { setMode("register"); setError(""); setNote(""); }}
              >
                Crear cuenta
              </button>
              <button
                type="button"
                className={`login-tab ${mode === "login" ? "active" : ""}`}
                onClick={() => { setMode("login"); setError(""); setNote(""); }}
              >
                Iniciar sesión
              </button>
            </div>

            <label>
              Email
              <input
                type="email"
                required
                placeholder="tu@email.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Contraseña
              <input
                type="password"
                required
                minLength={6}
                placeholder={mode === "register" ? "Mínimo 6 caracteres" : "Tu contraseña"}
                autoComplete={mode === "register" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>

            {error && <p className="login-error">{error}</p>}
            {note  && <p className="login-note">{note}</p>}

            <button className="btn primary" type="submit" disabled={loading}>
              {loading ? "Cargando…" : mode === "register" ? "Crear cuenta gratis" : "Entrar"}
            </button>

            <p className="login-note">Sin tarjeta. Sin permanencia. Tus datos son tuyos.</p>
          </form>
        </div>
      </Reveal>
    </section>
  );
}

function translateError(msg: string): string {
  if (msg.includes("Invalid login credentials")) return "Email o contraseña incorrectos.";
  if (msg.includes("Email not confirmed")) return "Confirma tu email antes de entrar (revisa tu bandeja).";
  if (msg.includes("User already registered")) return "Ya existe una cuenta con este email. Inicia sesión.";
  if (msg.includes("Password should be at least")) return "La contraseña debe tener al menos 6 caracteres.";
  if (msg.includes("rate limit")) return "Demasiados intentos. Espera unos minutos.";
  return msg;
}
