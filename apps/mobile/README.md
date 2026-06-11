# apps/mobile — App movil de FoodOS (futuro)

Carpeta reservada para la app iOS/Android con **Expo SDK 51 / React Native**,
tal y como define la documentacion tecnica (seccion 2.3).

## Cuando toque arrancarla

```powershell
cd apps
npx create-expo-app@latest mobile --template blank-typescript
```

Despues:

1. Añadir `"@foodos/types": "*"` a las dependencias para compartir tipos.
2. Reutilizar la logica de `apps/web/src/lib` (calculos de macros, presupuesto,
   adaptador de Supabase) extrayendola a `packages/core` cuando haya dos consumidores.
3. Auth y datos: mismo proyecto de Supabase, cliente `@supabase/supabase-js`
   con storage de sesion de Expo SecureStore.
4. Probar en dispositivo con Expo Go (gratis); builds con EAS (30/mes gratis).

Costes de publicacion: Google Play 25 USD (pago unico) · App Store 99 USD/año.
