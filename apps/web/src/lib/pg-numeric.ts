// Valor CANÓNICO que PostgreSQL persiste en una columna numeric(p,2).
//
// Las columnas `*_per_100` y `unit_size` de `inventory_items` son numeric(…,2):
// la base redondea al guardar. Comparar el número que envió el cliente con el que
// vuelve de la base exige compararlos en la misma representación. Una banda de
// tolerancia alrededor del valor original no vale: una modificación real de 0,01
// (165,0051 → guardado como 165,01; un cliente antiguo escribe 165,00) cae dentro
// de cualquier banda lo bastante ancha para aceptar el redondeo inicial.
//
// Cómo redondea PostgreSQL (verificado en un Postgres real aislado, ver
// docs/NUTRITION_V4_DATA_INTEGRITY_DESIGN.md §19.7): el JSON llega como TEXTO
// decimal (el de JSON.stringify, que es el de String(n): el más corto que vuelve
// a leerse como el mismo double) y se convierte a numeric con redondeo «half away
// from zero» SOBRE ESE TEXTO. No sobre el double: 1.005 es 1.00499999999999989… en
// binario, `Math.round(1.005 * 100) / 100` da 1, pero Postgres, que recibe el
// texto «1.005», guarda 1,01. Por eso se redondea la representación decimal, no
// el número.

/** Representación decimal plana (sin notación exponencial) de un número ≥ 0. */
function plainDecimal(abs: number): { int: string; frac: string } {
  let s = String(abs);
  const exponentAt = s.search(/e/i);
  if (exponentAt !== -1) {
    const mantissa = s.slice(0, exponentAt);
    const exponent = Number(s.slice(exponentAt + 1));
    const dot = mantissa.indexOf(".");
    const digits = mantissa.replace(".", "");
    const pointAt = (dot === -1 ? mantissa.length : dot) + exponent;
    if (pointAt <= 0) s = `0.${"0".repeat(-pointAt)}${digits}`;
    else if (pointAt >= digits.length) s = digits + "0".repeat(pointAt - digits.length);
    else s = `${digits.slice(0, pointAt)}.${digits.slice(pointAt)}`;
  }
  const [int, frac = ""] = s.split(".");
  return { int, frac };
}

/**
 * El valor que devuelve PostgreSQL tras guardar `value` en una columna
 * numeric(p,2): redondeo a 2 decimales, mitad hacia arriba en valor absoluto,
 * sobre la representación decimal del número. Un valor no finito se devuelve tal
 * cual (el llamador ya no lo trata como un número válido).
 */
export function canonicalNumeric2(value: number): number {
  if (!Number.isFinite(value)) return value;
  const { int, frac } = plainDecimal(Math.abs(value));
  const digits = (int + (frac + "00").slice(0, 2)).split("").map(Number);
  if (frac.length > 2 && frac.charCodeAt(2) >= 53 /* '5' */) {
    for (let i = digits.length - 1; i >= 0; i--) {
      if (digits[i] === 9) digits[i] = 0;
      else {
        digits[i] += 1;
        break;
      }
      if (i === 0) digits.unshift(1);
    }
  }
  const cents = digits.join("").padStart(3, "0");
  const magnitude = Number(`${cents.slice(0, -2)}.${cents.slice(-2)}`);
  return value < 0 && magnitude !== 0 ? -magnitude : magnitude;
}
