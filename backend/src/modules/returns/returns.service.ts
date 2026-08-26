import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMetodo, Prisma, Return, ReturnTipo } from '@prisma/client';
import { CashRegisterService } from '../cash-registers/cash-register.service';
import { SettingsService } from '../../common/settings/settings.service';
import { SETTINGS_KEYS } from '../../common/settings/settings-keys';
import { PrismaService } from '../../prisma/prisma.service';
import { roundCurrency } from '../../common/money/money.util';

// T5.1 — servicio de devolución transaccional (BLUEPRINT §5.4, RN-1 a
// RN-8 de `modulo-returns-spec.md`). Recibe siempre el `tx` de una
// transacción ya abierta por quien llama (mismo contrato que
// `sales.service.ts`/`stock.service.ts`) — nunca abre la suya propia.
//
// Alcance de este ticket, a propósito acotado (ROADMAP.md, un ticket
// por vez): solo `tipo = DEVOLUCION` (sin `CAMBIO`, eso es T5.5), sin
// reingreso real de stock (T5.2) y sin movimiento de caja real (T5.3)
// — `reingresa_stock` se recibe y se persiste, pero ningún colaborador
// de stock/caja se llama todavía más allá de verificar que hay una
// sesión abierta (RN-2, estructural, no depende de si hay efectivo).

export interface CrearDevolucionItemInput {
  saleItemId: number;
  cantidad: number;
  reingresaStock: boolean;
}

export interface CrearDevolucionPaymentInput {
  metodo: PaymentMetodo;
  monto: Prisma.Decimal.Value;
  referencia?: string;
}

export interface CrearDevolucionInput {
  saleId: number;
  items: CrearDevolucionItemInput[];
  returnPayments: CrearDevolucionPaymentInput[];
  userId: number;
  // T5.1 (RN-3, AMB-2 RESUELTA): mismo patrón que `esOwner` en
  // `sales`/`cash-registers` — lo resuelve el controller a partir de
  // `user.rol` (JWT verificado), nunca se confía en algo que mande el
  // cliente. Decide si se puede autorizar una devolución fuera de
  // plazo (sin mecanismo de contraseña todavía, mismo criterio
  // diferido que AMB-14 de `sales`: la clienta hoy no tiene
  // empleados).
  esOwner: boolean;
  // T5.1 (RN-9 de §9.7): se persiste tal cual en
  // `returns.idempotency_key` (columna `@unique` desde la fase 01).
  // Quien envuelve la llamada con `withIdempotency` es quien abre la
  // transacción (el futuro `ReturnsController`), nunca
  // `crearDevolucion`.
  idempotencyKey: string;
}

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashRegisterService: CashRegisterService,
    private readonly settingsService: SettingsService,
  ) {}

  async crearDevolucion(
    tx: Prisma.TransactionClient,
    input: CrearDevolucionInput,
  ): Promise<Return> {
    // Paso 0 (RN-9/§9.7) — hallazgo real de esta implementación: a
    // diferencia de una venta (donde un reintento casi siempre sigue
    // teniendo stock de sobra y solo choca con la unicidad de
    // `idempotency_key` recién en el `create`), una devolución puede
    // consumir EXACTO lo último disponible de una línea — un reintento
    // que revalidara todo desde cero vería "0 disponible" (porque el
    // primer intento, ya confirmado, lo consumió de verdad) y
    // rechazaría con un 400 de negocio antes de llegar al `create`,
    // que es el único lugar donde `withIdempotency` puede detectar la
    // clave repetida. Cortocircuito explícito acá, antes de cualquier
    // otra validación: si ya existe una devolución con esta clave, es
    // la misma operación pidiendo confirmación de nuevo, no una nueva.
    const existente = await tx.return.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existente) {
      return existente;
    }

    // Paso 1 (RN-2): sesión de caja abierta — lectura fail-fast, ANTES
    // de leer nada más (mismo hallazgo que `sales`: no depende de si
    // hay reintegro en efectivo).
    const sesion = await this.cashRegisterService.getSesionAbiertaOrThrow(tx);

    // Paso 2: lock de la fila de sesión, siempre.
    await tx.$queryRaw`SELECT id FROM cash_register_sessions WHERE id = ${sesion.id} FOR UPDATE`;

    // Paso 3 (RN-1, AD-19): la venta tiene que existir y no estar
    // ANULADA.
    const sale = await tx.sale.findUnique({ where: { id: input.saleId } });
    if (!sale) {
      throw new NotFoundException('Venta no encontrada');
    }
    if (sale.estado === 'ANULADA') {
      throw new ConflictException(
        'Esta venta está anulada, no admite devoluciones',
      );
    }

    // Paso 4 (BLUEPRINT §9.4, literal): lock de los `sale_items`
    // involucrados, ordenado por id — evita que dos devoluciones
    // parciales concurrentes de la MISMA línea lean el mismo
    // acumulado "viejo" y las dos pasen el tope de RN-4.
    const saleItemIds = [...new Set(input.items.map((i) => i.saleItemId))].sort(
      (a, b) => a - b,
    );
    await tx.$queryRaw`SELECT id FROM sale_items WHERE id IN (${Prisma.join(saleItemIds)}) ORDER BY id FOR UPDATE`;

    // Paso 5: con el lock tomado, leer las líneas originales y el
    // acumulado ya devuelto de cada una (puede venir de devoluciones
    // distintas, previas).
    const saleItemRows = await tx.saleItem.findMany({
      where: { id: { in: saleItemIds } },
    });
    const saleItemById = new Map(saleItemRows.map((row) => [row.id, row]));

    const previousReturnItems = await tx.returnItem.findMany({
      where: { saleItemId: { in: saleItemIds } },
    });
    const acumuladoPorLinea = new Map<
      number,
      { cantidad: number; netoLinea: Prisma.Decimal }
    >();
    for (const previo of previousReturnItems) {
      const actual = acumuladoPorLinea.get(previo.saleItemId) ?? {
        cantidad: 0,
        netoLinea: new Prisma.Decimal(0),
      };
      acumuladoPorLinea.set(previo.saleItemId, {
        cantidad: actual.cantidad + previo.cantidad,
        netoLinea: actual.netoLinea.plus(previo.netoLinea),
      });
    }

    // Paso 6 (RN-3, AMB-2 RESUELTA): plazo de devolución.
    const diasPlazo = await this.settingsService.getInt(
      SETTINGS_KEYS.DIAS_PLAZO_DEVOLUCION,
    );
    const diasTranscurridos =
      (Date.now() - sale.fecha.getTime()) / (1000 * 60 * 60 * 24);
    let autorizadoPorUserId: number | null = null;
    if (diasTranscurridos > diasPlazo) {
      if (!input.esOwner) {
        throw new BadRequestException(
          `El plazo de devolución (${diasPlazo} días) ya venció — necesita autorización de un OWNER`,
        );
      }
      autorizadoPorUserId = input.userId;
    }

    // Pasos 7-8 (RN-4/invariante 8, RN-5/AD-18): tope por línea y
    // neto devuelto, con la regla del remanente exacto.
    const itemsData = input.items.map((item) => {
      const saleItem = saleItemById.get(item.saleItemId);
      if (!saleItem) {
        throw new BadRequestException(
          `La línea ${item.saleItemId} no existe en esta venta`,
        );
      }

      const acumulado = acumuladoPorLinea.get(item.saleItemId) ?? {
        cantidad: 0,
        netoLinea: new Prisma.Decimal(0),
      };
      const cantidadDisponible = saleItem.cantidad - acumulado.cantidad;
      if (item.cantidad > cantidadDisponible) {
        throw new BadRequestException(
          `La línea ${item.saleItemId} supera lo disponible para devolver: quedan ${cantidadDisponible} unidades`,
        );
      }

      // AD-18: si esta devolución agota la línea, el remanente exacto
      // — nunca la fórmula proporcional de nuevo — para que la suma de
      // todas las devoluciones de una línea nunca difiera del
      // `neto_linea` original ni por un centavo de redondeo acumulado.
      const agotaLaLinea =
        acumulado.cantidad + item.cantidad === saleItem.cantidad;
      const netoLineaDevuelto = agotaLaLinea
        ? saleItem.netoLinea.minus(acumulado.netoLinea)
        : roundCurrency(
            saleItem.netoLinea
              .times(item.cantidad)
              .dividedBy(saleItem.cantidad),
          );

      return {
        saleItemId: item.saleItemId,
        cantidad: item.cantidad,
        netoLinea: netoLineaDevuelto,
        costoUnitario: saleItem.costoUnitario,
        reingresaStock: item.reingresaStock,
      };
    });

    // Paso 9.
    const totalDevuelto = itemsData.reduce(
      (acc, i) => acc.plus(i.netoLinea),
      new Prisma.Decimal(0),
    );

    // Paso 10 (RN-7/invariante 11): la suma de los reintegros tiene
    // que coincidir EXACTO con `total_devuelto`, ANTES de escribir
    // nada.
    const sumaReintegros = input.returnPayments.reduce(
      (acc, p) => acc.plus(new Prisma.Decimal(p.monto)),
      new Prisma.Decimal(0),
    );
    if (!sumaReintegros.equals(totalDevuelto)) {
      throw new BadRequestException(
        'Los reintegros no cubren el total de la devolución',
      );
    }

    const returnPaymentsData = input.returnPayments.map((p) => ({
      metodo: p.metodo,
      monto: new Prisma.Decimal(p.monto),
      referencia: p.referencia ?? null,
    }));

    // Paso 11: crear la devolución con líneas y reintegros en una sola
    // escritura nested.
    return tx.return.create({
      data: {
        saleId: input.saleId,
        fecha: new Date(),
        userId: input.userId,
        cashRegisterSessionId: sesion.id,
        tipo: ReturnTipo.DEVOLUCION,
        totalDevuelto,
        autorizadoPorUserId,
        idempotencyKey: input.idempotencyKey,
        items: { create: itemsData },
        returnPayments: { create: returnPaymentsData },
      },
    });
  }
}
