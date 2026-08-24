import { Prisma } from '@prisma/client';

// `error.meta?.target` (el nombre de la constraint violada en un P2002)
// puede llegar como string o como array según el driver — se usa en
// variants.service.ts y catalog-import.service.ts para decidir el
// mensaje de negocio (SKU vs. barcode vs. otro), extraído acá en vez de
// reimplementarlo en cada lugar (Fase 07, cierre del módulo).
export function violatedConstraint(
  error: Prisma.PrismaClientKnownRequestError,
): string {
  const target = error.meta?.target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.join(',');
  return '';
}
