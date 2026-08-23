import { Prisma } from '@prisma/client';

// Helpers de Decimal y redondeo comercial — BLUEPRINT §9.3 (AD-14) y §5.3
// (AD-18). Nunca usar `number` para operar plata (0.1 + 0.2 no da 0.3 en
// punto flotante); todo acá entra y sale como `Prisma.Decimal`.
//
// Cubren las reglas 1, 3 y 5 de §9.3 como primitivas componibles — no
// arman el cálculo completo de una venta (eso es responsabilidad de
// `sales`, que todavía no existe): regla 2 (`subtotal` = suma de líneas)
// y regla 4 (`total = subtotal − descuento_total + ajuste_redondeo`) son
// sumas/restas simples que no necesitan un helper propio.

export type DecimalInput = Prisma.Decimal.Value;

// Redondeo comercial (medio hacia arriba) a 2 decimales. Sin pasar el modo
// de redondeo a mano, decimal.js usa la config global del proceso — que
// puede cambiar en cualquier otro lado del código. Acá siempre se explicita.
export function roundCurrency(value: DecimalInput): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(
    2,
    Prisma.Decimal.ROUND_HALF_UP,
  );
}

// Regla 1 de §9.3: subtotal de una línea, redondeado.
export function lineSubtotal(
  cantidad: number,
  precioUnitario: DecimalInput,
): Prisma.Decimal {
  return roundCurrency(new Prisma.Decimal(precioUnitario).times(cantidad));
}

// Regla 3 de §9.3: un descuento (u otro porcentaje, como el de la
// actualización masiva de precios) se calcula sobre una base y se
// redondea a 2 decimales **antes** de acumularse en otro cálculo — nunca
// se acumulan porcentajes sin redondear entre pasos intermedios.
export function applyPercentage(
  base: DecimalInput,
  percentage: DecimalInput,
): Prisma.Decimal {
  return roundCurrency(
    new Prisma.Decimal(base).times(percentage).dividedBy(100),
  );
}

// Regla 5 de §9.3 / AD-18: prorratea `total` entre `lineAmounts` según el
// peso de cada línea sobre su propio subtotal (suma de `lineAmounts`),
// redondeando cada `neto_linea` — y ajusta el residuo de redondeo
// (`total − SUM(neto_linea)`) en la línea de mayor `neto_linea`, con
// desempate por menor índice (quien llama pasa las líneas ya ordenadas
// por id, igual que las va a persistir).
//
// Es el paso donde se pierde o se inventa un centavo si dos personas lo
// implementan distinto (BLUEPRINT §9.3) — por eso el resultado siempre
// cumple `SUM(resultado) === total` exacto, nunca aproximado.
export function prorate(
  lineAmounts: DecimalInput[],
  total: DecimalInput,
): Prisma.Decimal[] {
  const amounts = lineAmounts.map((amount) => new Prisma.Decimal(amount));
  const subtotal = amounts.reduce(
    (sum, amount) => sum.plus(amount),
    new Prisma.Decimal(0),
  );
  const totalDecimal = new Prisma.Decimal(total);

  if (subtotal.isZero()) {
    throw new Error(
      'No se puede prorratear un total sobre líneas cuyo subtotal es 0',
    );
  }

  const netos = amounts.map((amount) =>
    roundCurrency(amount.times(totalDecimal).dividedBy(subtotal)),
  );

  const sumNetos = netos.reduce(
    (sum, neto) => sum.plus(neto),
    new Prisma.Decimal(0),
  );
  const residuo = totalDecimal.minus(sumNetos);

  if (residuo.isZero()) {
    return netos;
  }

  // Primer máximo estricto: en un empate, se queda con el de menor índice.
  let maxIndex = 0;
  for (let i = 1; i < netos.length; i += 1) {
    if (netos[i].greaterThan(netos[maxIndex])) {
      maxIndex = i;
    }
  }

  const adjusted = [...netos];
  adjusted[maxIndex] = adjusted[maxIndex].plus(residuo);
  return adjusted;
}
