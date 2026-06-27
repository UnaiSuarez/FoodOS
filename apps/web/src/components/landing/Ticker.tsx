const ITEMS = [
  "Inventario inteligente",
  "Recetas con IA",
  "Diario alimentario",
  "Seguimiento de peso",
  "Lista de compra inteligente",
  "Presupuesto alimentario",
  "Importación masiva por foto",
  "Escaneo de código de barras",
  "15 compañeros de cocina",
  "Asistente IA contextual",
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
