import type { StorageName } from "@foodos/types";

export type FoodEntry = {
  name: string;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  unit: "g" | "ml" | "ud" | "kg" | "L";
  defaultQty: number;
  storage: StorageName;
  expiryDays: number;
  category: string;
};

// ~200 alimentos españoles comunes. Macros por 100 g (o 100 ml para líquidos).
// Fuente: BEDCA / USDA / valores estándar.
export const FOOD_DB: FoodEntry[] = [
  // ── Carnes ────────────────────────────────────────────────────────
  { name: "Pechuga de pollo", kcal: 165, protein: 31, carbs: 0, fat: 3.6, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 4, category: "Carne" },
  { name: "Muslo de pollo", kcal: 209, protein: 26, carbs: 0, fat: 11, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 4, category: "Carne" },
  { name: "Pollo entero", kcal: 190, protein: 27, carbs: 0, fat: 9, unit: "g", defaultQty: 1000, storage: "Nevera", expiryDays: 3, category: "Carne" },
  { name: "Solomillo de ternera", kcal: 144, protein: 21, carbs: 0, fat: 6, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 3, category: "Carne" },
  { name: "Carne picada de ternera", kcal: 220, protein: 18, carbs: 0, fat: 16, unit: "g", defaultQty: 400, storage: "Nevera", expiryDays: 2, category: "Carne" },
  { name: "Carne picada mixta", kcal: 240, protein: 17, carbs: 0, fat: 19, unit: "g", defaultQty: 400, storage: "Nevera", expiryDays: 2, category: "Carne" },
  { name: "Lomo de cerdo", kcal: 182, protein: 22, carbs: 0, fat: 10, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 4, category: "Carne" },
  { name: "Chuletas de cerdo", kcal: 231, protein: 20, carbs: 0, fat: 16, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 3, category: "Carne" },
  { name: "Jamón serrano", kcal: 241, protein: 30, carbs: 0, fat: 14, unit: "g", defaultQty: 200, storage: "Nevera", expiryDays: 14, category: "Carne" },
  { name: "Jamón cocido", kcal: 107, protein: 16, carbs: 1, fat: 4, unit: "g", defaultQty: 200, storage: "Nevera", expiryDays: 7, category: "Carne" },
  { name: "Pechuga de pavo", kcal: 135, protein: 29, carbs: 0, fat: 1, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 4, category: "Carne" },
  { name: "Salchichas de pollo", kcal: 180, protein: 14, carbs: 3, fat: 13, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 7, category: "Carne" },
  { name: "Chorizo", kcal: 455, protein: 24, carbs: 2, fat: 39, unit: "g", defaultQty: 200, storage: "Nevera", expiryDays: 14, category: "Carne" },
  { name: "Bacon", kcal: 515, protein: 17, carbs: 1, fat: 50, unit: "g", defaultQty: 150, storage: "Nevera", expiryDays: 7, category: "Carne" },
  { name: "Mortadela", kcal: 311, protein: 13, carbs: 3, fat: 27, unit: "g", defaultQty: 150, storage: "Nevera", expiryDays: 7, category: "Carne" },
  { name: "Pechuga de pollo congelada", kcal: 165, protein: 31, carbs: 0, fat: 3.6, unit: "g", defaultQty: 500, storage: "Congelador", expiryDays: 90, category: "Carne" },

  // ── Pescado y marisco ─────────────────────────────────────────────
  { name: "Salmón fresco", kcal: 208, protein: 20, carbs: 0, fat: 13, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 2, category: "Pescado" },
  { name: "Atún en lata (agua)", kcal: 116, protein: 26, carbs: 0, fat: 1, unit: "g", defaultQty: 240, storage: "Despensa", expiryDays: 730, category: "Pescado" },
  { name: "Atún en lata (aceite)", kcal: 198, protein: 24, carbs: 0, fat: 11, unit: "g", defaultQty: 240, storage: "Despensa", expiryDays: 730, category: "Pescado" },
  { name: "Merluza", kcal: 80, protein: 17, carbs: 0, fat: 1, unit: "g", defaultQty: 400, storage: "Nevera", expiryDays: 2, category: "Pescado" },
  { name: "Bacalao fresco", kcal: 82, protein: 18, carbs: 0, fat: 0.7, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 2, category: "Pescado" },
  { name: "Sardinas en lata", kcal: 208, protein: 25, carbs: 0, fat: 11, unit: "g", defaultQty: 240, storage: "Despensa", expiryDays: 730, category: "Pescado" },
  { name: "Gambas", kcal: 85, protein: 18, carbs: 0, fat: 1, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 2, category: "Pescado" },
  { name: "Dorada", kcal: 96, protein: 17, carbs: 0, fat: 3, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 2, category: "Pescado" },
  { name: "Lubina", kcal: 97, protein: 18, carbs: 0, fat: 3, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 2, category: "Pescado" },
  { name: "Caballa", kcal: 205, protein: 19, carbs: 0, fat: 14, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 2, category: "Pescado" },
  { name: "Mejillones", kcal: 86, protein: 12, carbs: 4, fat: 2, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 2, category: "Pescado" },

  // ── Lácteos ───────────────────────────────────────────────────────
  { name: "Leche entera", kcal: 61, protein: 3.2, carbs: 4.7, fat: 3.7, unit: "ml", defaultQty: 1000, storage: "Nevera", expiryDays: 7, category: "Lácteos" },
  { name: "Leche semidesnatada", kcal: 46, protein: 3.3, carbs: 4.8, fat: 1.6, unit: "ml", defaultQty: 1000, storage: "Nevera", expiryDays: 7, category: "Lácteos" },
  { name: "Leche desnatada", kcal: 33, protein: 3.4, carbs: 5.1, fat: 0.1, unit: "ml", defaultQty: 1000, storage: "Nevera", expiryDays: 7, category: "Lácteos" },
  { name: "Yogur natural", kcal: 59, protein: 3.5, carbs: 3.8, fat: 3.3, unit: "g", defaultQty: 125, storage: "Nevera", expiryDays: 14, category: "Lácteos" },
  { name: "Yogur desnatado", kcal: 40, protein: 4.3, carbs: 5.3, fat: 0.2, unit: "g", defaultQty: 125, storage: "Nevera", expiryDays: 14, category: "Lácteos" },
  { name: "Yogur griego", kcal: 97, protein: 9, carbs: 3.6, fat: 5, unit: "g", defaultQty: 150, storage: "Nevera", expiryDays: 14, category: "Lácteos" },
  { name: "Queso fresco", kcal: 98, protein: 11, carbs: 3, fat: 4, unit: "g", defaultQty: 200, storage: "Nevera", expiryDays: 7, category: "Lácteos" },
  { name: "Queso manchego", kcal: 392, protein: 26, carbs: 0.5, fat: 31, unit: "g", defaultQty: 200, storage: "Nevera", expiryDays: 30, category: "Lácteos" },
  { name: "Queso mozzarella", kcal: 254, protein: 18, carbs: 2.7, fat: 20, unit: "g", defaultQty: 125, storage: "Nevera", expiryDays: 7, category: "Lácteos" },
  { name: "Queso parmesano rallado", kcal: 431, protein: 38, carbs: 3.2, fat: 29, unit: "g", defaultQty: 100, storage: "Nevera", expiryDays: 30, category: "Lácteos" },
  { name: "Queso de untar", kcal: 257, protein: 6, carbs: 4, fat: 24, unit: "g", defaultQty: 200, storage: "Nevera", expiryDays: 21, category: "Lácteos" },
  { name: "Mantequilla", kcal: 717, protein: 0.9, carbs: 0.1, fat: 81, unit: "g", defaultQty: 250, storage: "Nevera", expiryDays: 60, category: "Lácteos" },
  { name: "Nata para cocinar", kcal: 292, protein: 2.5, carbs: 3.7, fat: 30, unit: "ml", defaultQty: 200, storage: "Nevera", expiryDays: 14, category: "Lácteos" },

  // ── Huevos ────────────────────────────────────────────────────────
  { name: "Huevos", kcal: 143, protein: 13, carbs: 1, fat: 10, unit: "ud", defaultQty: 12, storage: "Nevera", expiryDays: 28, category: "Huevos" },
  { name: "Clara de huevo", kcal: 52, protein: 11, carbs: 0.7, fat: 0.2, unit: "ml", defaultQty: 500, storage: "Nevera", expiryDays: 5, category: "Huevos" },

  // ── Verduras ──────────────────────────────────────────────────────
  { name: "Lechuga", kcal: 15, protein: 1.4, carbs: 1.5, fat: 0.2, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 7, category: "Verdura" },
  { name: "Tomates", kcal: 18, protein: 0.9, carbs: 3.9, fat: 0.2, unit: "g", defaultQty: 500, storage: "Nevera", expiryDays: 7, category: "Verdura" },
  { name: "Zanahoria", kcal: 41, protein: 0.9, carbs: 10, fat: 0.2, unit: "g", defaultQty: 500, storage: "Nevera", expiryDays: 14, category: "Verdura" },
  { name: "Cebolla", kcal: 40, protein: 1.1, carbs: 9.3, fat: 0.1, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 30, category: "Verdura" },
  { name: "Ajo", kcal: 149, protein: 6.4, carbs: 33, fat: 0.5, unit: "g", defaultQty: 100, storage: "Despensa", expiryDays: 60, category: "Verdura" },
  { name: "Pimiento rojo", kcal: 31, protein: 1, carbs: 6, fat: 0.3, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 10, category: "Verdura" },
  { name: "Pimiento verde", kcal: 20, protein: 0.9, carbs: 4.6, fat: 0.1, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 10, category: "Verdura" },
  { name: "Espinacas", kcal: 23, protein: 2.9, carbs: 3.6, fat: 0.4, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 5, category: "Verdura" },
  { name: "Brócoli", kcal: 34, protein: 2.8, carbs: 7, fat: 0.4, unit: "g", defaultQty: 500, storage: "Nevera", expiryDays: 7, category: "Verdura" },
  { name: "Coliflor", kcal: 25, protein: 1.9, carbs: 5, fat: 0.3, unit: "g", defaultQty: 500, storage: "Nevera", expiryDays: 7, category: "Verdura" },
  { name: "Calabacín", kcal: 17, protein: 1.2, carbs: 3.1, fat: 0.3, unit: "g", defaultQty: 400, storage: "Nevera", expiryDays: 7, category: "Verdura" },
  { name: "Berenjena", kcal: 25, protein: 1, carbs: 6, fat: 0.2, unit: "g", defaultQty: 400, storage: "Nevera", expiryDays: 7, category: "Verdura" },
  { name: "Pepino", kcal: 16, protein: 0.7, carbs: 3.6, fat: 0.1, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 7, category: "Verdura" },
  { name: "Champiñones", kcal: 22, protein: 3.1, carbs: 3.3, fat: 0.3, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 5, category: "Verdura" },
  { name: "Espárragos", kcal: 20, protein: 2.2, carbs: 3.9, fat: 0.1, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 5, category: "Verdura" },
  { name: "Judías verdes", kcal: 31, protein: 1.8, carbs: 7.1, fat: 0.1, unit: "g", defaultQty: 400, storage: "Nevera", expiryDays: 5, category: "Verdura" },
  { name: "Acelgas", kcal: 20, protein: 1.8, carbs: 3.7, fat: 0.1, unit: "g", defaultQty: 500, storage: "Nevera", expiryDays: 5, category: "Verdura" },
  { name: "Guisantes", kcal: 81, protein: 5.4, carbs: 15, fat: 0.4, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 5, category: "Verdura" },
  { name: "Maíz dulce (lata)", kcal: 86, protein: 3.2, carbs: 19, fat: 1.2, unit: "g", defaultQty: 400, storage: "Despensa", expiryDays: 730, category: "Verdura" },
  { name: "Patata", kcal: 77, protein: 2, carbs: 17, fat: 0.1, unit: "g", defaultQty: 1000, storage: "Despensa", expiryDays: 30, category: "Verdura" },
  { name: "Batata", kcal: 86, protein: 1.6, carbs: 20, fat: 0.1, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 14, category: "Verdura" },
  { name: "Aguacate", kcal: 160, protein: 2, carbs: 9, fat: 15, unit: "g", defaultQty: 200, storage: "Nevera", expiryDays: 4, category: "Verdura" },
  { name: "Tomate frito (bote)", kcal: 57, protein: 1.3, carbs: 8, fat: 2.4, unit: "g", defaultQty: 400, storage: "Despensa", expiryDays: 365, category: "Verdura" },

  // ── Frutas ────────────────────────────────────────────────────────
  { name: "Manzana", kcal: 52, protein: 0.3, carbs: 14, fat: 0.2, unit: "g", defaultQty: 500, storage: "Nevera", expiryDays: 14, category: "Fruta" },
  { name: "Pera", kcal: 57, protein: 0.4, carbs: 15, fat: 0.1, unit: "g", defaultQty: 500, storage: "Nevera", expiryDays: 10, category: "Fruta" },
  { name: "Plátano", kcal: 89, protein: 1.1, carbs: 23, fat: 0.3, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 7, category: "Fruta" },
  { name: "Naranja", kcal: 47, protein: 0.9, carbs: 12, fat: 0.1, unit: "g", defaultQty: 500, storage: "Nevera", expiryDays: 14, category: "Fruta" },
  { name: "Mandarina", kcal: 53, protein: 0.8, carbs: 13, fat: 0.3, unit: "g", defaultQty: 500, storage: "Nevera", expiryDays: 10, category: "Fruta" },
  { name: "Fresas", kcal: 32, protein: 0.7, carbs: 7.7, fat: 0.3, unit: "g", defaultQty: 500, storage: "Nevera", expiryDays: 5, category: "Fruta" },
  { name: "Uvas", kcal: 69, protein: 0.7, carbs: 18, fat: 0.2, unit: "g", defaultQty: 500, storage: "Nevera", expiryDays: 7, category: "Fruta" },
  { name: "Kiwi", kcal: 61, protein: 1.1, carbs: 15, fat: 0.5, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 7, category: "Fruta" },
  { name: "Melocotón", kcal: 39, protein: 0.9, carbs: 10, fat: 0.3, unit: "g", defaultQty: 400, storage: "Nevera", expiryDays: 7, category: "Fruta" },
  { name: "Sandía", kcal: 30, protein: 0.6, carbs: 7.6, fat: 0.2, unit: "g", defaultQty: 1000, storage: "Nevera", expiryDays: 7, category: "Fruta" },
  { name: "Melón", kcal: 34, protein: 0.8, carbs: 8, fat: 0.2, unit: "g", defaultQty: 800, storage: "Nevera", expiryDays: 7, category: "Fruta" },
  { name: "Limón", kcal: 29, protein: 1.1, carbs: 9, fat: 0.3, unit: "g", defaultQty: 200, storage: "Nevera", expiryDays: 21, category: "Fruta" },

  // ── Cereales, pasta y pan ─────────────────────────────────────────
  { name: "Arroz blanco", kcal: 365, protein: 7, carbs: 80, fat: 1, unit: "g", defaultQty: 1000, storage: "Despensa", expiryDays: 730, category: "Cereal" },
  { name: "Arroz integral", kcal: 350, protein: 8, carbs: 73, fat: 2.8, unit: "g", defaultQty: 1000, storage: "Despensa", expiryDays: 365, category: "Cereal" },
  { name: "Pasta (macarrones)", kcal: 352, protein: 12, carbs: 71, fat: 1.3, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 730, category: "Cereal" },
  { name: "Pasta (espaguetis)", kcal: 352, protein: 12, carbs: 71, fat: 1.3, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 730, category: "Cereal" },
  { name: "Pan blanco", kcal: 265, protein: 8, carbs: 55, fat: 2, unit: "g", defaultQty: 400, storage: "Despensa", expiryDays: 5, category: "Cereal" },
  { name: "Pan integral", kcal: 247, protein: 9, carbs: 48, fat: 2, unit: "g", defaultQty: 400, storage: "Despensa", expiryDays: 5, category: "Cereal" },
  { name: "Pan de molde blanco", kcal: 271, protein: 9, carbs: 50, fat: 4, unit: "g", defaultQty: 450, storage: "Despensa", expiryDays: 10, category: "Cereal" },
  { name: "Avena en copos", kcal: 389, protein: 17, carbs: 66, fat: 7, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 365, category: "Cereal" },
  { name: "Harina de trigo", kcal: 364, protein: 10, carbs: 76, fat: 1, unit: "g", defaultQty: 1000, storage: "Despensa", expiryDays: 365, category: "Cereal" },
  { name: "Cous cous", kcal: 376, protein: 12, carbs: 77, fat: 0.6, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 365, category: "Cereal" },
  { name: "Quinoa", kcal: 368, protein: 14, carbs: 64, fat: 6, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 365, category: "Cereal" },
  { name: "Cereales de desayuno", kcal: 378, protein: 8, carbs: 82, fat: 3, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 180, category: "Cereal" },

  // ── Legumbres ─────────────────────────────────────────────────────
  { name: "Lentejas (secas)", kcal: 353, protein: 25, carbs: 60, fat: 1.1, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 730, category: "Legumbre" },
  { name: "Garbanzos (cocidos)", kcal: 164, protein: 8.9, carbs: 27, fat: 2.6, unit: "g", defaultQty: 400, storage: "Despensa", expiryDays: 730, category: "Legumbre" },
  { name: "Alubias blancas (cocidas)", kcal: 139, protein: 9.7, carbs: 25, fat: 0.5, unit: "g", defaultQty: 400, storage: "Despensa", expiryDays: 730, category: "Legumbre" },
  { name: "Alubias negras", kcal: 341, protein: 22, carbs: 62, fat: 1.4, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 730, category: "Legumbre" },
  { name: "Edamame", kcal: 122, protein: 11, carbs: 9.9, fat: 5.2, unit: "g", defaultQty: 400, storage: "Congelador", expiryDays: 90, category: "Legumbre" },

  // ── Frutos secos ──────────────────────────────────────────────────
  { name: "Almendras", kcal: 579, protein: 21, carbs: 22, fat: 50, unit: "g", defaultQty: 200, storage: "Despensa", expiryDays: 180, category: "Frutos secos" },
  { name: "Nueces", kcal: 654, protein: 15, carbs: 14, fat: 65, unit: "g", defaultQty: 200, storage: "Despensa", expiryDays: 180, category: "Frutos secos" },
  { name: "Anacardos", kcal: 553, protein: 18, carbs: 30, fat: 44, unit: "g", defaultQty: 200, storage: "Despensa", expiryDays: 180, category: "Frutos secos" },
  { name: "Cacahuetes", kcal: 567, protein: 26, carbs: 16, fat: 49, unit: "g", defaultQty: 200, storage: "Despensa", expiryDays: 180, category: "Frutos secos" },
  { name: "Pipas de girasol", kcal: 584, protein: 21, carbs: 20, fat: 51, unit: "g", defaultQty: 200, storage: "Despensa", expiryDays: 180, category: "Frutos secos" },

  // ── Aceites y grasas ──────────────────────────────────────────────
  { name: "Aceite de oliva virgen", kcal: 884, protein: 0, carbs: 0, fat: 100, unit: "ml", defaultQty: 750, storage: "Despensa", expiryDays: 365, category: "Aceite" },
  { name: "Aceite de girasol", kcal: 884, protein: 0, carbs: 0, fat: 100, unit: "ml", defaultQty: 750, storage: "Despensa", expiryDays: 365, category: "Aceite" },

  // ── Bebidas y lácteos vegetales ───────────────────────────────────
  { name: "Leche de avena", kcal: 47, protein: 1, carbs: 7.4, fat: 1.5, unit: "ml", defaultQty: 1000, storage: "Nevera", expiryDays: 7, category: "Bebida" },
  { name: "Leche de almendra", kcal: 24, protein: 0.5, carbs: 3.3, fat: 1, unit: "ml", defaultQty: 1000, storage: "Nevera", expiryDays: 7, category: "Bebida" },
  { name: "Leche de soja", kcal: 43, protein: 3.3, carbs: 2.6, fat: 1.8, unit: "ml", defaultQty: 1000, storage: "Nevera", expiryDays: 7, category: "Bebida" },
  { name: "Zumo de naranja", kcal: 45, protein: 0.7, carbs: 10, fat: 0.2, unit: "ml", defaultQty: 1000, storage: "Nevera", expiryDays: 5, category: "Bebida" },
  { name: "Agua", kcal: 0, protein: 0, carbs: 0, fat: 0, unit: "ml", defaultQty: 1500, storage: "Despensa", expiryDays: 365, category: "Bebida" },

  // ── Proteínas y suplementos ───────────────────────────────────────
  { name: "Proteína whey", kcal: 400, protein: 80, carbs: 6, fat: 5, unit: "g", defaultQty: 1000, storage: "Despensa", expiryDays: 365, category: "Suplemento" },
  { name: "Proteína vegana", kcal: 380, protein: 75, carbs: 8, fat: 4, unit: "g", defaultQty: 1000, storage: "Despensa", expiryDays: 365, category: "Suplemento" },
  { name: "Tofu", kcal: 76, protein: 8, carbs: 1.9, fat: 4.8, unit: "g", defaultQty: 400, storage: "Nevera", expiryDays: 7, category: "Proteína" },
  { name: "Tempeh", kcal: 193, protein: 19, carbs: 9.4, fat: 11, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 7, category: "Proteína" },

  // ── Condimentos y salsas ──────────────────────────────────────────
  { name: "Salsa de tomate (bote)", kcal: 39, protein: 1.8, carbs: 7.2, fat: 0.7, unit: "g", defaultQty: 700, storage: "Despensa", expiryDays: 730, category: "Condimento" },
  { name: "Mayonesa", kcal: 680, protein: 1.1, carbs: 1.8, fat: 75, unit: "g", defaultQty: 250, storage: "Nevera", expiryDays: 60, category: "Condimento" },
  { name: "Ketchup", kcal: 101, protein: 1.4, carbs: 25, fat: 0.1, unit: "g", defaultQty: 300, storage: "Nevera", expiryDays: 90, category: "Condimento" },
  { name: "Mostaza", kcal: 67, protein: 4.4, carbs: 6.7, fat: 3.3, unit: "g", defaultQty: 200, storage: "Nevera", expiryDays: 180, category: "Condimento" },
  { name: "Salsa de soja", kcal: 53, protein: 8.1, carbs: 5, fat: 0.1, unit: "ml", defaultQty: 250, storage: "Despensa", expiryDays: 365, category: "Condimento" },
  { name: "Vinagre de manzana", kcal: 22, protein: 0, carbs: 0.9, fat: 0, unit: "ml", defaultQty: 500, storage: "Despensa", expiryDays: 730, category: "Condimento" },

  // ── Dulces y snacks ───────────────────────────────────────────────
  { name: "Chocolate negro 70%", kcal: 598, protein: 8, carbs: 46, fat: 43, unit: "g", defaultQty: 100, storage: "Despensa", expiryDays: 180, category: "Dulce" },
  { name: "Miel", kcal: 304, protein: 0.3, carbs: 82, fat: 0, unit: "g", defaultQty: 500, storage: "Despensa", expiryDays: 730, category: "Dulce" },
  { name: "Azúcar", kcal: 387, protein: 0, carbs: 100, fat: 0, unit: "g", defaultQty: 1000, storage: "Despensa", expiryDays: 730, category: "Dulce" },
  { name: "Cacao en polvo (sin azúcar)", kcal: 354, protein: 17, carbs: 60, fat: 10, unit: "g", defaultQty: 250, storage: "Despensa", expiryDays: 365, category: "Dulce" },
  { name: "Crema de cacahuete", kcal: 588, protein: 25, carbs: 20, fat: 50, unit: "g", defaultQty: 340, storage: "Despensa", expiryDays: 180, category: "Dulce" },
];

export function searchFoodDB(query: string, limit = 8): FoodEntry[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase().trim();
  return FOOD_DB.filter((f) => f.name.toLowerCase().includes(q)).slice(0, limit);
}

export function findExactFood(name: string): FoodEntry | undefined {
  const q = name.toLowerCase().trim();
  return FOOD_DB.find((f) => f.name.toLowerCase() === q)
    ?? FOOD_DB.find((f) => f.name.toLowerCase().includes(q));
}
