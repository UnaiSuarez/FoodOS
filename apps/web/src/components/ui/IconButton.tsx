"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "aria-label"> {
  children: ReactNode;
  /** Obligatorio a propósito (no opcional): un botón de solo icono sin
      aria-label no tiene nombre accesible — este componente no permite
      construir ese estado, en vez de confiar en que cada sitio se acuerde
      (E18-04, "Añadir nombres accesibles a iconos"). */
  "aria-label": string;
  danger?: boolean;
  className?: string;
}

/** E03-14/E18-04: botón de solo icono, sobre la clase .icon-button ya
    existente. aria-label es un prop requerido por el tipo, no una
    convención de comentario. */
export function IconButton({ danger, className, children, ...rest }: IconButtonProps) {
  const cls = ["icon-button", danger && "danger", className].filter(Boolean).join(" ");
  return (
    <button type="button" className={cls} {...rest}>
      {children}
    </button>
  );
}
