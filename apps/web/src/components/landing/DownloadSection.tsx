"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { Reveal } from "./Reveal";

// QR conceptual dibujado celda a celda desde el centro.
// Cuando la app este en stores, se sustituye por el QR real.
function drawQr(canvas: HTMLCanvasElement, animate: boolean) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const cells = 21;
  const size = canvas.width / cells;

  const cellOn = (col: number, row: number): boolean => {
    const finder = (x: number, y: number) => col >= x && col < x + 7 && row >= y && row < y + 7;
    if (finder(0, 0) || finder(cells - 7, 0) || finder(0, cells - 7)) {
      const local = (x: number, y: number) => {
        const cx = col - x;
        const cy = row - y;
        return cx === 0 || cx === 6 || cy === 0 || cy === 6 || (cx >= 2 && cx <= 4 && cy >= 2 && cy <= 4);
      };
      if (finder(0, 0)) return local(0, 0);
      if (finder(cells - 7, 0)) return local(cells - 7, 0);
      return local(0, cells - 7);
    }
    return (col * 31 + row * 17 + ((col * row) % 7)) % 5 < 2;
  };

  const queue: Array<{ col: number; row: number; distance: number }> = [];
  for (let row = 0; row < cells; row += 1) {
    for (let col = 0; col < cells; col += 1) {
      if (cellOn(col, row)) {
        queue.push({ col, row, distance: Math.hypot(col - cells / 2, row - cells / 2) });
      }
    }
  }
  queue.sort((a, b) => a.distance - b.distance);

  const drawCell = ({ col, row }: { col: number; row: number }) => {
    ctx.fillStyle = "#4ade80";
    ctx.fillRect(col * size + 1, row * size + 1, size - 2, size - 2);
  };

  if (!animate) {
    queue.forEach(drawCell);
    return;
  }
  let index = 0;
  const step = () => {
    for (let i = 0; i < 6 && index < queue.length; i += 1) {
      drawCell(queue[index]);
      index += 1;
    }
    if (index < queue.length) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

export function DownloadSection() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      drawQr(canvas, false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting) return;
        observer.disconnect();
        drawQr(canvas, true);
      },
      { threshold: 0.4 }
    );
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="descarga" className="section download" aria-labelledby="download-title">
      <Reveal>
        <p className="eyebrow">Disponible donde cocines</p>
        <h2 id="download-title">
          Web, móvil y <em>escritorio.</em>
        </h2>
        <p className="section-sub">
          Empieza ahora desde el navegador. Las apps de iOS, Android y Windows llegan pronto con
          la misma cuenta y los mismos datos.
        </p>
        <div className="download-options">
          <Link href="/dashboard" className="ready">
            Abrir FoodOS en la web
          </Link>
          <a href="#descarga" aria-disabled="true" className="soon">
            iOS / Android <small>próximamente</small>
          </a>
          <a href="#descarga" aria-disabled="true" className="soon">
            Windows <small>próximamente</small>
          </a>
        </div>
      </Reveal>
      <Reveal className="qr-reveal" delay={120}>
        <div className="qr-panel">
          <canvas ref={canvasRef} width={220} height={220} aria-label="Código QR de descarga" />
          <p>Escanéalo cuando la app esté en las stores: te llevará directo a la descarga.</p>
        </div>
      </Reveal>
    </section>
  );
}
