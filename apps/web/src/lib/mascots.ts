import type { Mascot } from "@foodos/types";

// Los 15 compañeros de FoodOS (seccion 23 de la documentacion tecnica).
// Avatares recortados de la lamina oficial en public/mascots/.
export const MASCOTS: Mascot[] = [
  { id: "zana", name: "Zana", color: "#fb923c", tagline: "Energética y motivadora", image: "/mascots/zana.webp" },
  { id: "basil", name: "Basil", color: "#a3e635", tagline: "Sereno y experto", image: "/mascots/basil.webp" },
  { id: "froggy", name: "Froggy", color: "#22c55e", tagline: "Curioso y con humor", image: "/mascots/froggy.webp" },
  { id: "sage", name: "Sage", color: "#c084fc", tagline: "Tranquilo y analítico", image: "/mascots/sage.webp" },
  { id: "chip", name: "Chip", color: "#60a5fa", tagline: "Neutro y eficiente", image: "/mascots/chip.webp" },
  { id: "mushi", name: "Mushi", color: "#f472b6", tagline: "Soñadora y creativa", image: "/mascots/mushi.webp" },
  { id: "bruno", name: "Bruno", color: "#a78bfa", tagline: "Cariñoso y protector", image: "/mascots/bruno.webp" },
  { id: "pica", name: "Pica", color: "#ef4444", tagline: "Intensa y retadora", image: "/mascots/pica.webp" },
  { id: "okto", name: "Okto", color: "#06b6d4", tagline: "Organizado y multitarea", image: "/mascots/okto.webp" },
  { id: "kiri", name: "Kiri", color: "#f97316", tagline: "Carismático y creativo", image: "/mascots/kiri.webp" },
  { id: "vera", name: "Vera", color: "#86efac", tagline: "Calmada y equilibrada", image: "/mascots/vera.webp" },
  { id: "pingo", name: "Pingo", color: "#7dd3fc", tagline: "Metódico y ordenado", image: "/mascots/pingo.webp" },
  { id: "volt", name: "Volt", color: "#fde047", tagline: "Hiperactivo y explosivo", image: "/mascots/volt.webp" },
  { id: "leo", name: "Leo", color: "#fbbf24", tagline: "Fuerte y motivador", image: "/mascots/leo.webp" },
  { id: "luna", name: "Luna", color: "#818cf8", tagline: "Misteriosa y tranquila", image: "/mascots/luna.webp" },
];

export function getMascot(id: string): Mascot {
  return MASCOTS.find((mascot) => mascot.id === id) ?? MASCOTS[0];
}
