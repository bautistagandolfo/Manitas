import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

// STUB — Fase 04a (T2.4). Este archivo existe únicamente para que
// `stock.service.spec.ts` y `stock.integration.spec.ts` compilen y corran
// en rojo por una aserción real, no por un error de importación. Firma
// tomada literalmente de `state/reports/modulo-products-variants-spec.md`
// sección 4.2 (contrato de la API interna de `stock.service.ts`).
//
// PROHIBIDO agregarle lógica en esta fase (04a-tests-first.md): ni
// siquiera la validación más obvia. La implementación real es la Fase 04
// del ticket T2.4, en otra sesión.

export interface RegistrarEntradaInput {
  variantId: number;
  cantidad: number;
  costoUnitario: Prisma.Decimal.Value;
  userId: number;
}

export interface RegistrarAjusteInput {
  variantId: number;
  delta: number;
  motivo: string;
  userId: number;
}

@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  registrarEntrada(
    _tx: Prisma.TransactionClient,
    _input: RegistrarEntradaInput,
  ): Promise<void> {
    return Promise.reject(new Error('T2.4 todavía no implementado'));
  }

  registrarAjuste(
    _tx: Prisma.TransactionClient,
    _input: RegistrarAjusteInput,
  ): Promise<void> {
    return Promise.reject(new Error('T2.4 todavía no implementado'));
  }
}
