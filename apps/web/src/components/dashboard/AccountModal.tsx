"use client";

import { useState, type FormEvent } from "react";
import { remote } from "@/lib/data-layer";
import { useFoodOS } from "@/lib/state";
import { Modal } from "./Modal";

type Mode = "login" | "register" | "forgot";

export function AccountModal({ onClose }: { onClose: () => void }) {
  const { remoteReady, authUser, showToast } = useFoodOS();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  function reset() {
    setError("");
    setSent(false);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    if (mode === "register") {
      const { error: err } = await remote.signUpWithPassword(email, password);
      if (err) {
        setError(translateError(err.message));
      } else {
        showToast("Cuenta creada. Revisa tu correo para confirmarla.");
        onClose();
      }
    } else if (mode === "login") {
      const { error: err } = await remote.signInWithPassword(email, password);
      if (err) {
        setError(translateError(err.message));
      } else {
        showToast("Sesión iniciada.");
        onClose();
      }
    } else {
      const { error: err } = await remote.resetPassword(email);
      if (err) {
        setError(translateError(err.message));
      } else {
        setSent(true);
      }
    }
    setLoading(false);
  }

  // ── Sin Supabase configurado ──
  if (!remoteReady) {
    return (
      <Modal title="Cuenta FoodOS" onClose={onClose}>
        <p>
          La base de datos todavía no está conectada. Tus datos viven en este navegador
          (localStorage) y puedes llevártelos con el botón de exportar.
        </p>
        <p>Para activar cuentas y sincronización:</p>
        <ol className="recipe-steps-list">
          <li><span className="step-num">1</span><span>Crea un proyecto gratuito en supabase.com y ejecuta <code>supabase/schema.sql</code>.</span></li>
          <li><span className="step-num">2</span><span>Copia <code>apps/web/.env.local.example</code> como <code>.env.local</code> con tus claves.</span></li>
          <li><span className="step-num">3</span><span>Reinicia el servidor de desarrollo.</span></li>
        </ol>
      </Modal>
    );
  }

  // ── Sesión activa ──
  if (authUser) {
    return (
      <Modal title="Mi cuenta" onClose={onClose}>
        <p>Conectado como <strong>{authUser.email ?? authUser.id}</strong>.</p>
        <p style={{ color: "var(--muted)", fontSize: 13 }}>
          Tus cambios se guardan localmente y se sincronizan con Supabase de forma automática.
        </p>
        <div className="recipe-detail-actions" style={{ marginTop: 20 }}>
          <button
            className="secondary-button"
            onClick={async () => {
              await remote.signOut();
              onClose();
              showToast("Sesión cerrada. Sigues en modo local.");
            }}
          >
            Cerrar sesión
          </button>
        </div>
      </Modal>
    );
  }

  // ── Recuperar contraseña ──
  if (mode === "forgot") {
    return (
      <Modal title="Recuperar contraseña" onClose={onClose}>
        {sent ? (
          <>
            <p>Enlace enviado a <strong>{email}</strong>. Revisa tu correo.</p>
            <button className="secondary-button" style={{ marginTop: 12 }} onClick={() => { reset(); setMode("login"); }}>
              Volver al inicio de sesión
            </button>
          </>
        ) : (
          <form className="account-form" onSubmit={handleSubmit}>
            <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 16 }}>
              Te enviamos un enlace para restablecer tu contraseña.
            </p>
            <label className="account-label">
              Email
              <input type="email" required placeholder="tu@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="primary-button" type="submit" disabled={loading}>
              {loading ? "Enviando…" : "Enviar enlace"}
            </button>
            <button type="button" className="account-link" onClick={() => { reset(); setMode("login"); }}>
              Volver al inicio de sesión
            </button>
          </form>
        )}
      </Modal>
    );
  }

  // ── Login / Registro ──
  const isRegister = mode === "register";
  return (
    <Modal title={isRegister ? "Crear cuenta" : "Iniciar sesión"} onClose={onClose}>
      {/* Google */}
      <button className="account-google-btn" onClick={() => void remote.signInWithGoogle()}>
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        Continuar con Google
      </button>

      <div className="account-divider"><span>o con email</span></div>

      {/* Tabs login / registro */}
      <div className="account-tabs">
        <button
          className={`account-tab ${!isRegister ? "active" : ""}`}
          onClick={() => { reset(); setMode("login"); }}
        >
          Iniciar sesión
        </button>
        <button
          className={`account-tab ${isRegister ? "active" : ""}`}
          onClick={() => { reset(); setMode("register"); }}
        >
          Crear cuenta
        </button>
      </div>

      <form className="account-form" onSubmit={handleSubmit}>
        <label className="account-label">
          Email
          <input
            type="email"
            required
            placeholder="tu@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="account-label">
          Contraseña
          <input
            type="password"
            required
            minLength={6}
            placeholder={isRegister ? "Mínimo 6 caracteres" : "Tu contraseña"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <p className="form-error">{error}</p>}

        <button className="primary-button" type="submit" disabled={loading}>
          {loading ? "Cargando…" : isRegister ? "Crear cuenta" : "Entrar"}
        </button>

        {!isRegister && (
          <button type="button" className="account-link" onClick={() => { reset(); setMode("forgot"); }}>
            ¿Olvidaste tu contraseña?
          </button>
        )}
      </form>
    </Modal>
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
