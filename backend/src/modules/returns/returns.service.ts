import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementReferenciaTipo,
  CashMovementTipo,
  PaymentMetodo,
  Prisma,
  Return,
  ReturnTipo,
} from '@prisma/client';
import { SalesService } from '../sales/sales.service';
import { StockService } from '../stock/stock.service';
import { CashRegisterService } from '../cash-registers/cash-register.service';
import { SettingsService } from '../../common/settings/settings.service';
import { SETTINGS_KEYS } from '../../common/settings/settings-keys';
import { PrismaService } from '../../prisma/prisma.service';
import { roundCurrency } from '../../common/money/money.util';

// T5.1/T5.2 — servicio de devolución transaccional (BLUEPRINT §5.4,
// RN-1 a RN-8 de `modulo-returns-spec.md`). Recibe siempre el `tx` de
// una transacción ya abierta por quien llama (mismo contrato que
// `sales.service.ts`/`stock.service.ts`) — nunca abre la suya propia.
//
// Alcance acotado a propósito (ROADMAP.md, un ticket por vez): solo
// `tipo = DEVOLUCION` (sin `CAMBIO`, eso es T5.5) y sin movimiento de
// caja real (T5.3) — el reingreso de stock (T5.2) sí está construido.

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

// T5.5 (RN-9) — la venta nueva de un `CAMBIO`, reusando `crearVenta` tal
// cual: nunca reimplementa descuentos/prorrateo/stock, solo pasa lo que
// el mostrador cargó para la prenda nueva. El pago con el crédito de la
// devolución se arma DENTRO de `crearDevolucion` (paso 14), no acá —
// `payments` de este tipo son SOLO los pagos ADEMÁS del crédito (vacío
// si el cambio es a precio igual o menor).
export interface CrearDevolucionVentaNuevaInput {
  items: Array<{ variantId: number; cantidad: number }>;
  payments: Array<{
    metodo: PaymentMetodo;
    monto: Prisma.Decimal.Value;
    referencia?: string;
  }>;
  discounts?: Array<{
    descripcion: string;
    porcentaje?: Prisma.Decimal.Value;
    monto?: Prisma.Decimal.Value;
  }>;
  ajusteRedondeo?: Prisma.Decimal.Value;
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
  // T5.5 (RN-9): default `DEVOLUCION` si no viene — compatibilidad
  // total con las llamadas existentes de T5.1-T5.4, que nunca lo
  // mandan.
  tipo?: ReturnTipo;
  // T5.5: obligatorio cuando `tipo = CAMBIO`, prohibido en caso
  // contrario (validado al principio, sección "Paso 0b" de abajo).
  ventaNueva?: CrearDevolucionVentaNuevaInput;
}

// T5.7 (backend) — respuesta de lectura pura para armar la pantalla de
// devolución/cambio: qué le queda disponible a cada línea de una venta.
// `costoUnitario` es opcional: el controller lo omite para `SELLER`
// (RN-10 de `sales`, mismo criterio ya aplicado en otros endpoints).
export interface BuscarVentaParaDevolucionItem {
  saleItemId: number;
  variantId: number;
  descripcionSnapshot: string;
  cantidadVendida: number;
  cantidadDisponible: number;
  netoLineaOriginal: Prisma.Decimal;
  netoLineaDisponible: Prisma.Decimal;
  costoUnitario?: Prisma.Decimal;
}

export interface BuscarVentaParaDevolucionResult {
  saleId: number;
  numero: number;
  fecha: Date;
  estado: string;
  dentroDePlazo: boolean;
  items: BuscarVentaParaDevolucionItem[];
  payments: Array<{ metodo: PaymentMetodo; monto: Prisma.Decimal }>;
}

// T5.8 (AMB-16 diferida) — respuesta de lectura pura de cuánto crédito
// le queda disponible a una devolución para aplicarse a una venta
// futura, sin relación con el momento ni la sesión que la generó.
// `totalDevuelto` es informativo (el valor total de la devolución) —
// NO es el techo de `creditoDisponible`: un `CAMBIO` a una prenda más
// barata puede reintegrar parte de `totalDevuelto` por otro medio
// (efectivo/tarjeta), y esa parte nunca fue crédito. El techo real de
// `creditoDisponible` es cuánto se marcó efectivamente como
// `CREDITO_DEVOLUCION` en `return_payments` al crear la devolución.
export interface ConsultarCreditoResult {
  returnId: number;
  numero: number;
  totalDevuelto: Prisma.Decimal;
  creditoConsumido: Prisma.Decimal;
  creditoDisponible: Prisma.Decimal;
  saleId: number;
}

@Injectable()
export class ReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashRegisterService: CashRegisterService,
    private readonly settingsService: SettingsService,
    private readonly stockService: StockService,
    private readonly salesService: SalesService,
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

    // Paso 0b (T5.5, RN-9; ampliado en T5.8 — hallazgo real, AMB-16) —
    // forma de `tipo`/`ventaNueva`/crédito, ANTES de tocar la base.
    //
    // Hallazgo de esta sesión: la versión original de este paso
    // rechazaba CUALQUIER reintegro `CREDITO_DEVOLUCION` en una
    // `DEVOLUCION` simple ("no genera crédito"), pensado para que el
    // crédito solo existiera como subproducto de un `CAMBIO` — pero
    // en un `CAMBIO`, el reintegro `CREDITO_DEVOLUCION` se aplica
    // SIEMPRE, entero, como pago de la `ventaNueva` en la MISMA
    // operación atómica (paso 14): `SalesService.crearVenta` exige
    // `SUM(payments) == total` de esa venta, así que ese crédito
    // nunca puede quedar parcialmente sin gastar. Resultado: con la
    // versión original, `creditoDisponible` (T5.8) era SIEMPRE $0
    // apenas creada la devolución — el mecanismo de "nota de crédito
    // usable en una venta futura y separada" (AMB-16 RESUELTA,
    // diferido) nunca era alcanzable de verdad por el flujo real.
    // Una `DEVOLUCION` simple (sin `ventaNueva`, nada que pagar en el
    // momento) SÍ puede admitir un reintegro `CREDITO_DEVOLUCION` —
    // ahí el crédito queda genuinamente bancado, sin ninguna venta
    // que lo consuma en el acto, listo para una venta futura
    // cualquiera (T5.8, `GET /returns/:numero/credito` +
    // `SalePaymentDto.returnId`).
    const tipo = input.tipo ?? ReturnTipo.DEVOLUCION;
    const creditoPayments = input.returnPayments.filter(
      (p) => p.metodo === PaymentMetodo.CREDITO_DEVOLUCION,
    );

    if (tipo === ReturnTipo.CAMBIO) {
      if (!input.ventaNueva) {
        throw new BadRequestException(
          'Un cambio necesita la venta nueva y el crédito aplicado',
        );
      }
      if (creditoPayments.length !== 1) {
        throw new BadRequestException(
          'Un cambio necesita exactamente un reintegro de tipo crédito de devolución',
        );
      }
    } else {
      if (input.ventaNueva) {
        throw new BadRequestException(
          'Una devolución simple no lleva venta nueva',
        );
      }
      // A lo sumo UNO (mismo criterio que el cambio) — el resto de
      // `total_devuelto`, si lo hay, se reintegra por otros medios
      // reales (EFECTIVO/TARJETA), nunca por dos líneas de crédito.
      if (creditoPayments.length > 1) {
        throw new BadRequestException(
          'Una devolución simple admite a lo sumo un reintegro de tipo crédito de devolución',
        );
      }
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
    //
    // Fase 08 (QA adversarial) — hallazgo real: `saleId: input.saleId`
    // en el filtro no es opcional, es lo que impide que un
    // `saleItemId` de una venta AJENA (manipulación de IDs, o un bug
    // de UI) pase como si perteneciera a la venta declarada — sin
    // esto, `saleItemById.get()` encontraba igual la fila (por id
    // puro), y la devolución quedaba creada con `sale_id` apuntando a
    // una venta que en realidad no tiene esa línea, mezclando datos de
    // dos ventas distintas. Con el filtro, una línea ajena simplemente
    // no aparece en `saleItemRows`, y el chequeo ya existente más abajo
    // ("La línea X no existe en esta venta") la rechaza con el mensaje
    // correcto, sin necesitar ningún chequeo nuevo.
    const saleItemRows = await tx.saleItem.findMany({
      where: { id: { in: saleItemIds }, saleId: input.saleId },
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
    let devolucion = await tx.return.create({
      data: {
        saleId: input.saleId,
        fecha: new Date(),
        userId: input.userId,
        cashRegisterSessionId: sesion.id,
        tipo,
        totalDevuelto,
        autorizadoPorUserId,
        idempotencyKey: input.idempotencyKey,
        items: { create: itemsData },
        returnPayments: { create: returnPaymentsData },
      },
    });

    // Paso 12 (T5.2, RN-6): reingreso de stock, un `reingresarPorDevolucion`
    // por línea (nunca agregado por variante) — solo para las líneas donde
    // la prenda vuelve en condiciones de venta. Recién acá existe
    // `devolucion.id`, así que este paso no puede ir antes del `create`.
    for (const item of input.items) {
      if (!item.reingresaStock) {
        continue;
      }
      const saleItem = saleItemById.get(item.saleItemId)!;
      await this.stockService.reingresarPorDevolucion(tx, {
        variantId: saleItem.variantId,
        cantidad: item.cantidad,
        returnId: devolucion.id,
        userId: input.userId,
      });
    }

    // Paso 13 (T5.3, invariante 7, AD-8): solo la parte del reintegro
    // cobrada en EFECTIVO mueve la caja, sumada en un único movimiento
    // (no uno por línea de reintegro) — mismo criterio exacto que
    // `sales.crearVenta`.
    const sumaEfectivo = input.returnPayments
      .filter((p) => p.metodo === PaymentMetodo.EFECTIVO)
      .reduce(
        (acc, p) => acc.plus(new Prisma.Decimal(p.monto)),
        new Prisma.Decimal(0),
      );

    if (sumaEfectivo.greaterThan(0)) {
      await this.cashRegisterService.registrarMovimiento(tx, {
        sessionId: sesion.id,
        tipo: CashMovementTipo.DEVOLUCION,
        monto: sumaEfectivo,
        referenciaTipo: CashMovementReferenciaTipo.RETURN,
        referenciaId: devolucion.id,
        descripcion: `Devolución venta #${sale.numero}`,
        userId: input.userId,
      });
    }

    // Pasos 14-15 (T5.5, RN-9): la venta nueva de un `CAMBIO`, recién
    // acá porque necesita `devolucion.id` para el pago con crédito.
    // Reusa `SalesService.crearVenta` tal cual — no reimplementa
    // ninguna regla de venta (descuentos, prorrateo, stock, RN-4). El
    // `idempotencyKey` derivado es determinístico (mismo input siempre
    // da la misma clave) pero distinto al de la devolución — son dos
    // filas distintas (`sales`/`returns`), cada una con su propia
    // columna `idempotency_key` única.
    if (tipo === ReturnTipo.CAMBIO) {
      const creditoAplicado = creditoPayments[0];
      const ventaNueva = await this.salesService.crearVenta(tx, {
        userId: input.userId,
        esOwner: input.esOwner,
        idempotencyKey: `${input.idempotencyKey}:cambio`,
        items: input.ventaNueva!.items,
        payments: [
          ...input.ventaNueva!.payments,
          {
            metodo: PaymentMetodo.CREDITO_DEVOLUCION,
            monto: new Prisma.Decimal(creditoAplicado.monto),
            returnId: devolucion.id,
          },
        ],
        discounts: input.ventaNueva!.discounts,
        ajusteRedondeo: input.ventaNueva!.ajusteRedondeo,
      });

      devolucion = await tx.return.update({
        where: { id: devolucion.id },
        data: { saleNuevaId: ventaNueva.id },
      });
    }

    return devolucion;
  }

  // T5.7 (backend) — `GET /returns/sales/:numero` (spec sección 4): lectura
  // pura, sin lock (el lock real que protege de devolver de más lo toma
  // `crearDevolucion` recién al escribir, sección 5 de la spec). Abre su
  // propia transacción de solo lectura (`RepeatableRead`) para que las
  // líneas y el acumulado de devoluciones previas se lean de un mismo
  // snapshot consistente — mismo criterio que `reconciliar()` de
  // `sales`/`cash-registers`/`stock`.
  async buscarVentaParaDevolucion(
    numero: number,
    opts: { incluirCosto: boolean },
  ): Promise<BuscarVentaParaDevolucionResult> {
    const { sale, items, previousReturnItems, payments } =
      await this.prisma.$transaction(
        async (tx) => {
          const sale = await tx.sale.findUnique({ where: { numero } });
          if (!sale) {
            throw new NotFoundException('Venta no encontrada');
          }
          const items = await tx.saleItem.findMany({
            where: { saleId: sale.id },
            orderBy: { id: 'asc' },
          });
          const previousReturnItems = await tx.returnItem.findMany({
            where: { saleItemId: { in: items.map((i) => i.id) } },
          });
          const payments = await tx.payment.findMany({
            where: { saleId: sale.id },
          });
          return { sale, items, previousReturnItems, payments };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );

    const cantidadDevueltaPorLinea = new Map<number, number>();
    const netoDevueltoPorLinea = new Map<number, Prisma.Decimal>();
    for (const previo of previousReturnItems) {
      cantidadDevueltaPorLinea.set(
        previo.saleItemId,
        (cantidadDevueltaPorLinea.get(previo.saleItemId) ?? 0) +
          previo.cantidad,
      );
      netoDevueltoPorLinea.set(
        previo.saleItemId,
        (
          netoDevueltoPorLinea.get(previo.saleItemId) ?? new Prisma.Decimal(0)
        ).plus(previo.netoLinea),
      );
    }

    const diasPlazo = await this.settingsService.getInt(
      SETTINGS_KEYS.DIAS_PLAZO_DEVOLUCION,
    );
    const diasTranscurridos =
      (Date.now() - sale.fecha.getTime()) / (1000 * 60 * 60 * 24);

    return {
      saleId: sale.id,
      numero: sale.numero,
      fecha: sale.fecha,
      estado: sale.estado,
      dentroDePlazo: diasTranscurridos <= diasPlazo,
      items: items.map((item) => {
        const cantidadDevuelta = cantidadDevueltaPorLinea.get(item.id) ?? 0;
        const netoDevuelto =
          netoDevueltoPorLinea.get(item.id) ?? new Prisma.Decimal(0);
        const base: BuscarVentaParaDevolucionItem = {
          saleItemId: item.id,
          variantId: item.variantId,
          descripcionSnapshot: item.descripcionSnapshot,
          cantidadVendida: item.cantidad,
          cantidadDisponible: item.cantidad - cantidadDevuelta,
          netoLineaOriginal: item.netoLinea,
          netoLineaDisponible: item.netoLinea.minus(netoDevuelto),
        };
        if (opts.incluirCosto) {
          base.costoUnitario = item.costoUnitario;
        }
        return base;
      }),
      payments: payments.map((p) => ({ metodo: p.metodo, monto: p.monto })),
    };
  }

  // T5.8 (AMB-16, RN-10) — consulta en vivo de cuánto crédito le queda
  // disponible a una devolución, sin columna de saldo cacheada: se
  // deriva de `payments`/`return_payments` cada vez (mismo criterio que
  // `reconciliar()` de `sales`/`cash-registers`/`stock`). Suma TODOS los
  // pagos `CREDITO_DEVOLUCION` que referencian esta devolución, sin
  // importar en qué venta ni sesión de caja ocurrieron — el crédito es
  // diferido por diseño (AMB-16 RESUELTA). Lectura pura, sin lock: el
  // lock real que protege de gastar de más lo toma `SalesService.crearVenta`
  // (T5.5) al escribir.
  //
  // El TECHO no es `total_devuelto` — mismo hallazgo real que en
  // `sales.service.ts` (paso 8c), corregido en la misma sesión: un
  // `CAMBIO` a una prenda más barata reintegra el excedente por OTRO
  // medio (RN-9), así que `total_devuelto` puede superar lo que
  // efectivamente se marcó como crédito. El techo real es la SUMA de
  // `return_payments` con `metodo = CREDITO_DEVOLUCION` — la única
  // parte que se convirtió en nota de crédito diferida.
  async consultarCredito(numero: number): Promise<ConsultarCreditoResult> {
    const devolucion = await this.prisma.return.findUnique({
      where: { numero },
    });
    if (!devolucion) {
      throw new NotFoundException('Devolución no encontrada');
    }

    const creditoOriginalAgg = await this.prisma.returnPayment.aggregate({
      where: {
        returnId: devolucion.id,
        metodo: PaymentMetodo.CREDITO_DEVOLUCION,
      },
      _sum: { monto: true },
    });
    const creditoOriginal =
      creditoOriginalAgg._sum.monto ?? new Prisma.Decimal(0);

    const consumido = await this.prisma.payment.aggregate({
      where: {
        returnId: devolucion.id,
        metodo: PaymentMetodo.CREDITO_DEVOLUCION,
      },
      _sum: { monto: true },
    });
    const creditoConsumido = consumido._sum.monto ?? new Prisma.Decimal(0);

    return {
      returnId: devolucion.id,
      numero: devolucion.numero,
      totalDevuelto: devolucion.totalDevuelto,
      creditoConsumido,
      creditoDisponible: creditoOriginal.minus(creditoConsumido),
      saleId: devolucion.saleId,
    };
  }
}
