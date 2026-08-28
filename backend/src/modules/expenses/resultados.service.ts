import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

// Forma de la respuesta de `GET /resultados` — spec del módulo,
// sección 4. Todos los importes viajan como `string` (`Decimal`,
// BLUEPRINT §9.3), nunca `number`.
export interface ResultadosQuery {
  desde: string;
  hasta: string;
}

export interface ResultadosResponse {
  ingresos: string;
  cmv: string;
  margenBruto: string;
  margenBrutoPct: string;
  gastos: string;
  resultadoNeto: string;
  calculadoEn: Date;
  periodo: { desde: string; hasta: string };
}

// T6.4 — Fase 04a (stub mínimo). La fórmula real (BLUEPRINT §5.6) es
// responsabilidad de la Fase 04 (otra sesión): ingresos, CMV, margen
// bruto (y su %), gastos y resultado neto, con los tres filtros de la
// spec (estado COMPLETADA, reingresaStock, fecha de cabecera). Mismo
// contrato que `SalesService.reconciliar()`/`ReturnsService.
// consultarCredito()`: lectura pura, sin `tx` recibido — abre su PROPIA
// transacción `RepeatableRead` porque no compone con la de nadie más.
@Injectable()
export class ResultadosService {
  constructor(private readonly prisma: PrismaService) {}

  async consultar(query: ResultadosQuery): Promise<ResultadosResponse> {
    // Firma real fijada por la Fase04a — el parámetro se usa recién en la
    // Fase 04 (implementación real). `void` acá evita el lint de
    // "no-unused-vars" sin renombrar el parámetro a `_query`, mismo
    // criterio ya usado en `sales-anulacion.integration.spec.ts`
    // (`void settingsService;`).
    void query;
    return Promise.reject(new Error('T6.4 todavía no implementado'));
  }
}
