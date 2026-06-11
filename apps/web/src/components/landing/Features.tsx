import { Reveal } from "./Reveal";

const MODULES = [
  {
    index: "01",
    badge: { label: "Inventario", cls: "green" },
    title: "Tu nevera, bajo control",
    copy: "Añade alimentos a mano, escaneando el código de barras o con una foto. FoodOS calcula la caducidad según dónde lo guardes y te avisa antes de que se estropee.",
    featured: true,
    bullets: ["Nevera, congelador y despensa", "Datos nutricionales automáticos", "Alertas de caducidad y stock"],
  },
  {
    index: "02",
    badge: { label: "Recetas", cls: "" },
    title: "Cocina con lo que tienes",
    copy: "Cada receta te dice qué ingredientes tienes y cuáles te faltan, con coste por ración.",
  },
  {
    index: "03",
    badge: { label: "Compra", cls: "" },
    title: "Lista de compra que piensa",
    copy: "Junta ingredientes de varias recetas, organiza por tienda y registra el gasto al completar la compra.",
  },
  {
    index: "04",
    badge: { label: "Social", cls: "" },
    title: "Inspírate en la comunidad",
    copy: "Descubre recetas de otros usuarios, guárdalas y añade sus ingredientes a tu carrito en un toque.",
  },
  {
    index: "05",
    badge: { label: "Finanzas", cls: "blue" },
    title: "Tu dinero, conectado",
    copy: "Presupuesto semanal de comida, gastos por categoría y conexión opcional con tu banco.",
  },
  {
    index: "06",
    badge: { label: "Nutrición", cls: "" },
    title: "Objetivos que se cumplen",
    copy: "Define tu objetivo corporal y FoodOS reparte tus calorías y macros día a día.",
  },
  {
    index: "07",
    badge: { label: "IA", cls: "purple" },
    title: "Recetas a medida",
    copy: "¿No te encaja nada? La IA genera una receta con lo que hay en tu cocina, tus macros y tu presupuesto.",
  },
];

export function Problem() {
  return (
    <section className="section intro" aria-labelledby="intro-title">
      <div className="section-heading single">
        <p className="eyebrow">El problema</p>
        <h2 id="intro-title">
          Tu nevera, tus macros y tu dinero <em>por fin hablan entre sí.</em>
        </h2>
      </div>
      <div className="intro-grid">
        <Reveal>
          <article>
            <span className="dot green" />
            <h3>Menos desperdicio</h3>
            <p>Sabes qué tienes y qué caduca. FoodOS te propone usarlo antes de tirarlo.</p>
          </article>
        </Reveal>
        <Reveal delay={80}>
          <article>
            <span className="dot amber" />
            <h3>Mejores decisiones</h3>
            <p>Cenas que usan lo que caduca, cubren tus macros y respetan tu presupuesto. Todo a la vez.</p>
          </article>
        </Reveal>
        <Reveal delay={160}>
          <article>
            <span className="dot blue" />
            <h3>Cuentas claras</h3>
            <p>Cada compra se registra sola. Siempre sabes cuánto llevas gastado en comida esta semana.</p>
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
          Siete módulos, <em>una sola lógica.</em>
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
