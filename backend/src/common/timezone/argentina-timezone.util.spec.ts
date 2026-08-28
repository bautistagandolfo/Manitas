import {
  argentinaCalendarDate,
  argentinaDayRangeToUtc,
  argentinaWallClock,
} from './argentina-timezone.util';

// T0.7 — AD-13. Función pura, sin mocks: se testea contra valores UTC/
// Argentina calculados a mano (Argentina = UTC−3, fijo, sin horario de
// verano desde 2009).
describe('argentina-timezone.util (T0.7, AD-13)', () => {
  describe('argentinaCalendarDate', () => {
    // El caso que BLUEPRINT exige literal (§5.6): "Un test debe
    // verificar que una venta de las 23:30 pertenece al día correcto."
    // 23:30 hora argentina del día 14 = 02:30 UTC del día 15 (23:30 + 3h
    // cruza la medianoche). Sin la conversión, el día "ingenuo" (UTC)
    // sería el 15 — un día de más.
    it('una venta de las 23:30 hora argentina pertenece al día argentino correcto, no al día UTC', () => {
      const ventaUtc = new Date('2026-01-15T02:30:00.000Z');

      expect(argentinaCalendarDate(ventaUtc)).toBe('2026-01-14');
      // Confirmación explícita de que el bug que este helper evita es
      // real: el día UTC "ingenuo" da un resultado distinto (equivocado).
      expect(ventaUtc.toISOString().slice(0, 10)).toBe('2026-01-15');
    });

    it('una venta de las 00:30 hora argentina pertenece al día que arrancó, no al anterior (mismo caso, del otro lado de la medianoche)', () => {
      // 00:30 ART del día 14 = 03:30 UTC del día 14 (mismo día en UTC
      // esta vez, caso de control para no confundir "cruza medianoche"
      // con "todos los casos cruzan").
      const ventaUtc = new Date('2026-01-14T03:30:00.000Z');
      expect(argentinaCalendarDate(ventaUtc)).toBe('2026-01-14');
    });

    it('mediodía UTC y mediodía argentino caen siempre en el mismo día calendario (el offset de 3h nunca cruza mediodía)', () => {
      const ventaUtc = new Date('2026-06-10T15:00:00.000Z');
      expect(argentinaCalendarDate(ventaUtc)).toBe('2026-06-10');
    });
  });

  describe('argentinaDayRangeToUtc', () => {
    it('"2026-01-14" → desde = 2026-01-14T03:00:00.000Z (medianoche ART), hasta = 2026-01-15T02:59:59.999Z (23:59:59.999 ART)', () => {
      const { desde, hasta } = argentinaDayRangeToUtc('2026-01-14');

      expect(desde.toISOString()).toBe('2026-01-14T03:00:00.000Z');
      expect(hasta.toISOString()).toBe('2026-01-15T02:59:59.999Z');
    });

    it('round-trip: los límites de un día, pasados por argentinaCalendarDate, dan ese mismo día — ni uno antes ni uno después', () => {
      const { desde, hasta } = argentinaDayRangeToUtc('2026-06-01');

      expect(argentinaCalendarDate(desde)).toBe('2026-06-01');
      expect(argentinaCalendarDate(hasta)).toBe('2026-06-01');
    });

    it('un instante 1ms antes de "desde" pertenece al día anterior, y uno 1ms después de "hasta" pertenece al día siguiente (los límites son exactos, no aproximados)', () => {
      const { desde, hasta } = argentinaDayRangeToUtc('2026-03-10');

      const unMsAntes = new Date(desde.getTime() - 1);
      const unMsDespues = new Date(hasta.getTime() + 1);

      expect(argentinaCalendarDate(unMsAntes)).toBe('2026-03-09');
      expect(argentinaCalendarDate(unMsDespues)).toBe('2026-03-11');
    });

    it('funciona igual cruzando fin de mes y fin de año (los casos donde un desliz de un día se nota más)', () => {
      const finDeMes = argentinaDayRangeToUtc('2026-01-31');
      expect(argentinaCalendarDate(finDeMes.desde)).toBe('2026-01-31');
      expect(argentinaCalendarDate(finDeMes.hasta)).toBe('2026-01-31');

      const finDeAño = argentinaDayRangeToUtc('2026-12-31');
      expect(argentinaCalendarDate(finDeAño.desde)).toBe('2026-12-31');
      expect(argentinaCalendarDate(finDeAño.hasta)).toBe('2026-12-31');
    });

    it('rechaza una fecha con formato inválido', () => {
      expect(() => argentinaDayRangeToUtc('2026/01/14')).toThrow(
        /fecha inválida/i,
      );
      expect(() => argentinaDayRangeToUtc('14-01-2026')).toThrow(
        /fecha inválida/i,
      );
      expect(() => argentinaDayRangeToUtc('')).toThrow(/fecha inválida/i);
    });
  });

  describe('argentinaWallClock', () => {
    it('formatea la hora de pared en Argentina de un instante UTC (HH:mm:ss)', () => {
      // 02:30 UTC del 15 = 23:30 hora argentina del 14 (mismo caso que
      // el test principal de argentinaCalendarDate, verificado también
      // acá para la hora, no solo el día).
      expect(argentinaWallClock(new Date('2026-01-15T02:30:00.000Z'))).toBe(
        '23:30:00',
      );
    });
  });
});
