import { Reveal } from "./Reveal";

const STEPS = [
  {
    title: "Añade tu despensa",
    copy: "A mano, escaneando el código de barras o con una foto en masa. Los datos nutricionales se rellenan solos.",
  },
  {
    title: "Configura tu perfil",
    copy: "Peso, altura y objetivo. FoodOS calcula tu TMB, TDEE y te asigna macros diarios adaptados a ti.",
  },
  {
    title: "Cocina, come y registra",
    copy: "Recetas filtradas por lo que tienes en casa. Anota cada comida en el diario y controla el agua.",
  },
  {
    title: "La IA lo conecta todo",
    copy: "El asistente sugiere la cena, la lista de compra se genera sola y tus cuentas se cuadran al finalizar la compra.",
  },
];

export function HowItWorks() {
  return (
    <section id="como-funciona" className="section flow" aria-labelledby="flow-title">
      <div className="section-heading">
        <p className="eyebrow">Cómo funciona</p>
        <h2 id="flow-title">
          De la nevera a la mesa <em>sin cambiar de app.</em>
        </h2>
      </div>
      <ol className="steps">
        {STEPS.map((step, index) => (
          <Reveal key={step.title} delay={index * 90}>
            <li>
              <span>{index + 1}</span>
              <h3>{step.title}</h3>
              <p>{step.copy}</p>
            </li>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}
