// Ticket nuevo (post Release Candidate) — hallazgo real de una ronda de
// auto-revisión, verificado en vivo: crear un color "negro" (minúscula)
// cuando ya existía "Negro" lo aceptó como uno NUEVO y distinto (201),
// sin ningún aviso — la unicidad de `nombre` en Brand/Category/Size/
// Color/ExpenseCategory es case-sensitive a nivel de Postgres por
// default, y ninguna de esas 5 tablas usa `citext` ni una collation
// especial. En un local real, con más de una persona cargando datos
// rápido, esto fragmenta el catálogo en silencio ("Negro"/"negro"/
// "NEGRO" como tres colores distintos) — exactamente el tipo de error
// cotidiano con el que el sistema "no sobrevive ni un día" (palabras
// del usuario). Se suma insensibilidad a acentos por el mismo motivo:
// nombres de color típicos del rubro llevan tilde ("Bordó", "Café",
// "Marrón") y es común tipearlos sin ella.
//
// Extraído de la función privada `normalizar()` que ya existía en
// `expenses/expense-categories.service.ts` (AD-7, detección de
// "mercadería" mal escrita) — mismo criterio, ahora compartido en vez
// de duplicado en cada uno de los 5 servicios que lo necesitan.
const PRIMER_DIACRITICO_COMBINANTE = 0x0300;
const ULTIMO_DIACRITICO_COMBINANTE = 0x036f;

export function normalizarParaComparar(texto: string): string {
  return Array.from(texto.trim().toLowerCase().normalize('NFD'))
    .filter((caracter) => {
      const codigo = caracter.codePointAt(0)!;
      return (
        codigo < PRIMER_DIACRITICO_COMBINANTE ||
        codigo > ULTIMO_DIACRITICO_COMBINANTE
      );
    })
    .join('');
}

// Azúcar sobre `normalizarParaComparar` para el caso de uso concreto:
// "¿este nombre ya existe, aunque con otra mayúscula/acento?" — usado
// en `create`/`update` de Brand/Category/Size/Color/ExpenseCategory,
// las 5 tablas de referencia con `nombre` único a nivel de Postgres
// (case-sensitive por default, sin `citext`).
export function esNombreDuplicado(
  nombreCandidato: string,
  nombresExistentes: string[],
): boolean {
  const normalizado = normalizarParaComparar(nombreCandidato);
  return nombresExistentes.some(
    (existente) => normalizarParaComparar(existente) === normalizado,
  );
}
