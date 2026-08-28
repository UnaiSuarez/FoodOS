// Polyfill mínimo de localStorage/sessionStorage para el entorno "node" de
// Vitest (sin DOM real). Node no expone estos globales por defecto — hasta
// ahora ningún módulo de producción los llamaba dentro de un test unitario
// (saveLocalState/loadLocalState solo se probaban indirectamente vía
// inyección de dependencias, nunca contra el localStorage real). El módulo
// de outbox (rama sync/outbox-session-safety) SÍ necesita ejercitar
// localStorage/sessionStorage de verdad — un compare-and-delete, un
// envelope atómico o un aparcado con TTL solo son creíbles si el test pasa
// por una implementación real de Storage, no por un mock a medida por test.
//
// Implementación en memoria, una instancia nueva por proceso de test (cada
// archivo de test corre en su propio worker/contexto de Vitest, así que no
// hace falta limpiarla entre archivos — dentro de un mismo archivo, los
// tests que necesiten aislarse llaman a localStorage.clear() en beforeEach).
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), writable: true, configurable: true });
}
if (typeof globalThis.sessionStorage === "undefined") {
  Object.defineProperty(globalThis, "sessionStorage", { value: new MemoryStorage(), writable: true, configurable: true });
}
