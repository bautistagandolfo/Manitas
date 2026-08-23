// Helpers únicos de formato es-AR (BLUEPRINT §12.3, CLAUDE.md regla 9).
// Prohibido formatear moneda o fecha a mano en un componente — todo pasa
// por acá.

// Los importes llegan del backend ya como STRING (Decimal serializado por
// Prisma, ver BLUEPRINT §9.3) — nunca como number. Convertir a number acá
// es solo para el paso final de formateo (Intl.NumberFormat), no para
// operar: no se suma, resta ni compara nada con este valor. El rango real
// de la columna (`Decimal(12,2)`) queda muy por debajo del límite de
// precisión segura de un `number` (2^53), así que no hay pérdida.
//
// No se usa `style: 'currency'` de Intl porque el símbolo/espaciado que
// arma ICU varía entre entornos (a veces con espacio duro, U+00A0, en vez
// del espacio normal) — se arma el prefijo "$ " a mano para que el
// resultado sea siempre exactamente el que pide el blueprint:
// "$ 12.500,50".
export function formatCurrency(value: string | number): string {
  const numero = Number(value);
  const formateado = new Intl.NumberFormat('es-AR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numero);
  return `$ ${formateado}`;
}

// Fechas/horas siempre en hora argentina para mostrar (aunque el backend
// las guarde y las mande en UTC) — no confundir con T0.7 (agrupación por
// día en hora argentina para reportes), que es lógica de negocio del
// backend; esto es solo presentación.
const TIME_ZONE = 'America/Argentina/Buenos_Aires';

function toDate(value: string | Date): Date {
  return typeof value === 'string' ? new Date(value) : value;
}

// dd/mm/aaaa.
export function formatDate(value: string | Date): string {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(toDate(value));
}

// dd/mm/aaaa HH:mm, 24 horas.
export function formatDateTime(value: string | Date): string {
  const fecha = formatDate(value);
  const hora = new Intl.DateTimeFormat('es-AR', {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(toDate(value));
  return `${fecha} ${hora}`;
}

// Cantidades genéricas (stock, conteos), no dinero: separador de miles
// es-AR, sin decimales forzados ni prefijo.
export function formatNumber(value: number): string {
  return new Intl.NumberFormat('es-AR').format(value);
}
