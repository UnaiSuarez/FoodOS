import type { Metadata, Viewport } from "next";
import { DM_Mono, DM_Serif_Display, Outfit } from "next/font/google";
import "./globals.css";

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
  title: {
    default: "FoodOS — Tu nevera, tus macros y tu dinero, conectados",
    template: "%s · FoodOS",
  },
  description:
    "FoodOS unifica inventario de alimentos, recetas, lista de la compra, nutrición y finanzas personales en una sola app. Gratis en lo esencial.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23070a05'/%3E%3Ctext x='32' y='46' font-family='Georgia,serif' font-size='42' fill='%234ade80' text-anchor='middle'%3EF%3C/text%3E%3C/svg%3E",
  },
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body>
        <div className="noise" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
