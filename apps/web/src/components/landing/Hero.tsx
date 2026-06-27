"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef } from "react";

export function Hero() {
  const imageRef = useRef<HTMLDivElement>(null);

  // Parallax suave del fondo (placeholder del video scrubbing del PDF §16.3).
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const node = imageRef.current;
    if (!node) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const progress = Math.min(1, window.scrollY / window.innerHeight);
        node.style.transform = `scale(${1 + progress * 0.12}) translateY(${progress * 36}px)`;
        ticking = false;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <section className="hero" aria-labelledby="hero-title">
      <div ref={imageRef} className="hero-media" aria-hidden="true">
        <Image
          src="/images/foodos-hero.webp"
          alt=""
          fill
          priority
          sizes="100vw"
          style={{ objectFit: "cover" }}
        />
      </div>
      <div className="hero-shade" aria-hidden="true" />
      <div className="hero-content">
        <p className="eyebrow hero-anim">Inventario · Recetas IA · Diario · Finanzas</p>
        <h1 id="hero-title" className="hero-anim">
          <span>Food</span>OS
        </h1>
        <p className="hero-copy hero-anim">
          La IA que gestiona tu despensa, optimiza tus macros y cuadra tus cuentas — todo en una sola app.
        </p>
        <div className="hero-actions hero-anim">
          <Link className="btn primary" href="/dashboard">
            Empieza gratis
          </Link>
          <a className="btn ghost" href="#como-funciona">
            Ver cómo funciona
          </a>
        </div>
        <dl className="hero-metrics hero-anim" aria-label="FoodOS en cifras">
          <div>
            <dt>3 s</dt>
            <dd>para añadir un alimento escaneando el código de barras</dd>
          </div>
          <div>
            <dt>0 €</dt>
            <dd>todas las funciones esenciales, sin coste</dd>
          </div>
          <div>
            <dt>15</dt>
            <dd>compañeros de cocina con personalidad propia</dd>
          </div>
        </dl>
      </div>
    </section>
  );
}
