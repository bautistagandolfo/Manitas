import { Prisma } from '@prisma/client';
import { violatedConstraint } from './prisma-error.util';

function p2002(target: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target },
  });
}

describe('violatedConstraint', () => {
  it('devuelve el target tal cual si es un string', () => {
    expect(violatedConstraint(p2002('variants_sku_key'))).toBe(
      'variants_sku_key',
    );
  });

  it('une el target con comas si es un array', () => {
    expect(
      violatedConstraint(p2002(['product_id', 'size_id', 'color_id'])),
    ).toBe('product_id,size_id,color_id');
  });

  it('devuelve vacío si no hay target', () => {
    expect(violatedConstraint(p2002(undefined))).toBe('');
  });
});
