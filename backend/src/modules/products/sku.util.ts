// Patrón simple y determinístico: P{productId}-{TALLE}-{COLOR}. Usa el
// id del producto (no su nombre) para no colisionar entre productos
// distintos que comparten talle/color — la unicidad real la sigue
// garantizando la constraint de `sku` en la base (P2002 → 409). BLUEPRINT
// §12.2 solo exige "un patrón, editables" sin fijar cuál: este es el
// default, y el usuario lo puede cambiar después con un PATCH. Usado por
// T2.11 (grilla) y T2.13 (importación CSV) — extraído acá para no
// duplicar la regla entre los dos.
export function generateSku(
  productId: number,
  size: { nombre: string } | undefined,
  color: { nombre: string } | undefined,
): string {
  const slug = (value: string): string =>
    value
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '');

  const parts = [`P${productId}`];
  if (size) parts.push(slug(size.nombre));
  if (color) parts.push(slug(color.nombre));
  return parts.join('-');
}
