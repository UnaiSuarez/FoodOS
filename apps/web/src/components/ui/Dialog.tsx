"use client";

// E03-14: el criterio de aceptación pide un componente "Dialog" en el
// sistema de diseño — ya existe, es Modal.tsx (foco atrapado, Escape,
// devolución de foco al cerrar, role="dialog"/aria-modal/aria-label). En
// vez de duplicarlo, se re-exporta aquí con el nombre del sistema de
// diseño para que quien busque "componentes base" lo encuentre junto al
// resto sin tener que saber que vive en components/dashboard/Modal.tsx.
export { Modal as Dialog } from "@/components/dashboard/Modal";
