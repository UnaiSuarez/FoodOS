// @vitest-environment jsdom
//
// Corrección de revisión (P1, "verificar expresamente que el caller no
// ejecuta onChange" cuando uploadProductImage() resuelve stale-session).
// remote.uploadProductImage() y resizeImageFile() se mockean directamente
// — el mecanismo de captura/recomprobación de identidad de sesión (A→B) ya
// se prueba exhaustivamente en data-layer.test.ts; esto prueba SOLO la
// reacción del caller (ImagePickerField) ante cada `.kind`, con el
// componente real montado (react-dom/client + act + jsdom).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { FoodOSProvider } from "@/lib/state";
import { remote } from "@/lib/data-layer";
import * as utils from "@/lib/utils";
import { ImagePickerField } from "./ImagePickerField";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) {
    act(() => { root!.unmount(); });
    root = null;
  }
  container.remove();
  vi.restoreAllMocks();
});

async function selectFile(input: HTMLInputElement) {
  const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  });
}

describe("ImagePickerField — reacción a cada RemoteMutationResult de uploadProductImage()", () => {
  it("'stale-session' (A→B mientras la subida estaba en vuelo): onChange NUNCA se llama, el formulario queda intacto", async () => {
    vi.spyOn(utils, "resizeImageFile").mockResolvedValue("data:image/jpeg;base64,AAAA");
    vi.spyOn(remote, "uploadProductImage").mockResolvedValue({ kind: "stale-session" });
    const onChange = vi.fn();

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <FoodOSProvider>
          <ImagePickerField imageUrl={undefined} onChange={onChange} />
        </FoodOSProvider>,
      );
      await Promise.resolve(); await Promise.resolve();
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await selectFile(input);

    // Ni el dataUrl local de A, ni ningún otro valor — la operación se
    // ignora POR COMPLETO desde la perspectiva de B.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("'ok': onChange SÍ se llama, con la URL subida (camino feliz, para contraste)", async () => {
    vi.spyOn(utils, "resizeImageFile").mockResolvedValue("data:image/jpeg;base64,AAAA");
    vi.spyOn(remote, "uploadProductImage").mockResolvedValue({ kind: "ok", value: "https://cdn/product-images/user-1/x.jpg" });
    const onChange = vi.fn();

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <FoodOSProvider>
          <ImagePickerField imageUrl={undefined} onChange={onChange} />
        </FoodOSProvider>,
      );
      await Promise.resolve(); await Promise.resolve();
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await selectFile(input);

    expect(onChange).toHaveBeenCalledWith("https://cdn/product-images/user-1/x.jpg");
  });

  it("'blocked': onChange NUNCA se llama (gate cerrado — nunca se completa el formulario con una foto que ni se intentó subir)", async () => {
    vi.spyOn(utils, "resizeImageFile").mockResolvedValue("data:image/jpeg;base64,AAAA");
    vi.spyOn(remote, "uploadProductImage").mockResolvedValue({ kind: "blocked" });
    const onChange = vi.fn();

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <FoodOSProvider>
          <ImagePickerField imageUrl={undefined} onChange={onChange} />
        </FoodOSProvider>,
      );
      await Promise.resolve(); await Promise.resolve();
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    await selectFile(input);

    expect(onChange).not.toHaveBeenCalled();
  });
});
