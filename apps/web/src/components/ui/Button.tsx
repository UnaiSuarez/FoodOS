"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "text" | "danger";

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  children: ReactNode;
  /** Clases extra, para casos puntuales (ej. un modificador de tamaño ya
      existente en dashboard.css) — no reemplaza la clase del variant. */
  className?: string;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "primary-button",
  secondary: "secondary-button",
  text: "text-button",
  danger: "danger-button",
};

/**
 * E03-14: componente base de botón — envuelve las clases ya existentes en
 * dashboard.css (primary-button/secondary-button/text-button/danger-button)
 * en vez de reinventar estilos, para no arriesgar una migración visual. El
 * valor real es dar una API de componente única (en vez de que cada vista
 * escriba `<button className="primary-button" type="button">` suelto) y
 * fijar `type="button"` por defecto — evita el bug clásico de un botón
 * dentro de un <form> que sin querer hace submit al pulsarlo.
 */
export function Button({ variant = "secondary", type = "button", className, children, ...rest }: ButtonProps) {
  const cls = [VARIANT_CLASS[variant], className].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}
