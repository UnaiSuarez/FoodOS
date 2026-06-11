const ITEMS = [
  "Inventario inteligente",
  "Recetas por macros",
  "Lista de compra por tienda",
  "Presupuesto alimentario",
  "Conexión con tu banco",
  "Recetas con IA",
  "15 compañeros",
  "Escaneo de código de barras",
];

export function Ticker() {
  return (
    <section className="ticker" aria-label="Capacidades principales">
      <div className="ticker-track">
        <div className="ticker-group">
          {ITEMS.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        <div className="ticker-group" aria-hidden="true">
          {ITEMS.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </div>
    </section>
  );
}
