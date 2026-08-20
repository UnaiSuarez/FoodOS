"use client";

import type { HTMLAttributes, ReactNode } from "react";

interface CardProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  /** Título opcional, renderizado como <h2> dentro del <article> — cubre el
      patrón repetido `<article className="panel"><h2>...</h2>...</article>`
      sin forzarlo cuando la vista ya trae su propia cabecera (panel-head). */
  title?: string;
}

/** E03-14: tarjeta base, sobre la clase .panel ya existente. */
export function Card({ title, className, children, ...rest }: CardProps) {
  const cls = ["panel", className].filter(Boolean).join(" ");
  return (
    <article className={cls} {...rest}>
      {title && <h2>{title}</h2>}
      {children}
    </article>
  );
}
