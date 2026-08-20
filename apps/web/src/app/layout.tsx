import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { DM_Mono, DM_Serif_Display, Outfit } from "next/font/google";
import "./globals.css";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";

const serif = DM_Serif_Display({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-serif",
  display: "swap",
});

const sans = Outfit({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = DM_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://food-os-web.vercel.app"),
  title: {
    default: "FoodOS — Tu nevera, tus macros y tu dinero, conectados",
    template: "%s · FoodOS",
  },
  description:
    "FoodOS unifica inventario de alimentos, recetas, lista de la compra, nutrición y finanzas personales en una sola app. Gratis en lo esencial.",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
  manifest: "/manifest.json",
  openGraph: {
    title: "FoodOS — Tu nevera, tus macros y tu dinero, conectados",
    description:
      "La app que sabe qué tienes en casa, qué necesitas comer y cuánto puedes gastar. Inventario, recetas, nutrición y finanzas en un solo lugar.",
    type: "website",
    images: ["/images/foodos-hero.webp"],
  },
};

export const viewport: Viewport = {
  themeColor: "#070a05",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // E15-03/E20-03: leer el nonce que puso el middleware es lo que hace que
  // Next.js aplique automáticamente ese mismo nonce a los scripts que él
  // mismo inyecta (hidratación, chunks...) — sin esto, la CSP del middleware
  // no protegería nada que Next.js genera por su cuenta. Convierte este
  // layout en dinámico (no se puede pre-renderizar de forma estática), un
  // coste aceptado a cambio de tener nonces reales.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="es" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        {/* E02-06: evita el parpadeo de tema al cargar — sin este script el
            tema por defecto ("dark") pintaba primero y, si el usuario tenía
            "light" guardado, useEffect lo cambiaba un instante después (ya
            con la página pintada), causando un flash visible. Un <script>
            síncrono aquí, antes de cualquier otro contenido, bloquea el
            pintado hasta fijar el atributo correcto — se necesita el mismo
            nonce que exige script-src en la CSP (ver middleware.ts). */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html:
              'try{var t=localStorage.getItem("foodos-theme");if(t==="light")document.documentElement.dataset.theme="light";}catch(e){}',
          }}
        />
        <div className="noise" aria-hidden="true" />
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
