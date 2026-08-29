import { BadRequestException } from '@nestjs/common';

// T0.7 — AD-13: "toda agrupación por día, mes o período se calcula en
// `America/Argentina/Buenos_Aires`", nunca en UTC. Sin esto, una venta
// de las 22:00 (hora argentina) cae en el día siguiente en UTC — un
// error silencioso, nadie lo nota hasta que los números no cierran.
//
// Sin librería de fechas: Node trae ICU completo (`Intl`), suficiente
// para esta única zona horaria — agregar una dependencia entera
// (`date-fns-tz`/`luxon`) para un solo par de funciones puras sería más
// superficie de la que hace falta.
//
// Nota de alcance: Argentina no observa horario de verano desde 2009 —
// su offset respecto de UTC es fijo (-03:00) todo el año. El cálculo de
// abajo no asume eso (usa el offset real del instante, vía `Intl`,
// nunca un `-3` hardcodeado) — pero es lo que hace que un único cálculo
// por instante sea exacto, sin necesidad de resolver ambigüedades de
// transición de horario de verano (que esta zona no tiene).
export const ARGENTINA_TIME_ZONE = 'America/Argentina/Buenos_Aires';

const WALL_CLOCK_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: ARGENTINA_TIME_ZONE,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

// YYYY-MM-DD — locale `en-CA` es el truco estándar para que
// `Intl.DateTimeFormat` arme la fecha en ese orden sin ensamblarla a
// mano parte por parte.
const CALENDAR_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: ARGENTINA_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const FECHA_YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

// Offset (en ms) entre UTC y la hora de pared de `timeZone` EN el
// instante `utcInstant` — formatea `utcInstant` en esa zona, reinterpreta
// esos mismos dígitos como si fueran UTC, y resta. Para una zona sin
// horario de verano (como Argentina) este offset es constante, pero el
// cálculo no depende de esa constancia: siempre pregunta por el offset
// real de ese instante específico.
function offsetMsAt(utcInstant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(utcInstant);

  const get = (type: string): number => {
    const value = parts.find((p) => p.type === type)?.value;
    if (value === undefined) {
      throw new Error(`Intl.DateTimeFormat no devolvió la parte "${type}"`);
    }
    return Number(value);
  };

  const wallClockAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wallClockAsUtc - utcInstant.getTime();
}

// El instante UTC que corresponde a una hora de pared específica en
// Argentina (año/mes/día/hora/minuto/segundo/ms, todos en hora
// argentina). Una sola iteración alcanza porque el offset de Argentina
// no varía dentro del mismo día (sin DST) — el `guess` inicial (esos
// mismos dígitos interpretados como UTC) ya cae en el instante correcto
// para calcular el offset real.
//
// El offset se calcula SIEMPRE con `ms = 0` (`Intl.DateTimeFormat` no
// puede formatear milisegundos — perderlos ahí introduciría un error de
// hasta 999ms en el offset calculado, que en el límite de un día empuja
// el resultado al día siguiente). Los milisegundos que sí pidieron se
// suman aparte, en aritmética de enteros, después de resolver el
// segundo exacto.
function argentinaWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = offsetMsAt(guess, ARGENTINA_TIME_ZONE);
  return new Date(guess.getTime() - offset + ms);
}

// AD-13, la mitad que necesita `resultados`/cualquier consulta por
// rango: dado un día calendario ("YYYY-MM-DD", como llega de un query
// param), los límites UTC exactos de ESE día en hora argentina —
// medianoche a medianoche, "00:00:00.000" a "23:59:59.999" en hora
// argentina, ya convertidos a UTC.
export function argentinaDayRangeToUtc(fechaYYYYMMDD: string): {
  desde: Date;
  hasta: Date;
} {
  if (!FECHA_YYYY_MM_DD.test(fechaYYYYMMDD)) {
    throw new BadRequestException(
      `Fecha inválida (se espera YYYY-MM-DD): "${fechaYYYYMMDD}"`,
    );
  }
  const [year, month, day] = fechaYYYYMMDD.split('-').map(Number);

  // Fase 08 (QA adversarial, expenses/resultados) — hallazgo: el regex
  // de arriba (y `@IsDateString()` en los DTOs que llaman a esta
  // función, `ResultadosQueryDto`/`FindExpensesQueryDto`) solo valida
  // FORMATO, no que el día exista en ese mes/año — "2026-02-30" pasa
  // ambos chequeos. `Date.UTC` no rechaza un día fuera de rango: lo
  // "rueda" al mes siguiente en silencio (2026-02-30 → 2026-03-02),
  // corriendo el rango consultado un día entero sin ningún error. Se
  // valida acá, releyendo los mismos campos de vuelta desde el `Date`
  // ya construido — si no coinciden con lo que se pidió, el día no
  // existía.
  const diaValidado = new Date(Date.UTC(year, month - 1, day));
  const diaExiste =
    diaValidado.getUTCFullYear() === year &&
    diaValidado.getUTCMonth() === month - 1 &&
    diaValidado.getUTCDate() === day;
  if (!diaExiste) {
    throw new BadRequestException(
      `Fecha inválida (el día no existe): "${fechaYYYYMMDD}"`,
    );
  }

  return {
    desde: argentinaWallTimeToUtc(year, month, day, 0, 0, 0, 0),
    hasta: argentinaWallTimeToUtc(year, month, day, 23, 59, 59, 999),
  };
}

// AD-13, la otra mitad — "agrupación": dado un timestamp UTC (como
// `sales.fecha`), ¿a qué día calendario de Argentina pertenece? Este es
// el cálculo cuyo error BLUEPRINT describe literal: sin convertir a hora
// argentina, una venta de las 23:30 (hora argentina) cae en el día
// SIGUIENTE en UTC.
export function argentinaCalendarDate(date: Date): string {
  return CALENDAR_DATE_FORMAT.format(date);
}

// Hora de pared en Argentina de un instante UTC, como string legible
// ("HH:mm:ss") — utilidad chica para debugging/logs, no para persistir
// ni comparar (las comparaciones siempre se hacen en UTC contra los
// límites de `argentinaDayRangeToUtc`).
export function argentinaWallClock(date: Date): string {
  return WALL_CLOCK_FORMAT.format(date);
}
