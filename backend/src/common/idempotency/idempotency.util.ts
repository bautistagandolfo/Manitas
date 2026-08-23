import { Prisma } from '@prisma/client';

// BLUEPRINT §9.7: "Si al insertar salta violación de unicidad, no es un
// error: se devuelve la operación original con 200." Cubre `sales`,
// `returns`, `cash_movements` y `expenses` — las cuatro tablas que tienen
// `idempotency_key` en el schema (AD-10: doble click en el mostrador, o
// un reintento por conexión lenta, no debe duplicar la operación).
//
// `write` y `findExisting` los define quien llama, porque cada tabla es
// distinta — este helper solo sabe reconocer la violación de unicidad
// específica de `idempotency_key` y qué hacer con ella, no cómo se
// escribe o se busca cada entidad.
export async function withIdempotency<T>(
  write: () => Promise<T>,
  findExisting: () => Promise<T | null>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!isIdempotencyKeyViolation(error)) {
      throw error;
    }

    const existing = await findExisting();
    if (!existing) {
      // No debería pasar: si la constraint de unicidad se violó, tiene
      // que existir una fila con esa clave. Si no aparece, algo más
      // raro está pasando (¿lectura en una réplica desactualizada?) —
      // mejor propagar el error original que devolver un 200 falso.
      throw error;
    }

    return existing;
  }
}

function isIdempotencyKeyViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }
  if (error.code !== 'P2002') {
    return false;
  }

  const target = error.meta?.target;
  const targetString =
    typeof target === 'string'
      ? target
      : Array.isArray(target)
        ? target.join(',')
        : '';
  return targetString.includes('idempotency_key');
}
