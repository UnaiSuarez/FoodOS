"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("FoodOS view error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <section className="view view-error-fallback">
          <div className="panel view-error-panel">
            <p className="eyebrow">Error en la vista</p>
            <h2>Algo salió mal</h2>
            <p className="form-intro">
              Esta pantalla ha encontrado un error inesperado. El resto de la app
              sigue funcionando con normalidad — cambia de sección o pulsa "Reintentar".
            </p>
            <button
              className="secondary-button"
              onClick={() => this.setState({ error: null })}
            >
              Reintentar
            </button>
            <details className="view-error-details">
              <summary>Detalles técnicos</summary>
              <pre>{this.state.error.message}</pre>
            </details>
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}
