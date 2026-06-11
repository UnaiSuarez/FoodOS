import { Reveal } from "./Reveal";

// Demo estatica de la recomendacion contextual (el "ejemplo real" del PDF §1.1).
export function Showcase() {
  return (
    <section className="section showcase" aria-labelledby="showcase-title">
      <div className="section-heading">
        <p className="eyebrow">Inteligencia en contexto</p>
        <h2 id="showcase-title">
          Una recomendación que <em>lo entiende todo.</em>
        </h2>
      </div>
      <div className="showcase-grid">
        <Reveal>
          <div className="phone-panel">
            <div className="phone-top">
              <span>Hoy</span>
              <strong>1.805 kcal</strong>
            </div>
            <div className="macro-ring" role="img" aria-label="82% de las calorías del día completadas">
              <span>82%</span>
            </div>
            <div className="mini-bars">
              <div>
                <span>Proteína</span>
                <b style={{ width: "78%" }} />
              </div>
              <div>
                <span>Carbohidratos</span>
                <b style={{ width: "63%" }} />
              </div>
              <div>
                <span>Grasas</span>
                <b style={{ width: "41%" }} />
              </div>
            </div>
          </div>
        </Reveal>
        <Reveal delay={90}>
          <div className="recommendation-panel">
            <p className="eyebrow">Cena sugerida</p>
            <h3>Pechuga con arroz integral</h3>
            <p>
              Usa la pechuga que caduca mañana, cubre los 50 g de proteína que te faltan y cuesta
              2,80 € — dentro de tu presupuesto semanal.
            </p>
            <div className="chips">
              <span className="badge green">Ingredientes en casa</span>
              <span className="badge amber">Caduca mañana</span>
              <span className="badge blue">Dentro de presupuesto</span>
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
            <small>Después de esta cena: 25,20 €</small>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
