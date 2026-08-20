#!/usr/bin/env node
// E21-19: comprobación de tamaño de bundle — corre después de `next build`
// (ver package.json) y bloquea el merge si el JS del cliente crece de forma
// excesiva. Métrica deliberadamente simple: suma el tamaño gzip de TODOS
// los chunks de .next/static/chunks/ — no el desglose por ruta que imprime
// `next build` (ese formato de tabla no es estable entre versiones de
// Next.js y parsearlo sería frágil), solo un total agregado que crece con
// cualquier dependencia nueva importada en el cliente, sea de la ruta que
// sea.
//
// El límite es generoso a propósito (deja margen para crecimiento legítimo
// de funcionalidad) — su valor es para atrapar un salto GRANDE y accidental
// (una dependencia pesada importada sin querer, un import no goleado que
// arrastra una librería entera), no para perseguir cada kilobyte. Si el
// límite empieza a saltar con cambios legítimos, subirlo aquí es la
// solución correcta, no borrar la comprobación.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const CHUNKS_DIR = join(process.cwd(), ".next", "static", "chunks");
const LIMIT_KB = 650;

function walk(dir) {
  let files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(walk(full));
    else if (entry.name.endsWith(".js")) files.push(full);
  }
  return files;
}

let files;
try {
  files = walk(CHUNKS_DIR);
} catch (error) {
  console.error(`No se encontró ${CHUNKS_DIR} — ¿corriste "next build" antes de este script?`);
  console.error(error.message);
  process.exit(1);
}

if (files.length === 0) {
  console.error(`No se encontró ningún chunk .js en ${CHUNKS_DIR}.`);
  process.exit(1);
}

let gzipTotal = 0;
const perFile = [];
for (const file of files) {
  const buf = readFileSync(file);
  const gzipSize = gzipSync(buf).length;
  gzipTotal += gzipSize;
  perFile.push({ file: file.slice(CHUNKS_DIR.length + 1), gzipKB: Math.round(gzipSize / 1024) });
}

const totalKB = Math.round(gzipTotal / 1024);
perFile.sort((a, b) => b.gzipKB - a.gzipKB);

console.log(`Bundle JS (gzip) del cliente: ${totalKB} KB en ${files.length} chunks (límite: ${LIMIT_KB} KB).`);
console.log("Los 5 chunks más pesados:");
for (const { file, gzipKB } of perFile.slice(0, 5)) {
  console.log(`  ${gzipKB.toString().padStart(4)} KB  ${file}`);
}

if (totalKB > LIMIT_KB) {
  console.error(
    `\n❌ El bundle (${totalKB} KB) supera el límite de ${LIMIT_KB} KB. ` +
      `Si el crecimiento es legítimo (nueva funcionalidad real), sube LIMIT_KB en ` +
      `apps/web/scripts/check-bundle-size.mjs explicando por qué en el mismo commit.`,
  );
  process.exit(1);
}

console.log(`\n✓ Dentro del límite (${LIMIT_KB - totalKB} KB de margen).`);
