import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <Link className="brand" href="/">
        <span>Food</span>OS
      </Link>
      <nav className="footer-links" aria-label="Enlaces de pie">
        <Link href="/dashboard">Abrir la app</Link>
        <a href="#producto">Producto</a>
        <a href="#como-funciona">Cómo funciona</a>
        <a href="#mascotas">Compañeros</a>
      </nav>
      <p>© {new Date().getFullYear()} FoodOS. Hecho con hambre.</p>
    </footer>
  );
}
