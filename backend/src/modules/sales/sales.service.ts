import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  CashMovementReferenciaTipo,
  CashMovementTipo,
  PaymentMetodo,
  Prisma,
  Sale,
  SaleDiscountTipo,
} from '@prisma/client';
import { StockService } from '../stock/stock.service';
import { CashRegisterService } from '../cash-registers/cash-register.service';
import { SettingsService } from '../../common/settings/settings.service';
import { SETTINGS_KEYS } from '../../common/settings/settings-keys';
import { PrismaService } from '../../prisma/prisma.service';
import {
  applyPercentage,
  assertPositive,
  lineSubtotal,
  prorate,
  roundCurrency,
} from '../../common/money/money.util';

// T4.1 — servicio de venta transaccional (BLUEPRINT §5.3, RN-1 a RN-9 de
// `modulo-sales-spec.md`). Recibe siempre el `tx` de una transacción ya
// abierta por quien llama (mismo contrato que `stock.service.ts`/
// `cash-register.service.ts`) — nunca abre la suya propia.
//
// Alcance de este ticket, sin `discounts` (T4.3) ni `ajusteRedondeo`
// explícito (T4.6): con ambos fijos en 0, `neto_linea = subtotal_linea`
// coincide exactamente con lo que el prorrateo general (AD-18) daría en
// este caso — no se reimplementa acá, queda para cuando haya descuento o
// ajuste real. Sin idempotencia (T4.5) ni anulación (T4.7) todavía.

export interface CrearVentaItemInput {
  variantId: number;
  cantidad: number;
}

export interface CrearVentaPaymentInput {
  metodo: PaymentMetodo;
  monto: Prisma.Decimal.Value;
  referencia?: string;
}

// T4.3 — descuento manual (único `tipo` del MVP). Con `porcentaje`, el
// servicio calcula `monto` él mismo vía `applyPercentage` — nunca confía
// en que quien llama ya lo haya calculado bien, así que un `monto`
// mandado junto con `porcentaje` se ignora. Sin `porcentaje`, `monto` es
// obligatorio (se rechaza si falta).
export interface CrearVentaDiscountInput {
  descripcion: string;
  porcentaje?: Prisma.Decimal.Value;
  monto?: Prisma.Decimal.Value;
}

export interface CrearVentaInput {
  userId: number;
  items: CrearVentaItemInput[];
  payments: CrearVentaPaymentInput[];
  discounts?: CrearVentaDiscountInput[];
  // T4.3 — mismo patrón que `esOwner` en `cash-register.service.cerrarSesion`:
  // lo resuelve el controller a partir de `user.rol` (JWT verificado),
  // nunca se confía en algo que mande el cliente. Obligatorio: no hay un
  // default seguro para "no sé qué rol es quien vende".
  esOwner: boolean;
}

@Injectable()
export class SalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockService: StockService,
    private readonly cashRegisterService: CashRegisterService,
    private readonly settingsService: SettingsService,
  ) {}

  async crearVenta(
    tx: Prisma.TransactionClient,
    input: CrearVentaInput,
  ): Promise<Sale> {
    // Paso 1 (RN-1): sesión de caja abierta — lectura fail-fast.
    const sesion = await this.cashRegisterService.getSesionAbiertaOrThrow(tx);

    // Paso 2 (hallazgo real, spec sección 5): el lock de la fila de sesión
    // se toma SIEMPRE, no solo cuando hay pago en efectivo — el único otro
    // punto que lo tomaría (`registrarMovimiento`, paso 11) no se ejecuta
    // en una venta 100% tarjeta, lo que dejaría una ventana de concurrencia
    // real para ese caso si no se tomara acá.
    await tx.$queryRaw`SELECT id FROM cash_register_sessions WHERE id = ${sesion.id} FOR UPDATE`;

    // Paso 3 (RN-7): agregar la cantidad pedida por variante — dos líneas
    // de la misma variante se validan juntas, no cada una por separado.
    const cantidadPorVariante = new Map<number, number>();
    for (const item of input.items) {
      cantidadPorVariante.set(
        item.variantId,
        (cantidadPorVariante.get(item.variantId) ?? 0) + item.cantidad,
      );
    }
    const variantIds = [...cantidadPorVariante.keys()].sort((a, b) => a - b);

    // Paso 4 (BLUEPRINT §9.4, literal): un solo lock de todas las
    // variantes involucradas, ordenado por id — evita el deadlock de dos
    // ventas concurrentes que comparten variantes en distinto orden.
    await tx.$queryRaw`SELECT id FROM variants WHERE id IN (${Prisma.join(variantIds)}) ORDER BY id FOR UPDATE`;

    // Paso 5: recién ahora, con el lock tomado, se lee el estado real.
    // `product`/`size`/`color` se traen para el congelado formal de
    // `descripcion_snapshot` (T4.2, BLUEPRINT §3.4) — `size`/`color` son
    // nullable (AD-15), así que el snapshot tiene que poder armarse igual
    // sin ellos.
    const variantRows = await tx.variant.findMany({
      where: { id: { in: variantIds } },
      select: {
        id: true,
        precioVenta: true,
        costoActual: true,
        stockActual: true,
        product: { select: { nombre: true } },
        size: { select: { nombre: true } },
        color: { select: { nombre: true } },
      },
    });
    const variantById = new Map(variantRows.map((v) => [v.id, v]));

    // Paso 6 (RN-3, AMB-4 RESUELTA): stock insuficiente bloquea, salvo
    // `permitir_venta_sin_stock`. Se lee siempre (aunque el stock alcance)
    // porque `descontarPorVenta` también la necesita más abajo.
    const permitirVentaSinStock = await this.settingsService.getBool(
      SETTINGS_KEYS.PERMITIR_VENTA_SIN_STOCK,
    );

    if (!permitirVentaSinStock) {
      for (const [variantId, cantidad] of cantidadPorVariante) {
        const variant = variantById.get(variantId);
        if (!variant || variant.stockActual < cantidad) {
          throw new ConflictException(
            `Stock insuficiente: quedan ${variant?.stockActual ?? 0} unidades`,
          );
        }
      }
    }

    // Paso 7 (AD-5): congelar precio y costo por línea, calcular subtotal.
    // `neto_linea`/`neto_unitario` no se calculan todavía acá — dependen del
    // `total` final (AD-18/RN-5, prorrateo), que recién se conoce después de
    // resolver el descuento (paso 7b).
    const itemsBase = input.items.map((item) => {
      const variant = variantById.get(item.variantId);
      if (!variant) {
        throw new BadRequestException(
          `La variante ${item.variantId} no existe`,
        );
      }
      const subtotalLinea = lineSubtotal(item.cantidad, variant.precioVenta);
      // T4.2 (BLUEPRINT §3.4, literal: "nombre + talle + color al momento
      // de vender"): talle y color se omiten si la variante no los tiene
      // (AD-15, ambos nullable) — nunca aparece "null"/"undefined" en el
      // texto. Formato sin especificar por el blueprint ni por la spec del
      // módulo (AMB señalada en la fase 04a de T4.2, no bloqueante); se
      // elige uno legible y estable, no hay margen de negocio en juego.
      const descripcionSnapshot = [
        variant.product.nombre,
        variant.size?.nombre,
        variant.color?.nombre,
      ]
        .filter((parte): parte is string => Boolean(parte))
        .join(' - ');

      return {
        variantId: item.variantId,
        descripcionSnapshot,
        cantidad: item.cantidad,
        precioUnitario: variant.precioVenta,
        costoUnitario: variant.costoActual,
        subtotal: subtotalLinea,
      };
    });

    const subtotal = itemsBase.reduce(
      (acc, i) => acc.plus(i.subtotal),
      new Prisma.Decimal(0),
    );

    // Paso 7b (T4.3, RN-4): descuentos — `monto` de uno cargado como
    // porcentaje se resuelve acá con `applyPercentage`, nunca se confía en
    // que quien llama ya lo haya calculado bien.
    const discountsData = (input.discounts ?? []).map((d) => {
      if (d.porcentaje === undefined && d.monto === undefined) {
        throw new BadRequestException(
          `El descuento "${d.descripcion}" necesita un monto o un porcentaje`,
        );
      }
      return {
        tipo: SaleDiscountTipo.MANUAL,
        descripcion: d.descripcion,
        porcentaje:
          d.porcentaje !== undefined ? new Prisma.Decimal(d.porcentaje) : null,
        monto:
          d.porcentaje !== undefined
            ? applyPercentage(subtotal, d.porcentaje)
            : new Prisma.Decimal(d.monto!),
        // AMB-14 diferida (ver `state/AMBIGUITIES.md`): el mecanismo de
        // autorización por contraseña de OWNER no se construye en este
        // ticket — nunca se autoriza nada explícitamente todavía.
        autorizadoPorUserId: null as number | null,
      };
    });
    const descuentoTotal = discountsData.reduce(
      (acc, d) => acc.plus(d.monto),
      new Prisma.Decimal(0),
    );

    // Tope duro (invariante 4), siempre, para cualquier rol.
    if (descuentoTotal.isNegative() || descuentoTotal.greaterThan(subtotal)) {
      throw new BadRequestException(
        'El descuento no puede superar el subtotal de la venta',
      );
    }

    // Tope del vendedor (RN-4): se evalúa sobre el TOTAL descontado, nunca
    // sumando cada descuento por separado — y solo si quien vende no es
    // `OWNER` (una dueña no tiene límite de vendedora, RN-4/permiso). Sin
    // mecanismo de autorización todavía (AMB-14 diferida): superarlo
    // rechaza la venta directo.
    if (!input.esOwner && !subtotal.isZero()) {
      const maxDescuentoPct = await this.settingsService.getInt(
        SETTINGS_KEYS.MAX_DESCUENTO_VENDEDOR_PCT,
      );
      const ratioAplicado = descuentoTotal.dividedBy(subtotal).times(100);
      if (ratioAplicado.greaterThan(maxDescuentoPct)) {
        throw new BadRequestException(
          `El descuento supera el límite del vendedor (${maxDescuentoPct}%)`,
        );
      }
    }

    const ajusteRedondeo = new Prisma.Decimal(0);
    const total = subtotal.minus(descuentoTotal).plus(ajusteRedondeo);

    // Paso 7c (AD-18/RN-5): prorratea el total real a cada línea — con
    // descuento 0 (camino de T4.1/T4.2), `prorate` devuelve exactamente
    // `subtotal_linea` por línea, sin residuo, así que este paso no cambia
    // el comportamiento ya probado ahí.
    const netos = prorate(
      itemsBase.map((i) => i.subtotal),
      total,
    );
    const itemsData = itemsBase.map((item, index) => ({
      ...item,
      netoLinea: netos[index],
      netoUnitario: roundCurrency(netos[index].dividedBy(item.cantidad)),
    }));

    // Paso 8 (invariante 3 + `payments_monto_check` de la base, §7): cada
    // pago tiene que ser positivo, validado ANTES de sumar — sin esto, un
    // pago de $0 (o negativo) combinado con otro que igual complete el
    // total pasaría el chequeo de la suma sin problema, y recién explotaría
    // contra el `CHECK` crudo de la base con un error interno feo en vez de
    // un 400 de validación limpio (mismo criterio que `cantidad > 0` en
    // `sale_items`, ya señalado en la spec del módulo, sección 6).
    for (const p of input.payments) {
      assertPositive(p.monto, 'El monto de cada pago');
    }

    // La suma de pagos tiene que ser EXACTAMENTE el total, antes de
    // escribir nada.
    const sumaPagos = input.payments.reduce(
      (acc, p) => acc.plus(new Prisma.Decimal(p.monto)),
      new Prisma.Decimal(0),
    );
    if (!sumaPagos.equals(total)) {
      throw new BadRequestException('Los pagos no cubren el total de la venta');
    }

    const paymentsData = input.payments.map((p) => ({
      metodo: p.metodo,
      monto: new Prisma.Decimal(p.monto),
      referencia: p.referencia ?? null,
    }));

    // Paso 9: crear la venta con líneas, descuentos y pagos en una sola
    // escritura nested.
    const sale = await tx.sale.create({
      data: {
        fecha: new Date(),
        userId: input.userId,
        cashRegisterSessionId: sesion.id,
        subtotal,
        descuentoTotal,
        ajusteRedondeo,
        total,
        items: { create: itemsData },
        discounts: { create: discountsData },
        payments: { create: paymentsData },
      },
    });

    // Paso 10 (BLUEPRINT §5.3 paso 6, literal: "un stock_movements... por
    // línea"): un `descontarPorVenta` por cada línea de la venta, no uno
    // por variante agregada — la agregación del paso 3/6 es solo para la
    // validación previa.
    for (const item of input.items) {
      await this.stockService.descontarPorVenta(tx, {
        variantId: item.variantId,
        cantidad: item.cantidad,
        saleId: sale.id,
        userId: input.userId,
        permitirStockNegativo: permitirVentaSinStock,
      });
    }

    // Paso 11 (invariante 7, AD-8): solo la parte cobrada en EFECTIVO
    // mueve la caja, sumada en un único movimiento (no uno por pago).
    const sumaEfectivo = input.payments
      .filter((p) => p.metodo === PaymentMetodo.EFECTIVO)
      .reduce(
        (acc, p) => acc.plus(new Prisma.Decimal(p.monto)),
        new Prisma.Decimal(0),
      );

    if (sumaEfectivo.greaterThan(0)) {
      await this.cashRegisterService.registrarMovimiento(tx, {
        sessionId: sesion.id,
        tipo: CashMovementTipo.VENTA,
        monto: sumaEfectivo,
        referenciaTipo: CashMovementReferenciaTipo.SALE,
        referenciaId: sale.id,
        descripcion: `Venta #${sale.numero}`,
        userId: input.userId,
      });
    }

    return sale;
  }
}
