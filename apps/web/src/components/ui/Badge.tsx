"use client";

import type { HTMLAttributes, ReactNode } from "react";

export type BadgeTone = "neutral" | "green" | "amber" | "red" | "blue" | "purple";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  children: ReactNode;
}

/** E03-14: insignia base, sobre la clase .badge ya existente (globals.css) —
    "neutral" no añade modificador de color, igual que antes. */
export function Badge({ tone = "neutral", className, children, ...rest }: BadgeProps) {
  const cls = ["badge", tone !== "neutral" && tone, className].filter(Boolean).join(" ");
  return (
    <span className={cls} {...rest}>
      {children}
    </span>
  );
}
