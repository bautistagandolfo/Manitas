import { IsValidCalendarDateConstraint } from './is-valid-calendar-date.validator';

// Extraído en este ticket (listado de ventas) desde
// `expenses/dto/find-expenses-query.dto.ts` — hasta acá solo se
// ejercitaba indirecto vía los tests de integración de `expenses`
// (Fase 08). Como shared utility con un segundo consumidor
// (`sales/dto/find-sales-query.dto.ts`), le corresponde su propio test
// unitario directo, sin depender de ningún módulo que lo use.
describe('IsValidCalendarDateConstraint', () => {
  const constraint = new IsValidCalendarDateConstraint();

  it('acepta un día de calendario válido', () => {
    expect(constraint.validate('2026-08-30')).toBe(true);
  });

  it('acepta un string con hora, validando solo la parte de fecha', () => {
    expect(constraint.validate('2026-08-30T10:00:00.000Z')).toBe(true);
  });

  it('rechaza un día que no existe en el calendario (30 de febrero)', () => {
    expect(constraint.validate('2026-02-30')).toBe(false);
  });

  it('rechaza un mes fuera de rango', () => {
    expect(constraint.validate('2026-13-01')).toBe(false);
  });

  it('rechaza un día fuera de rango del mes correcto (abril tiene 30)', () => {
    expect(constraint.validate('2026-04-31')).toBe(false);
  });

  it('29 de febrero: rechazado en año no bisiesto, aceptado en bisiesto', () => {
    expect(constraint.validate('2026-02-29')).toBe(false);
    expect(constraint.validate('2024-02-29')).toBe(true);
  });

  it('deja pasar valores no-string o sin match — responsabilidad de @IsDateString(), no duplica el rechazo', () => {
    expect(constraint.validate(undefined)).toBe(true);
    expect(constraint.validate(12345)).toBe(true);
    expect(constraint.validate('no-es-una-fecha')).toBe(true);
  });

  it('defaultMessage() da un mensaje en español, con el placeholder de la propiedad', () => {
    expect(constraint.defaultMessage()).toBe(
      '$property no es un día de calendario válido',
    );
  });
});
