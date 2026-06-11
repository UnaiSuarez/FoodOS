import { Reveal } from "./Reveal";

const STEPS = [
  {
    title: "Añade tus alimentos",
    copy: "A mano, escaneando el código de barras o con una foto. Tres segundos por producto.",
  },
  {
    title: "Cuéntale tu objetivo",
    copy: "Perder grasa, ganar músculo o mantenerte. FoodOS calcula tus calorías y macros diarios.",
  },
  {
    title: "Cocina con cabeza",
    copy: "Recetas ordenadas por lo que tienes en casa, lo que te falta por comer y lo que cuestan.",
  },
  {
    title: "Compra sin pensar",
    copy: "La lista se hace sola, y al completar la compra se actualizan tu despensa y tus cuentas.",
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
