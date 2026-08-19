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
  await headers();
  return (
    <html lang="es" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <div className="noise" aria-hidden="true" />
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
