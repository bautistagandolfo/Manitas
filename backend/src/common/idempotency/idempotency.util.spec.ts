import { Prisma } from '@prisma/client';
import { withIdempotency } from './idempotency.util';

function idempotencyKeyViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target: ['idempotency_key'] },
  });
}

function otherUniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target: ['sku'] },
  });
}

describe('withIdempotency', () => {
  it('devuelve el resultado de write() cuando no hay conflicto, sin llamar a findExisting', async () => {
    const write = jest.fn().mockResolvedValue({ id: 1 });
    const findExisting = jest.fn();

    const result = await withIdempotency(write, findExisting);

    expect(result).toEqual({ id: 1 });
    expect(findExisting).not.toHaveBeenCalled();
  });

  it('BLUEPRINT §9.7: si write() choca contra idempotency_key, devuelve la operación existente en vez de fallar', async () => {
    const write = jest.fn().mockRejectedValue(idempotencyKeyViolation());
    const findExisting = jest.fn().mockResolvedValue({ id: 1, original: true });

    const result = await withIdempotency(write, findExisting);

    expect(result).toEqual({ id: 1, original: true });
    expect(findExisting).toHaveBeenCalledTimes(1);
  });

  it('un P2002 en otra columna (no idempotency_key) se propaga tal cual, sin buscar nada', async () => {
    const write = jest.fn().mockRejectedValue(otherUniqueViolation());
    const findExisting = jest.fn();

    await expect(withIdempotency(write, findExisting)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    expect(findExisting).not.toHaveBeenCalled();
  });

  it('un error que no es de Prisma se propaga tal cual', async () => {
    const write = jest.fn().mockRejectedValue(new Error('otra cosa'));
    const findExisting = jest.fn();

    await expect(withIdempotency(write, findExisting)).rejects.toThrow(
      'otra cosa',
    );
    expect(findExisting).not.toHaveBeenCalled();
  });

  it('si hay conflicto de idempotency_key pero findExisting no encuentra nada, propaga el error original en vez de inventar un 200', async () => {
    const conflict = idempotencyKeyViolation();
    const write = jest.fn().mockRejectedValue(conflict);
    const findExisting = jest.fn().mockResolvedValue(null);

    await expect(withIdempotency(write, findExisting)).rejects.toBe(conflict);
  });
});
