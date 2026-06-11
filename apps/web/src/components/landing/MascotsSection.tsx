"use client";

import Image from "next/image";
import { useState } from "react";
import { MASCOTS } from "@/lib/mascots";
import { Reveal } from "./Reveal";

export function MascotsSection() {
  const [activeId, setActiveId] = useState("zana");
  const active = MASCOTS.find((mascot) => mascot.id === activeId) ?? MASCOTS[0];

  return (
    <section id="mascotas" className="section mascots" aria-labelledby="mascots-title">
      <div className="section-heading center">
        <p className="eyebrow">Tu compañero</p>
        <h2 id="mascots-title">
          15 personalidades. <em>Elige la tuya.</em>
        </h2>
        <p className="section-sub">
          Tu mascota celebra tus logros, te avisa de lo que caduca y te anima a cerrar tus macros.
          No es un asistente genérico: es tu compañero de cocina.
        </p>
      </div>
      <Reveal>
        <div className="mascot-grid" role="list" aria-label="Mascotas de FoodOS">
          {MASCOTS.map((mascot) => (
            <button
              key={mascot.id}
              type="button"
              role="listitem"
              className={`mascot ${mascot.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(mascot.id)}
              aria-pressed={mascot.id === activeId}
            >
              <span className="mascot-portrait">
                <Image src={mascot.image} alt={mascot.name} width={150} height={170} />
              </span>
              <b>{mascot.name}</b>
            </button>
          ))}
        </div>
      </Reveal>
      <p className="mascot-caption" aria-live="polite">
        {active.name} — {active.tagline}
      </p>
    </section>
  );
}
