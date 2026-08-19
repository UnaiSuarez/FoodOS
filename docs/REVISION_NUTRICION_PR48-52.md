# FoodOS — Revisión del backlog tras los PR 48–52

## Versión del análisis

**Repositorio:** `UnaiSuarez/FoodOS`
**Rama revisada:** `main`
**Commit de referencia:** `f5e19666539228a5eeee8ba017651ae2b78a3644`
**Fecha de revisión:** 30 de julio de 2026

Este documento actualiza y sustituye las partes afectadas del backlog anterior. Las épicas no mencionadas como modificadas conservan sus tickets y prioridades anteriores.

---

# 1. Cambios reales incorporados desde la última revisión

## 1.1. Nuevo modelo de actividad

Ya existe el modelo:

```text
lifestyle_plus_training
```

Separa:

* Actividad cotidiana.
* Días de fuerza.
* Días de cardio.
* Duración media de las sesiones.
* Pasos habituales.
* Gasto medio del entrenamiento.

El usuario puede elegir entre:

* Modelo clásico.
* Modelo nuevo beta.

El perfil muestra qué modelo utiliza y, cuando usa el nuevo, desglosa vida diaria y entrenamiento.

## 1.2. Tendencia de peso suavizada

Ya existe una tendencia basada en:

1. Mediana móvil.
2. EWMA.
3. Regresión lineal.
4. Nivel de confianza según mediciones.

La interfaz muestra:

* Último peso registrado.
* Peso tendencia.
* Cambio semanal estimado.
* Porcentaje semanal.
* Confianza.

Está protegida por pruebas de pérdida, ganancia, mantenimiento, datos antiguos y número insuficiente de registros.

## 1.3. TDEE adaptativo

Ya se calcula:

```text
TDEE observado =
ingesta media − pendiente de peso × 7700
```

Después se combina con el TDEE de la fórmula según la confianza disponible.

La interfaz muestra:

* TDEE inicial.
* TDEE observado.
* TDEE combinado.
* Cobertura de registros.
* Confianza.

El TDEE adaptativo no modifica automáticamente el objetivo.

## 1.4. Propuestas de ajuste explícitas

Ya existe un flujo donde FoodOS puede proponer un ajuste de calorías, pero nunca aplicarlo solo.

Requisitos actuales:

* Confianza alta.
* Al menos 14 días evaluados.
* Cobertura de ingesta mínima del 85 %.
* Desplazamiento mínimo de 50 kcal.
* Ajuste máximo de ±150 kcal.
* Sin propuesta reciente dentro del cooldown.

El usuario debe:

1. Pulsar «Generar propuesta».
2. Revisar la propuesta.
3. Aceptar o rechazar.

El ajuste solo se escribe en el perfil si se acepta explícitamente.

## 1.5. Diagnósticos e invariantes

Ya existe:

* Detección de discrepancia superior al 30 % entre TDEE observado y calculado.
* Bloqueo de propuestas cuando ambos valores discrepan demasiado.
* Diagnóstico con todos los motivos de bloqueo.
* Ventana evaluada.
* Cobertura.
* Mediciones de peso.
* Cambio crudo y suavizado.
* Pendiente de regresión.
* TDEE inicial, observado y combinado.
* Confianza.
* Elegibilidad.
* Fixtures sintéticos.
* Invariantes del motor.
* 96 pruebas superadas.

La nueva suite encontró y corrigió un bug real: el delta se calculaba respecto al objetivo con déficit, en lugar de respecto al desplazamiento del mantenimiento estimado.

---

# 2. Tickets anteriores cuyo estado cambia

## 2.1. Tickets completados

| Ticket anterior                                           | Nuevo estado                           | Motivo                                                            |
| ----------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------- |
| E11-02 — Definir UX del modelo de actividad versionado    | **Hecho**                              | Existe selector Clásico/Nuevo, explicación, persistencia y badge. |
| E11-17 — Crear propuestas de ajuste revisables            | **Hecho**                              | Existen propuesta, aceptar, rechazar y cooldown.                  |
| E11-18 — Mostrar por qué se propone un ajuste             | **Hecho**                              | Existen razones, diagnóstico y motivos simultáneos de bloqueo.    |
| E11-20 — Construir motor adaptativo                       | **Hecho en su primera versión segura** | Calcula TDEE observado y propone cambios explícitos.              |
| E14-07 — Añadir media móvil de peso                       | **Hecho y superado**                   | Utiliza mediana, EWMA y regresión.                                |
| E21-20 — Crear fixtures estables para el motor adaptativo | **Hecho para Nutrición**               | Existe una suite sintética reproducible con invariantes.          |

## 2.2. Tickets parcialmente completados

| Ticket anterior                                    | Estado      | Parte pendiente                                                                                            |
| ----------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------- |
| E11-03 — Diseñar migración del modelo de actividad | **Parcial** | Existe migración manual opt-in, pero no política para sacar el modelo de beta ni migrar perfiles antiguos. |
| E11-05 — Añadir «Ver cálculo»                      | **Parcial** | Hay desglose y diagnóstico, pero está disperso en varios paneles.                                          |
| E11-09 — Mostrar fecha y versión del cálculo       | **Parcial** | Se guardan snapshots y modelo, pero la UI no muestra claramente versión y fecha.                           |
| E11-10 — Crear historial de cálculos               | **Parcial** | Los snapshots existen en Supabase, pero no hay interfaz de historial.                                      |
| E21-06 — Probar cambio de perfil nutricional       | **Parcial** | Hay pruebas unitarias; falta E2E con base de datos y sincronización.                                       |
| E21-07 — Probar bloqueo inferior a 800 kcal        | **Parcial** | Está probado unitariamente; falta prueba E2E.                                                              |

## 2.3. Tickets que siguen pendientes sin cambios

Continúan vigentes:

* Confirmación real del déficit agresivo.
* Dividir Nutrición en pestañas.
* Rangos en lugar de falsa precisión.
* Explicar el campo de sexo fisiológico.
* Objetivos manuales.
* Historial visual de cálculos.
* Restaurar una configuración anterior.
* Lenguaje no moralizante.
* Seguimiento de fibra consumida.
* Objetivo semanal.
* Caducidad de datos físicos.
* Integración de micronutrientes.
* Propuestas y ajustes visibles en Progreso.
* Experiencia simplificada en móvil.

---

# 3. Problemas nuevos detectados

## N1 — La versión del motor continúa siendo `nutrition-v1`

Aunque el motor ha cambiado sustancialmente con:

* Nuevo modelo de actividad.
* Tendencia de peso.
* TDEE adaptativo.
* Propuestas.
* Nuevos guardarraíles.

Los snapshots siguen guardándose con:

```ts
calculationVersion: "nutrition-v1"
```

Esto debilita precisamente el sistema de versionado que se añadió para mantener trazabilidad.

### Riesgo

Dos snapshots con algoritmos diferentes pueden aparecer como creados por la misma versión.

### Acción necesaria

Crear una constante central:

```ts
export const NUTRITION_ENGINE_VERSION = "nutrition-v2";
```

Debe utilizarse en:

* Guardado de perfil.
* Onboarding.
* Revisión adaptativa.
* Propuestas.
* Migraciones.
* Diagnósticos.
* Exportaciones.

---

## N2 — Aceptar una propuesta no es una operación atómica

Actualmente el flujo separa:

1. Actualizar la propuesta en Supabase.
2. Modificar el offset del perfil en estado local.
3. Esperar que la sincronización general guarde posteriormente el perfil.

Esto puede dejar estados incoherentes:

* Propuesta aceptada sin offset aplicado.
* Offset aplicado localmente pero propuesta no resuelta remotamente.
* Propuesta resuelta en un dispositivo y perfil antiguo en otro.
* Cierre de pestaña entre ambas operaciones.

El adaptador remoto confirma o rechaza la propuesta por separado y no modifica el perfil.

### Acción necesaria

Crear una función transaccional en Supabase:

```text
fn_accept_nutrition_adjustment
```

Debe realizar conjuntamente:

* Validar que la propuesta sigue pendiente.
* Validar que pertenece al usuario.
* Comprobar el objetivo actual.
* Aplicar el nuevo offset.
* Resolver la propuesta.
* Crear el snapshot final.
* Actualizar `nutrition_goals`.
* Registrar la fecha del cambio.

---

## N3 — Los errores de Supabase pueden ignorarse

`respondToAdjustmentProposal()` hace `await` sobre la actualización, pero no inspecciona el campo `error` devuelto por Supabase.

Supabase normalmente resuelve la promesa con:

```ts
{ data, error }
```

Un error de base de datos no necesariamente lanza una excepción, por lo que el `catch` actual puede no ejecutarse.

Después, la UI modifica el estado local como si la respuesta hubiera funcionado.

### Acción necesaria

La función debe devolver:

```ts
Promise<
  | { ok: true; proposal: AdjustmentProposal }
  | { ok: false; error: string }
>
```

La UI no puede cambiar el perfil hasta recibir `ok: true`.

---

## N4 — Una propuesta puede quedarse obsoleta

Una propuesta pendiente se calcula usando:

* Peso.
* Ingesta.
* Objetivo.
* TDEE.
* Modelo de actividad.
* Preferencia de macros.
* Offset anterior.

Pero puede permanecer pendiente aunque después el usuario cambie:

* Objetivo corporal.
* Peso.
* Actividad.
* Días de entrenamiento.
* Modelo de actividad.
* Preferencia de macros.
* Objetivo manual.
* Offset adaptativo.

Aceptar después esa propuesta podría aplicar un ajuste generado para otro contexto.

### Acción necesaria

Antes de aceptar:

* Comparar snapshot de la propuesta con el perfil actual.
* Marcar como `stale` si ha cambiado algún dato relevante.
* Impedir aceptar una propuesta obsoleta.
* Ofrecer recalcularla.

---

## N5 — No se reinicia la calibración al cambiar el objetivo

El propio PR 52 deja expresamente fuera:

* Diferenciar la última propuesta resuelta de la última modificación real del objetivo.
* Reiniciar la calibración tras cambiar actividad u objetivo.

Los datos anteriores a un cambio importante pueden no representar el nuevo estado.

Ejemplo:

1. El usuario registra 28 días en mantenimiento.
2. Cambia a pérdida de grasa.
3. El motor sigue mezclando los datos anteriores.
4. Puede generar una propuesta basada en dos regímenes distintos.

### Acción necesaria

Añadir:

```ts
lastTargetChangedAt
adaptiveCalibrationStartedAt
```

La ventana adaptativa debe comenzar después del último cambio relevante.

---

## N6 — El umbral fijo de 500 kcal es insuficiente

Un día se considera registrado si llega a 500 kcal.

Esto puede funcionar para detectar días completamente vacíos, pero no garantiza que el día esté completo.

Ejemplo:

* Objetivo: 2.600 kcal.
* Usuario registra solamente desayuno y comida: 1.200 kcal.
* El día cuenta como completo.
* El TDEE observado interpreta que comió 1.200 kcal.
* El resultado adaptativo puede desviarse mucho.

La cobertura del motor actual utiliza precisamente ese umbral de 500 kcal.

### Acción necesaria

Crear un modelo de completitud más robusto:

* Confirmación «Día completo».
* Porcentaje respecto al objetivo.
* Número de comidas registradas.
* Hora del último registro.
* Días excluidos manualmente.
* Umbral mínimo relativo, no exclusivamente absoluto.

Hasta entonces, las propuestas deben seguir considerándose beta.

---

## N7 — La confianza depende demasiado del número de pesos

Actualmente la confianza se basa principalmente en el número de mediciones:

* 3–6: baja.
* 7–13: moderada.
* 14 o más: alta.

Pero 14 mediciones no garantizan por sí solas alta calidad.

También importan:

* Duración real cubierta.
* Separación entre mediciones.
* Errores residuales de la regresión.
* Variabilidad.
* Cambios bruscos.
* Datos duplicados.
* R² o calidad del ajuste.

### Acción necesaria

La confianza debería combinar:

```text
cantidad de datos
+ cobertura temporal
+ regularidad
+ ajuste estadístico
+ ruido residual
+ completitud de ingesta
```

---

## N8 — Los pasos habituales se guardan pero no se utilizan

El nuevo formulario solicita pasos diarios habituales.

Sin embargo:

* El modelo `lifestyle_plus_training` no los incorpora al cálculo.
* El TDEE adaptativo tampoco los utiliza directamente.
* El usuario puede creer que están afectando al resultado.

El PR 48 indica que se capturan para un uso posterior.

### Acción necesaria

Una de estas opciones:

1. Ocultar el campo hasta utilizarlo.
2. Mostrar claramente «guardado como referencia; todavía no afecta al cálculo».
3. Incorporarlo al modelo tras validar cómo evitar doble conteo con actividad cotidiana.

---

## N9 — Los valores predeterminados siguen siendo peligrosos

El perfil nuevo continúa mostrando por defecto:

* 25 años.
* 175 cm.
* 75 kg.

El modelo de actividad nuevo también propone:

* 3 días de fuerza.
* 0 de cardio.
* 60 minutos.

Un usuario puede guardar valores plausibles pero incorrectos sin darse cuenta.

### Acción necesaria

Para usuarios sin perfil:

* Campos físicos vacíos.
* Botón deshabilitado hasta completar.
* Sin entrenamiento predeterminado o con etiqueta «propuesta».
* Resumen final antes de guardar.

---

## N10 — El aviso de déficit agresivo todavía no es una confirmación

Cuando se detecta un déficit superior al 30 %, el código muestra un toast, pero continúa guardando el perfil.

Por tanto, el requisito de «exige confirmación» no está realmente implementado: informa, pero no pide una decisión explícita.

### Acción necesaria

Mostrar un diálogo persistente:

> Este objetivo equivale aproximadamente al 68 % de tu mantenimiento estimado. Es un déficit agresivo. Revisa los datos antes de continuar.

Acciones:

* Volver a editar.
* Continuar igualmente.
* Cancelar.

La confirmación debe quedar registrada en el snapshot.

---

## N11 — Un ajuste aceptado puede cruzar un umbral de advertencia

La aceptación automática solo rechaza cuando el resultado queda por debajo de 800 kcal.

Si el ajuste:

* Queda por debajo del 70 % del TDEE.
* Queda por debajo de la TMB.
* Produce otro warning.

Puede aplicarse y mostrar el aviso después.

### Acción necesaria

Antes de aceptar:

* Ejecutar guardarraíles.
* Mostrar el resultado.
* Solicitar confirmación si aparece un warning nuevo.
* Bloquear solo los casos no permitidos.
* Registrar qué advertencia se aceptó.

---

## N12 — La creación de snapshot y propuesta no es transaccional

`createAdjustmentReview()`:

1. Inserta el snapshot.
2. Inserta después la propuesta.

Si el segundo paso falla, queda un snapshot de revisión sin propuesta asociada.

Además, el método inserta primero el snapshot y comprueba después `decision.shouldPropose`, aunque actualmente la UI solo lo llama cuando procede.

### Acción necesaria

* Comprobar `shouldPropose` antes de insertar.
* Utilizar una función SQL transaccional.
* Devolver el snapshot y propuesta creados.
* Evitar registros huérfanos o documentarlos expresamente como revisiones sin propuesta.

---

## N13 — La evidencia de la propuesta está vacía

La fila de propuesta se crea con:

```ts
evidence: {}
```

Aunque el motor ya calcula:

* Cobertura.
* Pesos.
* Pendiente.
* Confianza.
* TDEE.
* Diagnósticos.
* Advertencias.

### Acción necesaria

Guardar como evidencia:

```ts
{
  evaluationWindow,
  intakeCoverage,
  averageIntake,
  weightMeasurements,
  weightTrend,
  regressionSlope,
  confidence,
  initialTdee,
  observedTdee,
  combinedTdee,
  warnings,
  engineVersion
}
```

Así la propuesta sigue siendo auditable aunque el algoritmo futuro cambie.

---

## N14 — Falta snapshot del objetivo finalmente aceptado

Existe:

* Snapshot de revisión.
* Propuesta.
* Resolución aceptada o rechazada.

Pero no se crea claramente un nuevo snapshot del objetivo final después de aceptar el ajuste.

### Acción necesaria

Al aceptar:

* Crear snapshot con `triggerReason: "adaptive_adjustment_accepted"`.
* Guardar el objetivo resultante.
* Guardar el offset total.
* Enlazar `nutrition_goals.source_snapshot_id`.
* Enlazar la propuesta al snapshot final.
* Conservar el snapshot de revisión original.

---

## N15 — La etiqueta «Mifflin-St Jeor» puede inducir a error

El panel muestra el TDEE inicial como:

> kcal (Mifflin-St Jeor)

Pero Mifflin-St Jeor calcula la TMB.

El TDEE mostrado incluye además:

* Factor de actividad.
* O actividad cotidiana.
* Entrenamiento habitual.

### Acción necesaria

Cambiar a:

> Estimación inicial basada en Mifflin-St Jeor y tu actividad declarada.

Y permitir desplegar:

* TMB.
* Factor cotidiano.
* Entrenamiento.
* TDEE final.

---

## N16 — La sección Nutrición ha crecido demasiado

Ahora contiene secuencialmente:

* Perfil.
* Resumen de hoy.
* Semana de macros.
* Adherencia.
* Optimizador de proteína.
* Historial de peso.
* Tendencia suavizada.
* TDEE adaptativo.
* Propuesta adaptativa.
* Proyección de peso.

El nuevo motor mejora muchísimo el producto, pero agrava el problema de arquitectura de información.

### Acción necesaria

Dividir en:

### Hoy

* Objetivo.
* Consumido.
* Fibra.
* Recomendación.

### Objetivos

* Perfil.
* Modelo de actividad.
* Cálculo.
* Macros.
* Guardarraíles.

### Peso

* Historial.
* Tendencia.
* Proyección.

### Adaptativo

* TDEE observado.
* Cobertura.
* Diagnóstico.
* Propuestas.
* Historial.

---

# 4. Backlog nutricional actualizado

## ÉPICA E11 — Nutrición y motor adaptativo

### E11-A — Integridad crítica

| ID     |  P | Esf. | Ticket                                            | Criterios de aceptación                                                                      |
| ------ | -: | ---: | -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| E11-01 | P0 |    M | Implementar confirmación real de déficit agresivo | El perfil no se guarda hasta que el usuario confirme expresamente.                           |
| E11-02 | P0 |    S | Centralizar y actualizar versión del motor        | Todos los snapshots usan una constante única y una versión que representa el algoritmo real. |
| E11-03 | P0 |    L | Hacer atómica la aceptación de propuestas         | Propuesta, perfil, snapshot y objetivo se actualizan en una única transacción.               |
| E11-04 | P0 |    M | Manejar errores de Supabase correctamente         | La UI no cambia el estado local si la operación remota falla.                                |
| E11-05 | P0 |    M | Invalidar propuestas obsoletas                    | Una propuesta no puede aceptarse después de cambiar perfil u objetivo.                       |
| E11-06 | P0 |    M | Reiniciar calibración tras cambios relevantes     | Solo se usan datos posteriores al último cambio de objetivo o actividad.                     |
| E11-07 | P0 |    L | Mejorar la definición de día completo             | El motor no depende exclusivamente del umbral fijo de 500 kcal.                              |
| E11-08 | P0 |    M | Confirmar warnings al aceptar ajustes             | Los avisos nuevos deben revisarse antes de aplicar el cambio.                                |
| E11-09 | P0 |    M | Eliminar valores físicos predeterminados          | No se pueden guardar datos inventados accidentalmente.                                       |
| E11-10 | P0 |    M | Crear snapshot final del ajuste aceptado          | El objetivo vigente queda enlazado con el cálculo que lo produjo.                            |

### E11-B — Ciclo de vida adaptativo

| ID     |  P | Esf. | Ticket                                           | Criterios de aceptación                                        |
| ------ | -: | ---: | --------------------------------------------------- | ------------------------------------------------------------------ |
| E11-11 | P1 |    M | Separar fechas de propuesta y cambio de objetivo | Existen `lastProposalResolvedAt` y `lastTargetChangedAt`.      |
| E11-12 | P1 |    M | Añadir `adaptiveCalibrationStartedAt`            | La ventana adaptativa tiene un comienzo explícito.             |
| E11-13 | P1 |    M | Persistir evidencia completa                     | La propuesta conserva todos los datos usados para decidir.     |
| E11-14 | P1 |    M | Hacer transaccional la generación                | Snapshot y propuesta se crean juntos.                          |
| E11-15 | P1 |    M | Añadir estado de propuesta obsoleta              | El esquema admite `stale` o cancelación equivalente.           |
| E11-16 | P1 |    M | Resolver propuestas pendientes al cambiar perfil | Se cancelan o recalculan de forma explícita.                   |
| E11-17 | P1 |    M | Añadir historial de propuestas                   | Se ven fecha, motivo, decisión y resultado.                    |
| E11-18 | P1 |    M | Permitir revisar un ajuste anterior              | Puede consultarse, pero no reaplicarse silenciosamente.        |
| E11-19 | P1 |    M | Explicar el cooldown                             | La UI muestra fecha de última decisión y próxima revisión.     |
| E11-20 | P1 |    M | Mejorar experiencia offline                      | El botón se deshabilita o explica que requiere sincronización. |

### E11-C — Calidad estadística

| ID     |  P | Esf. | Ticket                                       | Criterios de aceptación                                                  |
| ------ | -: | ---: | ----------------------------------------------- | ------------------------------------------------------------------------ |
| E11-21 | P1 |    L | Mejorar score de confianza                   | Considera cantidad, duración, regularidad y ruido.                       |
| E11-22 | P1 |    M | Incorporar calidad de regresión              | Se calcula ajuste o residuo y afecta a la confianza.                     |
| E11-23 | P1 |    M | Detectar mediciones agrupadas                | Muchas mediciones en pocos días no producen confianza alta.              |
| E11-24 | P1 |    M | Detectar saltos fisiológicamente improbables | Se bloquean propuestas ante cambios bruscos no estabilizados.            |
| E11-25 | P1 |    M | Permitir excluir periodos                    | Enfermedad, viajes o creatina pueden excluirse de la calibración.        |
| E11-26 | P1 |    M | Revisar la constante 7700                    | Se documenta como aproximación y se valida con datos reales.             |
| E11-27 | P1 |    M | Añadir rango al TDEE adaptativo              | Se muestra intervalo o margen, no solo un número.                        |
| E11-28 | P2 |    M | Permitir ventana configurable internamente   | Puede probarse 21, 28 o 42 días mediante feature flag.                   |
| E11-29 | P2 |    M | Evaluar diferencia entre objetivos           | La lógica se valida por pérdida, mantenimiento, recomposición y volumen. |
| E11-30 | P2 |    M | Analizar sesgo por registros incompletos     | Se mide con datos sintéticos y datos reales anonimizados.                |

### E11-D — Modelo de actividad

| ID     |  P | Esf. | Ticket                                         | Criterios de aceptación                                                   |
| ------ | -: | ---: | ------------------------------------------------- | ----------------------------------------------------------------------------- |
| E11-31 | P1 |    M | Definir salida de beta del modelo nuevo        | Se fijan requisitos para hacerlo recomendado o predeterminado.            |
| E11-32 | P1 |    M | Diseñar migración de perfiles clásicos         | Ningún perfil cambia de cálculo sin consentimiento.                       |
| E11-33 | P1 |    S | Aclarar que los pasos aún no se usan           | La interfaz no induce a pensar que afectan al objetivo.                   |
| E11-34 | P1 |    M | Decidir el papel de los pasos habituales       | Se incorporan con validación o se eliminan del formulario.                |
| E11-35 | P1 |    M | Eliminar defaults de entrenamiento silenciosos | Días y duración deben confirmarse.                                        |
| E11-36 | P1 |    M | Validar combinaciones imposibles               | Fuerza + cardio y duración deben permanecer dentro de límites razonables. |
| E11-37 | P1 |    M | Explicar doble conteo                          | La ayuda muestra por qué el entrenamiento no se suma cada día.            |
| E11-38 | P2 |    M | Comparar clásico y nuevo antes de cambiar      | Se muestra el impacto estimado en TDEE y objetivos.                       |
| E11-39 | P2 |    M | Registrar motivo del cambio de modelo          | El snapshot conserva quién y por qué lo cambió.                           |

### E11-E — Interfaz y comprensión

| ID     |  P | Esf. | Ticket                               | Criterios de aceptación                                           |
| ------ | -: | ---: | --------------------------------------- | ------------------------------------------------------------------- |
| E11-40 | P1 |    L | Dividir Nutrición en cuatro pestañas | Hoy, Objetivos, Peso y Adaptativo.                                |
| E11-41 | P1 |    M | Crear un único «Ver cálculo»         | Todo el desglose se consulta desde un punto coherente.            |
| E11-42 | P1 |    M | Mostrar versión y fecha del cálculo  | El usuario conoce cuándo y con qué versión se calculó.            |
| E11-43 | P1 |    M | Corregir etiqueta Mifflin/TDEE       | La UI diferencia claramente TMB y TDEE.                           |
| E11-44 | P1 |    M | Mostrar rangos recomendados          | Kcal, proteína y tendencia incluyen margen.                       |
| E11-45 | P1 |    M | Explicar el sexo fisiológico         | Se explica que solo se utiliza en la fórmula energética.          |
| E11-46 | P1 |    M | Añadir objetivos manuales            | El usuario puede sustituir el cálculo automático conscientemente. |
| E11-47 | P1 |    M | Crear historial de snapshots         | Se ven versiones, entradas, resultados y trigger.                 |
| E11-48 | P1 |    M | Permitir restaurar configuración     | Restaurar crea un nuevo snapshot, no modifica el histórico.       |
| E11-49 | P1 |    M | Mostrar fibra consumida              | No solo la recomendación.                                         |
| E11-50 | P1 |    M | Crear objetivo y adherencia semanal  | Reduce la importancia excesiva de un único día.                   |
| E11-51 | P1 |    M | Revisar todo el lenguaje             | No moraliza variaciones ni desviaciones.                          |
| E11-52 | P2 |    M | Añadir fecha de caducidad del perfil | Solicita revisar peso y actividad periódicamente.                 |
| E11-53 | P2 |    M | Mostrar fuente de cada valor         | Fórmula, perfil, diario, tendencia o estimación.                  |
| E11-54 | P2 |    M | Añadir ayuda contextual              | Cada concepto técnico tiene una explicación breve.                |
| E11-55 | P2 |    M | Permitir modo simplificado           | Oculta diagnósticos avanzados a quien no los necesite.            |

---

# 5. Cambios en otras épicas

## ÉPICA E14 — Progreso

### Marcar como hecho

| Ticket                              | Estado                                               |
| -------------------------------------- | ------------------------------------------------------- |
| E14-07 — Añadir media móvil de peso | Hecho mediante tendencia mediana + EWMA + regresión. |

### Nuevos tickets

| ID     |  P | Esf. | Ticket                                        | Criterios de aceptación                                    |
| ------ | -: | ---: | ------------------------------------------------- | -------------------------------------------------------------- |
| E14-17 | P1 |    M | Reutilizar la tendencia suavizada en Progreso | Nutrición y Progreso no calculan tendencias distintas.     |
| E14-18 | P1 |    M | Mostrar confianza en los gráficos             | Una línea con pocos datos no parece igual de fiable.       |
| E14-19 | P1 |    M | Mostrar eventos de cambio de objetivo         | Los gráficos marcan cuándo cambió dieta o actividad.       |
| E14-20 | P1 |    M | Mostrar ajustes adaptativos aceptados         | Se visualizan sobre la evolución de peso y calorías.       |
| E14-21 | P2 |    M | Comparar objetivo inicial y adaptativo        | Se observa cómo ha evolucionado el mantenimiento estimado. |

---

## ÉPICA E20 — Seguridad y observabilidad

### Añadir

| ID     |  P | Esf. | Ticket                                     | Criterios de aceptación                                             |
| ------ | -: | ---: | --------------------------------------------- | ------------------------------------------------------------------------ |
| E20-21 | P0 |    M | Observar errores de propuestas adaptativas | Los fallos no quedan únicamente en `console.warn`.                  |
| E20-22 | P0 |    M | Auditar RLS de snapshots y propuestas      | No pueden alterarse o leerse entre usuarios.                        |
| E20-23 | P0 |    M | Probar concurrencia al aceptar propuestas  | Dos dispositivos no pueden aceptar la misma propuesta dos veces.    |
| E20-24 | P1 |    M | Crear métricas del motor adaptativo        | Bloqueos, propuestas, aceptación, rechazo y discrepancias.          |
| E20-25 | P1 |    S | Añadir identificadores de operación        | Una propuesta y sus snapshots pueden trazarse conjuntamente.        |
| E20-26 | P1 |    M | Alertar de snapshots huérfanos             | Una tarea detecta revisiones sin propuesta o sin objetivo enlazado. |

---

## ÉPICA E21 — Pruebas

### Estado actualizado

La suite del motor ha crecido hasta 96 pruebas e incluye fixtures e invariantes. Esto es una mejora importante, pero no reemplaza los E2E de persistencia y sincronización.

### Añadir

| ID     |  P | Esf. | Ticket                          | Criterios de aceptación                                |
| ------ | -: | ---: | ---------------------------------- | ---------------------------------------------------------- |
| E21-22 | P0 |    M | E2E generar y aceptar propuesta | Comprueba Supabase, perfil, snapshot y objetivo final. |
| E21-23 | P0 |    M | E2E fallo remoto al aceptar     | El estado local no cambia.                             |
| E21-24 | P0 |    M | E2E propuesta obsoleta          | Cambiar perfil impide aceptar la anterior.             |
| E21-25 | P0 |    M | E2E cambio de objetivo y reset  | La calibración empieza después del cambio.             |
| E21-26 | P0 |    M | E2E déficit agresivo            | Requiere confirmación real.                            |
| E21-27 | P1 |    M | Test de versión de snapshots    | Cada trigger utiliza la versión central.               |
| E21-28 | P1 |    M | Test de días incompletos        | No generan propuestas erróneas.                        |
| E21-29 | P1 |    M | Test de mediciones agrupadas    | No producen confianza alta indebidamente.              |
| E21-30 | P1 |    M | Test de concurrencia            | Solo una aceptación puede triunfar.                    |
| E21-31 | P1 |    M | Test de snapshot final          | El objetivo aceptado queda trazable.                   |
| E21-32 | P1 |    M | Test de migración clásico/nuevo | Cambiar de modelo no corrompe perfiles ni histórico.   |

---

## ÉPICA E22 — Onboarding

El onboarding sigue utilizando el modelo clásico, intencionadamente, pero conserva valores físicos predeterminados.

### Mantener como P0

| Ticket                                    | Estado                             |
| -------------------------------------------- | ------------------------------------- |
| E22-01 — Vaciar datos físicos precargados | Pendiente y confirmado nuevamente. |

### Añadir

| ID     |  P | Esf. | Ticket                               | Criterios de aceptación                                                 |
| ------ | -: | ---: | ---------------------------------------- | ----------------------------------------------------------------------------- |
| E22-13 | P1 |    M | Explicar el modelo clásico inicial   | El usuario sabe que podrá mejorar la precisión posteriormente.          |
| E22-14 | P1 |    M | Ofrecer calibración avanzada después | Se invita al nuevo modelo tras completar la activación principal.       |
| E22-15 | P1 |    M | No pedir más datos de los necesarios | El onboarding no incluye diagnóstico adaptativo prematuramente.         |
| E22-16 | P2 |    M | Crear checklist de calibración       | Peso, diario y actividad muestran cuánto falta para el TDEE adaptativo. |

---

# 6. Estado de todas las épicas tras la revisión

| Épica                          | Estado de la revisión                                                 |
| --------------------------------- | -------------------------------------------------------------------------- |
| E00 — Estrategia               | Sin cambios de código; backlog vigente.                               |
| E01 — Rutas                    | Sin implementar; backlog vigente.                                     |
| E02 — Auth y carga             | Sin cambios; backlog vigente.                                         |
| E03 — Sistema de diseño        | Sin cambios; backlog vigente.                                         |
| E04 — Navegación móvil         | Sin cambios; backlog vigente.                                         |
| E05 — Dashboard                | Sin cambios estructurales; backlog vigente.                           |
| E06 — Diario                   | Sin cambios; backlog vigente.                                         |
| E07 — Inventario               | Sin cambios posteriores al corte; backlog vigente.                    |
| E08 — Recetas                  | Sin cambios posteriores al corte; backlog vigente.                    |
| E09 — Planificador             | Sin cambios; backlog vigente.                                         |
| E10 — Lista de compra          | Sin cambios; backlog vigente.                                         |
| **E11 — Nutrición**            | **Reescrita completamente en esta revisión.**                         |
| E12 — Entrenamientos           | Sin cambios salvo integración indirecta del perfil de actividad.      |
| E13 — Finanzas                 | Sin cambios; backlog vigente.                                         |
| **E14 — Progreso**             | Tendencia suavizada completada; añadida integración adaptativa.       |
| E15 — Asistente                | Sin cambios; backlog vigente.                                         |
| E16 — Feed                     | Sin cambios; backlog vigente.                                         |
| E17 — Ajustes                  | Sin cambios directos; deberá alojar versión e historial nutricional.  |
| E18 — Accesibilidad            | Sin cambios; el nuevo contenido deberá incluirse en la auditoría.     |
| E19 — Offline y sincronización | Sin cambios; ahora también afecta a propuestas adaptativas.           |
| **E20 — Seguridad**            | Añadidos atomicidad, concurrencia y observabilidad adaptativa.        |
| **E21 — Pruebas**              | Mejorada suite unitaria; añadidos E2E de persistencia y concurrencia. |
| **E22 — Onboarding**           | Reconfirmados defaults y modelo clásico inicial.                      |
| E23 — Contenido                | Añadir explicaciones del modelo adaptativo; resto vigente.            |
| E24 — Analítica                | Añadir métricas de propuestas; resto vigente.                         |
| E25 — Futuro                   | Motor adaptativo deja de ser futuro y pasa a producto beta actual.    |

---

# 7. Orden actualizado de implementación

## Siguiente PR recomendado: PR 8

### Integridad transaccional y versionado

Debe incluir:

1. Constante central de versión.
2. Nueva versión del motor.
3. RPC transaccional para aceptar propuestas.
4. Comprobación de errores de Supabase.
5. Snapshot final del ajuste.
6. Evidencia de la propuesta.
7. Prevención de doble aceptación.
8. Tests de error y concurrencia.

## PR 9

### Ciclo de calibración y propuestas obsoletas

Debe incluir:

1. `lastTargetChangedAt`.
2. `adaptiveCalibrationStartedAt`.
3. Invalidar propuestas pendientes.
4. Reset tras cambiar objetivo.
5. Reset tras cambiar modelo de actividad.
6. Reset tras cambiar actividad.
7. Mostrar periodo realmente evaluado.
8. Tests correspondientes.

## PR 10

### Calidad de datos adaptativos

Debe incluir:

1. Sustituir o reforzar el umbral de 500 kcal.
2. Estado «día completo».
3. Score de confianza mejorado.
4. Calidad de regresión.
5. Detección de datos agrupados.
6. Exclusión de periodos.
7. Rango de TDEE adaptativo.

## PR 11

### Seguridad y UX nutricional

Debe incluir:

1. Confirmación real de déficit agresivo.
2. Confirmación de warnings en ajustes.
3. Campos físicos vacíos.
4. Campos de actividad sin defaults silenciosos.
5. Aclaración sobre pasos.
6. Corrección de etiquetas TMB/TDEE.
7. Mostrar versión y fecha.

## PR 12

### Reorganización de Nutrición

Debe incluir:

1. Hoy.
2. Objetivos.
3. Peso.
4. Adaptativo.
5. Historial de cálculos.
6. Historial de propuestas.
7. Modo simplificado.
8. Diagnóstico avanzado colapsable.

---

# 8. Prioridad global después de los cambios

El motor nutricional ya no necesita otra capa de inteligencia inmediatamente.

Necesita:

1. **Integridad transaccional.**
2. **Versionado correcto.**
3. **Calidad de los datos de entrada.**
4. **Ciclo de vida de calibración.**
5. **Confirmaciones reales de seguridad.**
6. **Mejor arquitectura de interfaz.**
7. **E2E con Supabase y varios dispositivos.**

Después de PR 8–12, la prioridad debería volver al backlog global:

* Rutas reales.
* Skeleton de autenticación.
* Navegación agrupada.
* Barra inferior móvil.
* Design system.
* Registro rápido de comidas.
* Valores falsos del inventario.
* Flujo de finalizar compra.
* Privacidad del asistente.
* Feed/Inspiración.
* Validación de importaciones.
* Accesibilidad.

---

# 9. Conclusión revisada

Los cambios recientes mejoran muchísimo la parte técnicamente más delicada de FoodOS.

El motor ahora:

* Distingue actividad cotidiana y entrenamiento.
* Suaviza el peso.
* Calcula mantenimiento observado.
* Combina fórmula y datos.
* Controla confianza y cobertura.
* Propone ajustes pequeños.
* Requiere aceptación.
* Aplica cooldown.
* Bloquea discrepancias graves.
* Explica por qué no puede ajustar.
* Tiene fixtures e invariantes.

Sin embargo, el siguiente riesgo ya no es «que el cálculo sea demasiado simple».

El siguiente riesgo es:

> Que un motor matemáticamente bueno produzca un estado incoherente porque la propuesta, el perfil, el snapshot y Supabase no se actualizaron juntos.

Por eso el próximo paso no debe añadir más fórmulas. Debe cerrar:

* Atomicidad.
* Versionado.
* Errores remotos.
* Propuestas obsoletas.
* Resets de calibración.
* Completitud del diario.
* Confirmaciones reales.
* Trazabilidad final.

El cerebro del motor ya está bastante bien. Ahora toca asegurarse de que el sistema nervioso no mande «aceptado» a Supabase, «fallido» al perfil y «todo perfecto» al toast.
