"use client";

import type { HTMLAttributes, ReactNode } from "react";

interface FieldProps extends HTMLAttributes<HTMLLabelElement> {
  label: ReactNode;
  /** Texto de ayuda opcional bajo la etiqueta (ej. "(opcional)") — mismo
      patrón que ya usan varios formularios con <small> dentro del <label>. */
  hint?: ReactNode;
  children: ReactNode;
}

/**
 * E03-14/E18-05: campo de formulario base — <label> envolviendo el control,
 * que es la asociación label↔input implícita que ya usa el resto de la app
 * (confirmada accesible en la auditoría de E18-05). El valor de este
 * componente es que sea IMPOSIBLE construir un input sin su label: `label`
 * es un prop requerido, no una convención que haya que recordar aplicar en
 * cada formulario nuevo.
 */
export function Field({ label, hint, className, children, ...rest }: FieldProps) {
  return (
    <label className={className} {...rest}>
      {label}
      {hint && <small>{hint}</small>}
      {children}
    </label>
  );
}
