import { Reveal } from "./Reveal";

// Demo estática que muestra el diario, el asistente IA y el presupuesto en un vistazo.
export function Showcase() {
  return (
    <section className="section showcase" aria-labelledby="showcase-title">
      <div className="section-heading">
        <p className="eyebrow">Todo conectado</p>
        <h2 id="showcase-title">
          Despensa, macros y dinero <em>hablando entre sí.</em>
        </h2>
      </div>
      <div className="showcase-grid">
        <Reveal>
          <div className="phone-panel">
            <div className="phone-top">
              <span>Diario · Hoy</span>
              <strong>1.805 kcal</strong>
            </div>
            <div className="showcase-diary">
              <div className="showcase-meal">
                <span className="showcase-meal-chip">🌅 Desayuno</span>
                <span className="showcase-meal-kcal">482 kcal</span>
              </div>
              <div className="showcase-meal">
                <span className="showcase-meal-chip">☀️ Comida</span>
                <span className="showcase-meal-kcal">631 kcal</span>
              </div>
              <div className="showcase-meal">
                <span className="showcase-meal-chip">🌤 Snack</span>
                <span className="showcase-meal-kcal">210 kcal</span>
              </div>
              <div className="showcase-meal pending">
                <span className="showcase-meal-chip">🌙 Cena</span>
                <span className="showcase-meal-kcal muted">pendiente</span>
              </div>
            </div>
            <div className="mini-bars">
              <div>
                <span>Proteína · 134 / 170 g</span>
                <b style={{ width: "79%" }} />
              </div>
              <div>
                <span>Carbohidratos · 180 / 230 g</span>
                <b style={{ width: "63%" }} />
              </div>
              <div>
                <span>Grasas · 48 / 70 g</span>
                <b style={{ width: "69%" }} />
              </div>
            </div>
            <div className="showcase-water">
              <span>💧 1,75 L de 2,5 L</span>
              <div className="budget-line"><i style={{ width: "70%" }} /></div>
            </div>
          </div>
        </Reveal>
        <Reveal delay={90}>
          <div className="recommendation-panel">
            <p className="eyebrow">Asistente IA · Cena sugerida</p>
            <h3>Pechuga con arroz integral</h3>
            <p>
              Usa la pechuga que caduca mañana, cubre los 36 g de proteína que te faltan y cuesta
              2,80 € — dentro de tu presupuesto semanal.
            </p>
            <div className="chips">
              <span className="badge green">Ingredientes en casa</span>
              <span className="badge amber">Caduca mañana</span>
              <span className="badge blue">Dentro de presupuesto</span>
            </div>
            <div className="chips" style={{ marginTop: 8 }}>
              <span className="badge">482 kcal · por ración</span>
              <span className="badge">36 g proteína</span>
            </div>
          </div>
        </Reveal>
        <Reveal delay={180}>
          <div className="budget-panel">
            <span>Presupuesto semanal</span>
            <strong>28 €</strong>
            <div className="budget-line">
              <i />
            </div>
            <small>Gastado: 19,40 € · quedan 8,60 €</small>
            <div className="showcase-finance-row">
              <span>Esta semana</span>
              <div className="showcase-cats">
                <span className="badge green">Mercadona 12,30 €</span>
                <span className="badge">Frutería 4,80 €</span>
                <span className="badge">Carnicería 2,30 €</span>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
