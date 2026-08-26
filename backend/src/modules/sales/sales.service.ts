import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementReferenciaTipo,
  CashMovementTipo,
  PaymentMetodo,
  Prisma,
  Sale,
  SaleDiscountTipo,
  SaleEstado,
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
// Sin anulación (T4.7) todavía.

// Fase 08 (QA adversarial) — hallazgo real, mismo patrón ya encontrado y
// corregido en `cash-register.service.ts` (también Fase 08): las columnas
// de plata de este módulo son `Decimal(12, 2)` (`sale_items.subtotal`,
// `neto_linea`, `neto_unitario`; `sales.subtotal`/`descuento_total`/
// `total`; `sale_discounts.monto`; `payments.monto`) — máximo absoluto
// representable 9999999999.99 — salvo `sale_discounts.porcentaje`, que es
// `Decimal(5, 2)` (máximo 999.99). Ningún DTO valida la MAGNITUD de un
// decimal (`@IsDecimal` valida formato, no rango), y acá además el riesgo
// no es solo un valor de entrada gigante: un `subtotal` de línea puede
// desbordar por una `cantidad` enorme multiplicada por un `precioVenta`
// perfectamente válido, sin que ningún campo de entrada por separado se
// vea fuera de rango. Sin este chequeo, cualquiera de estos casos llega
// crudo a Postgres, que lo rechaza con "numeric field overflow" (código
// 22003) — un `PrismaClientUnknownRequestError` sin `.code` traducible,
// que el `GlobalExceptionFilter` no puede distinguir de cualquier otro
// fallo interno y responde 500 genérico en vez de un 400 de validación.
const MAX_MONTO_ABSOLUTO = new Prisma.Decimal('9999999999.99');
const MAX_PORCENTAJE_ABSOLUTO = new Prisma.Decimal('999.99');

function assertDentroDePrecision(
  value: Prisma.Decimal.Value,
  field: string,
  max: Prisma.Decimal = MAX_MONTO_ABSOLUTO,
): void {
  if (new Prisma.Decimal(value).abs().greaterThan(max)) {
    throw new BadRequestException(`${field} es demasiado grande`);
  }
}

export interface CrearVentaItemInput {
  variantId: number;
  cantidad: number;
}

export interface CrearVentaPaymentInput {
  metodo: PaymentMetodo;
  monto: Prisma.Decimal.Value;
  referencia?: string;
  // T5.5 (invariante 14, AMB-16 RESUELTA — crédito diferido): un pago
  // `CREDITO_DEVOLUCION` siempre referencia la devolución que lo generó.
  // El PO confirmó que el crédito NO se limita al mismo momento del
  // cambio (`returns`, RN-9) — cualquier venta futura, sin relación con
  // `ReturnsService`, puede gastarlo, así que la validación de que no se
  // gasta de más (invariante 14) vive acá, no en `returns` (evita una
  // dependencia circular de módulos — `sales` solo consulta
  // `tx.return`/`tx.payment` directamente, mismo patrón que
  // `anularVenta` ya usa contra `tx.return.findFirst`).
  returnId?: number;
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
  // T4.5 (RN-9, BLUEPRINT §9.7/AD-10): se persiste tal cual en
  // `sales.idempotency_key` (columna `@unique` desde la fase 01). Quien
  // envuelve la llamada con `withIdempotency` (T0.14) es quien abre la
  // transacción — el futuro `SalesController` (T4.10/T4.11) — nunca
  // `crearVenta`, que no es dueño de su propio `tx`.
  idempotencyKey: string;
  // T4.6 (RN-6, AD-14): lo carga quien cobra, el sistema nunca lo calcula
  // solo — opcional, default 0 (mantiene el comportamiento de T4.1-T4.5
  // para quien no lo manda).
  ajusteRedondeo?: Prisma.Decimal.Value;
}

// T4.7 (RN-8, AD-19): mismo patrón que `esOwner` en `crearVenta` — lo
// resuelve el futuro controller a partir de `user.rol` (JWT verificado).
// RN-8 exige "Solo OWNER"; sin `SalesController` todavía (no hay
// `RolesGuard` que lo bloquee en la capa HTTP), el servicio mismo lo
// verifica y rechaza (CLAUDE.md regla 7: la autorización se verifica
// siempre en el servidor).
export interface AnularVentaInput {
  saleId: number;
  userId: number;
  esOwner: boolean;
}

// T4.8 (BLUEPRINT §6, invariante 3): las "tres primeras" invariantes
// (1 stock, 2 caja, 3 ventas) exigen, además del test automatizado,
// "un chequeo de reconciliación ejecutable" — mismo patrón que
// `StockService.reconciliar()` (T2.8) y `CashRegisterService.reconciliar()`
// (T3.6).
export interface SalesReconciliationMismatch {
  saleId: number;
  totalGuardado: Prisma.Decimal;
  sumaPagos: Prisma.Decimal;
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
        activo: true,
        precioVenta: true,
        costoActual: true,
        stockActual: true,
        product: { select: { nombre: true } },
        size: { select: { nombre: true } },
        color: { select: { nombre: true } },
      },
    });
    const variantById = new Map(variantRows.map((v) => [v.id, v]));

    // Paso 5b (RN-2, spec §7: "variantId inexistente o inactivo" → 400):
    // toda línea tiene que referenciar una variante real y activa — "no
    // existe venta libre con precio a mano". Se valida ANTES del stock
    // (paso 6): sin esto, una variante inexistente entraba igual al
    // chequeo de stock (`variant?.stockActual ?? 0`) y salía como 409
    // "Stock insuficiente: quedan 0 unidades" en vez del 400 que exige la
    // tabla de errores de la spec — hallazgo real de la fase 07, sin test
    // que lo cubriera hasta ahora.
    for (const variantId of variantIds) {
      const variant = variantById.get(variantId);
      if (!variant || !variant.activo) {
        throw new BadRequestException(`La variante ${variantId} no existe`);
      }
    }

    // Paso 6 (RN-3, AMB-4 RESUELTA): stock insuficiente bloquea, salvo
    // `permitir_venta_sin_stock`. Se lee siempre (aunque el stock alcance)
    // porque `descontarPorVenta` también la necesita más abajo.
    const permitirVentaSinStock = await this.settingsService.getBool(
      SETTINGS_KEYS.PERMITIR_VENTA_SIN_STOCK,
    );

    if (!permitirVentaSinStock) {
      for (const [variantId, cantidad] of cantidadPorVariante) {
        // El `!` es seguro por el mismo motivo que en el paso 7 (más abajo):
        // el paso 5b ya validó que TODO `variantId` de `cantidadPorVariante`
        // (que itera sobre las mismas keys que `variantIds`) existe y está
        // activo — el `!variant ||`/`?? 0` que había acá antes de la Fase 08
        // quedaba efectivamente inalcanzable, mismo tipo de código muerto ya
        // limpiado en el paso 7 durante la Fase 07.
        const variant = variantById.get(variantId)!;
        if (variant.stockActual < cantidad) {
          throw new ConflictException(
            `Stock insuficiente: quedan ${variant.stockActual} unidades`,
          );
        }
      }
    }

    // Paso 7 (AD-5): congelar precio y costo por línea, calcular subtotal.
    // `neto_linea`/`neto_unitario` no se calculan todavía acá — dependen del
    // `total` final (AD-18/RN-5, prorrateo), que recién se conoce después de
    // resolver el descuento (paso 7b). El `!` es seguro: el paso 5b ya
    // validó que TODO `variantId` de `input.items` existe y está activo
    // (fase 07 — antes había acá un segundo chequeo de existencia,
    // efectivamente inalcanzable, que quedaba como código muerto).
    const itemsBase = input.items.map((item) => {
      const variant = variantById.get(item.variantId)!;
      const subtotalLinea = lineSubtotal(item.cantidad, variant.precioVenta);
      // Fase 08: una `cantidad` enorme puede desbordar `Decimal(12,2)` sin
      // que `precioVenta` por sí solo esté fuera de rango.
      assertDentroDePrecision(subtotalLinea, 'El subtotal de la línea');
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
    assertDentroDePrecision(subtotal, 'El subtotal de la venta');

    // Paso 7b (T4.3, RN-4): descuentos — `monto` de uno cargado como
    // porcentaje se resuelve acá con `applyPercentage`, nunca se confía en
    // que quien llama ya lo haya calculado bien.
    const discountsData = (input.discounts ?? []).map((d) => {
      if (d.porcentaje === undefined && d.monto === undefined) {
        throw new BadRequestException(
          `El descuento "${d.descripcion}" necesita un monto o un porcentaje`,
        );
      }
      if (d.porcentaje !== undefined) {
        assertDentroDePrecision(
          d.porcentaje,
          `El porcentaje del descuento "${d.descripcion}"`,
          MAX_PORCENTAJE_ABSOLUTO,
        );
      }
      const monto =
        d.porcentaje !== undefined
          ? applyPercentage(subtotal, d.porcentaje)
          : new Prisma.Decimal(d.monto!);
      assertDentroDePrecision(
        monto,
        `El monto del descuento "${d.descripcion}"`,
      );
      return {
        tipo: SaleDiscountTipo.MANUAL,
        descripcion: d.descripcion,
        porcentaje:
          d.porcentaje !== undefined ? new Prisma.Decimal(d.porcentaje) : null,
        monto,
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
    assertDentroDePrecision(descuentoTotal, 'El descuento total');

    // Tope duro (invariante 4), siempre, para cualquier rol.
    if (descuentoTotal.isNegative() || descuentoTotal.greaterThan(subtotal)) {
      throw new BadRequestException(
        'El descuento no puede superar el subtotal',
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

    // T4.6 (RN-6): |ajuste_redondeo| < 1, siempre — lo carga quien cobra,
    // nunca lo calcula el sistema solo.
    const ajusteRedondeo =
      input.ajusteRedondeo !== undefined
        ? new Prisma.Decimal(input.ajusteRedondeo)
        : new Prisma.Decimal(0);
    if (ajusteRedondeo.abs().greaterThanOrEqualTo(1)) {
      throw new BadRequestException(
        'El ajuste de redondeo debe ser menor a $1 en valor absoluto',
      );
    }

    const total = subtotal.minus(descuentoTotal).plus(ajusteRedondeo);

    // Invariante 4 (hallazgo real, spec sección 3): `total >= 0` no se
    // sigue automáticamente de `0 <= descuento_total <= subtotal` y
    // `|ajuste_redondeo| < 1` combinados — un ajuste negativo puede dejarlo
    // en negativo igual.
    if (total.isNegative()) {
      throw new BadRequestException(
        'El ajuste de redondeo deja el total en negativo',
      );
    }
    assertDentroDePrecision(total, 'El total de la venta');

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
      assertDentroDePrecision(p.monto, 'El monto de cada pago');
    }

    // Paso 8b (T5.5, invariante 14, AMB-16 RESUELTA): forma de cada pago
    // con crédito de devolución — `CREDITO_DEVOLUCION` siempre necesita
    // `returnId`, y `returnId` solo tiene sentido junto con ese método.
    for (const p of input.payments) {
      if (
        p.metodo === PaymentMetodo.CREDITO_DEVOLUCION &&
        p.returnId === undefined
      ) {
        throw new BadRequestException(
          'Un pago con crédito de devolución necesita indicar cuál',
        );
      }
      if (
        p.returnId !== undefined &&
        p.metodo !== PaymentMetodo.CREDITO_DEVOLUCION
      ) {
        throw new BadRequestException(
          'El crédito de devolución solo aplica a ese método de pago',
        );
      }
    }

    // Paso 8c (T5.5, invariante 14): el crédito de una devolución nunca
    // se gasta de más — ni en esta venta ni sumado a lo que ya se gastó
    // en cualquier otra. Lock de TODAS las devoluciones referenciadas,
    // ordenado por id (BLUEPRINT §9.4), ANTES de leer cuánto crédito
    // tienen consumido — sin esto, dos ventas simultáneas que gastan el
    // mismo crédito podrían leer el mismo "consumido hasta ahora" y las
    // dos pasar.
    const creditoPagos = input.payments.filter((p) => p.returnId !== undefined);
    const returnIdsInvolucrados = [
      ...new Set(creditoPagos.map((p) => p.returnId!)),
    ].sort((a, b) => a - b);

    if (returnIdsInvolucrados.length > 0) {
      await tx.$queryRaw`SELECT id FROM returns WHERE id IN (${Prisma.join(returnIdsInvolucrados)}) ORDER BY id FOR UPDATE`;

      for (const returnId of returnIdsInvolucrados) {
        const returnRow = await tx.return.findUnique({
          where: { id: returnId },
        });
        if (!returnRow) {
          throw new NotFoundException('Devolución no encontrada');
        }

        const aggregate = await tx.payment.aggregate({
          where: { returnId, metodo: PaymentMetodo.CREDITO_DEVOLUCION },
          _sum: { monto: true },
        });
        const consumidoPrevio = aggregate._sum.monto ?? new Prisma.Decimal(0);

        const pedidoEnEstaVenta = creditoPagos
          .filter((p) => p.returnId === returnId)
          .reduce(
            (acc, p) => acc.plus(new Prisma.Decimal(p.monto)),
            new Prisma.Decimal(0),
          );

        const disponible = returnRow.totalDevuelto.minus(consumidoPrevio);
        if (pedidoEnEstaVenta.greaterThan(disponible)) {
          throw new BadRequestException(
            `El crédito de la devolución #${returnId} no alcanza — disponible: $${disponible.toFixed(2)}`,
          );
        }
      }
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
      returnId: p.returnId ?? null,
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
        idempotencyKey: input.idempotencyKey,
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

  // T4.7 (RN-8, AD-19, invariantes 13/15) — anulación de venta: no borra ni
  // edita `sale_items`/`payments`/`stock_movements`/`cash_movements`
  // originales, crea movimientos nuevos de tipo `ANULACION` y marca
  // `sales.estado = ANULADA`.
  async anularVenta(
    tx: Prisma.TransactionClient,
    input: AnularVentaInput,
  ): Promise<Sale> {
    // Paso 1 (RN-8, "Solo OWNER") — sin leer nada de la base todavía.
    if (!input.esOwner) {
      throw new ForbiddenException('Solo un OWNER puede anular una venta');
    }

    // Paso 2 (BLUEPRINT §9.4): lock de la fila de venta antes de leer
    // nada — evita que dos anulaciones concurrentes de la MISMA venta
    // reviertan stock/caja dos veces.
    await tx.$queryRaw`SELECT id FROM sales WHERE id = ${input.saleId} FOR UPDATE`;

    // Paso 3: con el lock tomado, lee la venta completa.
    const sale = await tx.sale.findUnique({
      where: { id: input.saleId },
      include: { items: true, payments: true },
    });
    if (!sale) {
      throw new NotFoundException('Venta no encontrada');
    }
    if (sale.estado === SaleEstado.ANULADA) {
      throw new ConflictException('Esta venta ya está anulada');
    }

    // Paso 4 (AD-19, invariante 13): sin devoluciones registradas.
    const devolucionExistente = await tx.return.findFirst({
      where: { saleId: sale.id },
    });
    if (devolucionExistente) {
      throw new ConflictException(
        'Esta venta tiene devoluciones registradas, no se puede anular',
      );
    }

    // Paso 5 (invariante 15): un pago con crédito de devolución se
    // corrige con una devolución de la venta nueva, no con una anulación.
    const tieneCreditoDevolucion = sale.payments.some(
      (p) => p.metodo === PaymentMetodo.CREDITO_DEVOLUCION,
    );
    if (tieneCreditoDevolucion) {
      throw new ConflictException(
        'No se puede anular una venta pagada con crédito de devolución; corresponde una devolución sobre la venta nueva',
      );
    }

    // Paso 6: solo dentro de la misma sesión de caja actual (RN-8) — la
    // lectura de "hay sesión abierta" ya rechaza con 409 si no hay
    // ninguna.
    const sesion = await this.cashRegisterService.getSesionAbiertaOrThrow(tx);
    if (sale.cashRegisterSessionId !== sesion.id) {
      throw new ConflictException(
        'Solo se puede anular dentro del mismo turno de caja',
      );
    }

    // Paso 7: revierte stock, una llamada por línea (nunca agregada por
    // variante — acá no hay validación de umbral que agregar, a
    // diferencia de RN-7 de `crearVenta`).
    for (const item of sale.items) {
      await this.stockService.revertirPorAnulacion(tx, {
        variantId: item.variantId,
        cantidad: item.cantidad,
        saleId: sale.id,
        userId: input.userId,
      });
    }

    // Paso 8 (invariante 7): el movimiento de caja de la anulación es
    // solo por lo que se cobró en EFECTIVO — anular una venta 100%
    // tarjeta no saca nada del cajón, porque nunca entró.
    const sumaEfectivo = sale.payments
      .filter((p) => p.metodo === PaymentMetodo.EFECTIVO)
      .reduce((acc, p) => acc.plus(p.monto), new Prisma.Decimal(0));

    if (sumaEfectivo.greaterThan(0)) {
      await this.cashRegisterService.registrarMovimiento(tx, {
        sessionId: sale.cashRegisterSessionId,
        tipo: CashMovementTipo.ANULACION,
        monto: sumaEfectivo,
        referenciaTipo: CashMovementReferenciaTipo.SALE,
        referenciaId: sale.id,
        descripcion: `Anulación venta #${sale.numero}`,
        userId: input.userId,
      });
    }

    // Paso 9: marca la venta como ANULADA.
    return tx.sale.update({
      where: { id: sale.id },
      data: { estado: SaleEstado.ANULADA },
    });
  }

  // T4.8 — invariante 3 (BLUEPRINT §6.3): SUM(payments.monto) ==
  // sales.total para cada venta. Sin filtro por `estado`: una venta
  // ANULADA no toca `payments`/`total` (RN-8), así que el invariante
  // tiene que seguir cumpliéndose igual para ella (mismo criterio que
  // `stock.service.reconciliar()` con variantes inactivas, RN-7).
  //
  // Única excepción al contrato de "el servicio nunca abre su propia
  // transacción": es de solo lectura, no compone con la transacción de
  // nadie más. REPEATABLE READ, mismo motivo que `stock.service.reconciliar()`
  // (T2.8) y `cash-register.service.reconciliar()` (T3.6): sin eso, una
  // escritura real entre las dos lecturas podría reportar un desajuste
  // que en realidad nunca existió.
  async reconciliar(): Promise<SalesReconciliationMismatch[]> {
    const [sales, sums] = await this.prisma.$transaction(
      (tx) =>
        Promise.all([
          tx.sale.findMany({ select: { id: true, total: true } }),
          tx.payment.groupBy({ by: ['saleId'], _sum: { monto: true } }),
        ]),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const sumaPorVenta = new Map(
      sums.map((s) => [s.saleId, s._sum.monto ?? new Prisma.Decimal(0)]),
    );

    return sales
      .map((sale) => ({
        saleId: sale.id,
        totalGuardado: sale.total,
        sumaPagos: sumaPorVenta.get(sale.id) ?? new Prisma.Decimal(0),
      }))
      .filter((m) => !m.totalGuardado.equals(m.sumaPagos));
  }
}
