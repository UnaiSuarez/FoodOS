# apps/desktop — App de escritorio de FoodOS (futuro)

Carpeta reservada para la app de Windows/macOS/Linux. La documentacion tecnica
(seccion 16.5) contempla Electron o **Tauri** (recomendado: instalador mucho
mas ligero y menor consumo de RAM).

## Cuando toque arrancarla

```powershell
cd apps
npm create tauri-app@latest desktop
```

La via mas rapida: Tauri envolviendo la web app ya desplegada (o el build
estatico de `apps/web`), compartiendo la misma sesion de Supabase Auth.

1. Añadir `"@foodos/types": "*"` para compartir tipos.
2. Apuntar la ventana al deploy de Vercel o servir el build local.
3. Generar el instalador `.exe` / `.msi` con `npm run tauri build`.
