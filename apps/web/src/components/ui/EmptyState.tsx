"use client";

import type { ReactNode } from "react";

interface EmptyStateProps {
  children: ReactNode;
  /** Acción opcional (normalmente un <Button variant="text"> o un enlace)
      para que el estado vacío explique qué hacer a continuación, no solo
      que está vacío — ver E05-09/E23-08. */
  action?: ReactNode;
  className?: string;
}

/** E03-14: estado vacío base, sobre la clase .empty ya existente. */
export function EmptyState({ children, action, className }: EmptyStateProps) {
  const cls = ["empty", className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <p>{children}</p>
      {action}
    </div>
  );
}
