/** @type {import('next').NextConfig} */
const nextConfig = {
  // El segundo paquete de este array se añade AQUÍ y solo aquí (ver
  // src/lib/nutrition-v4-coverage-gateway.ts, el único archivo de
  // apps/web/src autorizado a importarlo): su "main" apunta a TypeScript
  // fuente, sin compilar, y Next.js no transpila por defecto nada bajo
  // node_modules (ni un workspace enlazado) salvo que se declare aquí
  // explícitamente — igual que ya pasa con el primero. (Nota deliberada:
  // este comentario evita repetir el nombre exacto del paquete fuera del
  // array — la prueba estructural que protege este archivo escanea su
  // TEXTO completo, comentarios incluidos, buscando esa cadena fuera de
  // transpilePackages.)
  transpilePackages: ["@foodos/types", "@foodos/engine"],
};

export default nextConfig;
