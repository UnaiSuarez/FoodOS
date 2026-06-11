"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export function SiteHeader() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header className={`site-header ${scrolled ? "scrolled" : ""}`}>
      <Link className="brand" href="/" aria-label="FoodOS inicio">
        <span>Food</span>OS
      </Link>
      <nav className="site-nav" aria-label="Secciones principales">
        <a href="#producto">Producto</a>
        <a href="#como-funciona">Cómo funciona</a>
        <a href="#mascotas">Compañeros</a>
        <a href="#descarga">Descargar</a>
      </nav>
      <div className="header-actions">
        <a className="header-link" href="#login">
          Iniciar sesión
        </a>
        <Link className="header-cta" href="/dashboard">
          Empieza gratis
        </Link>
      </div>
    </header>
  );
}
