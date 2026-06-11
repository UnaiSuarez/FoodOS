"use client";

import { useState, type FormEvent } from "react";
import { remote } from "@/lib/data-layer";
import { useFoodOS } from "@/lib/state";
import { Modal } from "./Modal";

export function AccountModal({ onClose }: { onClose: () => void }) {
  const { remoteReady, authUser, showToast } = useFoodOS();
  const [email, setEmail] = useState("");

  async function sendMagicLink(event: FormEvent) {
    event.preventDefault();
    const { error } = await remote.signInWithMagicLink(email);
    showToast(error ? `Error: ${error.message}` : "Enlace enviado. Revisa tu correo.");
    if (!error) onClose();
  }

  if (!remoteReady) {
    return (
      <Modal title="Cuenta FoodOS" onClose={onClose}>
        <p>
          La base de datos todavía no está conectada. Tus datos viven en este navegador
          (localStorage) y puedes llevártelos con el botón de exportar.
        </p>
        <p>Para activar cuentas y sincronización:</p>
        <ol className="recipe-steps-list">
          <li>
            <span className="step-num">1</span>
            <span>
              Crea un proyecto gratuito en supabase.com y ejecuta <code>supabase/schema.sql</code>.
            </span>
          </li>
          <li>
            <span className="step-num">2</span>
            <span>
              Copia <code>apps/web/.env.local.example</code> como <code>.env.local</code> con tus claves.
            </span>
          </li>
          <li>
            <span className="step-num">3</span>
            <span>Reinicia el servidor de desarrollo.</span>
          </li>
        </ol>
        <p>Los pasos completos están en el README del proyecto.</p>
      </Modal>
    );
  }

  if (authUser) {
    return (
      <Modal title="Cuenta FoodOS" onClose={onClose}>
        <p>
          Sesión iniciada como <strong>{authUser.email ?? authUser.id}</strong>.
        </p>
        <p>Tus cambios se guardan en local y se sincronizan con Supabase automáticamente.</p>
        <div className="recipe-detail-actions">
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

  return (
    <Modal title="Iniciar sesión" onClose={onClose}>
      <p>Conecta tu cuenta para sincronizar inventario, recetas y finanzas entre dispositivos.</p>
      <div className="recipe-detail-actions">
        <button className="primary-button" onClick={() => void remote.signInWithGoogle()}>
          Continuar con Google
        </button>
      </div>
      <p style={{ marginTop: 16 }}>O recibe un enlace mágico por email:</p>
      <form className="inline-form" onSubmit={sendMagicLink}>
        <input
          type="email"
          required
          placeholder="tu@email.com"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <button className="small-action good" type="submit">
          Enviar enlace
        </button>
      </form>
    </Modal>
  );
}
