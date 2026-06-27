import { Reveal } from "./Reveal";

const MODULES = [
  {
    index: "01",
    badge: { label: "Inventario", cls: "green" },
    title: "Tu nevera, bajo control",
    copy: "Añade alimentos a mano, escaneando el código de barras o importando una foto de tu compra. FoodOS calcula la caducidad según dónde lo guardes y te avisa antes de que se estropee.",
    featured: true,
    bullets: ["Nevera, congelador y despensa", "Datos nutricionales automáticos (Open Food Facts)", "Alertas de caducidad y stock bajo", "Importación masiva por foto"],
  },
  {
    index: "02",
    badge: { label: "Recetas IA", cls: "" },
    title: "Cocina con lo que tienes — o pide que la IA decida",
    copy: "La IA genera recetas usando tu despensa, tus macros y tu presupuesto. Las macros se calculan ingrediente a ingrediente antes de guardar.",
  },
  {
    index: "03",
    badge: { label: "Carrito", cls: "" },
    title: "Lista de compra que se hace sola",
    copy: "El carrito detecta qué tienes bajo en stock y qué necesitas para el plan semanal. Al completar la compra, tu despensa y tus finanzas se actualizan solas.",
  },
  {
    index: "04",
    badge: { label: "Diario", cls: "" },
    title: "Registra cada comida, cada día",
    copy: "Anota desayuno, comida, cena y snacks. Lleva el control del agua que bebes. Toca cualquier entrada para ver su desglose nutricional completo con barra tricolor.",
  },
  {
    index: "05",
    badge: { label: "Finanzas", cls: "blue" },
    title: "Tu dinero, en orden",
    copy: "Presupuesto semanal de comida, ingresos, gastos por categoría y proyección de ahorro. Cada compra del carrito se registra automáticamente.",
  },
  {
    index: "06",
    badge: { label: "Nutrición", cls: "" },
    title: "Objetivos y peso, en una sola vista",
    copy: "Calcula tu TMB y TDEE, elige entre 4 modos de objetivo y haz seguimiento de tu peso con una gráfica. El optimizador proteína/€ aprovecha lo que tienes en casa.",
  },
  {
    index: "07",
    badge: { label: "IA", cls: "purple" },
    title: "Tu coach personal de cocina",
    copy: "Chat contextual que conoce tu despensa, tus macros y tu presupuesto. Genera recetas, crea listas de compra y te guía. Compatible con Gemini, OpenAI, Anthropic y Ollama.",
  },
];

export function Problem() {
  return (
    <section className="section intro" aria-labelledby="intro-title">
      <div className="section-heading single">
        <p className="eyebrow">Por qué FoodOS</p>
        <h2 id="intro-title">
          Tu nevera, tu diario y tu dinero <em>por fin hablan entre sí.</em>
        </h2>
      </div>
      <div className="intro-grid">
        <Reveal>
          <article>
            <span className="dot green" />
            <h3>Menos desperdicio</h3>
            <p>Sabes exactamente qué tienes y qué caduca. FoodOS te propone recetas para usarlo antes de tirarlo.</p>
          </article>
        </Reveal>
        <Reveal delay={80}>
          <article>
            <span className="dot amber" />
            <h3>Macros y peso controlados</h3>
            <p>Registra cada comida, haz seguimiento del peso y deja que la IA ajuste las sugerencias a tu objetivo real.</p>
          </article>
        </Reveal>
        <Reveal delay={160}>
          <article>
            <span className="dot blue" />
            <h3>Cuentas claras</h3>
            <p>Cada compra se registra sola. Siempre sabes cuánto llevas gastado, cuánto ahorras y cuánto te queda.</p>
          </article>
        </Reveal>
      </div>
    </section>
  );
}

export function Features() {
  return (
    <section id="producto" className="section modules" aria-labelledby="modules-title">
      <div className="section-heading">
        <p className="eyebrow">Todo en una app</p>
        <h2 id="modules-title">
          Siete módulos, <em>una sola IA.</em>
        </h2>
      </div>
      <div className="module-grid">
        {MODULES.map((module, index) => (
          <Reveal key={module.index} className={module.featured ? "featured-cell" : ""} delay={(index % 3) * 70}>
            <article className={`module-card ${module.featured ? "featured" : ""}`}>
              <div className="module-top">
                <span className="module-index">{module.index}</span>
                <span className={`badge ${module.badge.cls}`}>{module.badge.label}</span>
              </div>
              <h3>{module.title}</h3>
              <p>{module.copy}</p>
              {module.bullets ? (
                <ul>
                  {module.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              ) : null}
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
