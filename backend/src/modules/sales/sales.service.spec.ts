import { Prisma, PaymentMetodo } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StockService } from '../stock/stock.service';
import type { CashRegisterService } from '../cash-registers/cash-register.service';
import type { SettingsService } from '../../common/settings/settings.service';
import {
  lineSubtotal,
  applyPercentage,
  prorate,
} from '../../common/money/money.util';
import { SalesService } from './sales.service';

// Fase 04a (T4.1) — tests escritos ANTES de la implementación, contra Prisma
// completamente mockeado (BLUEPRINT §9.8, excepción "plata y stock/caja":
// los tests se escriben primero, derivados de la especificación, y se
// verifica que fallen antes de implementar).
//
// Fuente única: `docs/build-protocol/state/ROADMAP.md` (T4.1, Etapa 4 y sus
// notas de hallazgos técnicos de la fase 06), `BLUEPRINT.md` (AD-3/4/5/8/9/
// 10/14/18/19, §3.4, §5.3, invariantes 3/4/5/6/7/9/10/12/13/15, §7, §9.3,
// §9.4, §9.7) y `docs/build-protocol/state/reports/modulo-sales-spec.md`
// (RN-1 a RN-10, secciones 3, 4.2, 4.3, 5, 6, 9). No se abrió ningún archivo
// de `backend/src/modules/` salvo `stock/stock.service.ts` y
// `cash-registers/cash-register.service.ts` como IMPORT DE TIPO (nunca se
// leyó su contenido) para poder tipar el constructor de `SalesService`, y
// la ESTRUCTURA (no la lógica) de `cash-registers/cash-register.service.spec.ts`
// como convención mecánica del repo (patrón MockTx/asTx, jest.fn tipados).
//
// ─── Contrato de `SalesService`, definido en esta sesión (no existe
// todavía ni la clase ni el archivo real) ───────────────────────────────
//
// Nombre de clase: `SalesService`. Constructor:
//   (prisma: PrismaService, stockService: StockService,
//    cashRegisterService: CashRegisterService, settingsService: SettingsService)
// — mismo criterio que el resto de los servicios de negocio (inyecta sus
// colaboradores, nunca abre su propia transacción salvo que el ticket lo
// pida explícitamente, cosa que T4.1 no pide).
//
// Método principal: `crearVenta(tx, input)`, donde:
//   input = {
//     userId: number;
//     items: Array<{ variantId: number; cantidad: number }>;
//     payments: Array<{ metodo: PaymentMetodo; monto: Decimal.Value; referencia?: string }>;
//   }
// Sin `discounts` (T4.3) ni `ajusteRedondeo` explícito (T4.6) todavía — para
// T4.1, `descuento_total = 0` y `ajuste_redondeo = 0` son fijos, lo que hace
// que `neto_linea = subtotal_linea` y `neto_unitario = precio_unitario` por
// línea coincidan exactamente con lo que el prorrateo general daría en este
// caso particular (total == subtotal, sin residuo) — no se reimplementa el
// prorrateo general acá, queda para cuando haya descuento/ajuste real.
//
// Flujo esperado (RN-1 + hallazgos de la sección 5 de la spec), todo con el
// `tx` recibido, nunca abriendo transacción propia:
//   1. `cashRegisterService.getSesionAbiertaOrThrow(tx)` — lectura fail-fast,
//      404/409 "No hay una sesión de caja abierta" si no hay ninguna.
//   2. Lock explícito de esa fila de sesión, SIEMPRE (hallazgo de la
//      sección 5: el lock temprano de caja no depende de si hay pago en
//      efectivo): `tx.$queryRaw` con `SELECT id FROM cash_register_sessions
//      WHERE id = ${sesion.id} FOR UPDATE`.
//   3. Agregar cantidad pedida por `variantId` (RN-7, sumando todas las
//      líneas de la misma variante).
//   4. Lock de las variantes involucradas, ordenado por id, patrón exacto
//      de BLUEPRINT §9.4: `tx.$queryRaw` con `SELECT id FROM variants WHERE
//      id IN (${Prisma.join(idsOrdenados)}) ORDER BY id FOR UPDATE`.
//   5. `tx.variant.findMany` para leer `precioVenta`/`costoActual`/
//      `stockActual` de esas variantes (recién ahora, con el lock tomado).
//   6. Validar stock agregado por variante contra `stockActual`, salvo
//      `settingsService.getBool('permitir_venta_sin_stock')`.
//   7. Calcular `subtotal_linea` (`lineSubtotal` de `common/money`),
//      `subtotal` = suma; `descuentoTotal = 0`; `ajusteRedondeo = 0`;
//      `total = subtotal`; validar `total >= 0` (defensivo, invariante 4).
//   8. Validar `SUM(payments.monto) == total` (invariante 3) ANTES de
//      escribir nada.
//   9. `tx.sale.create` con `items: { create: [...] }` y
//      `payments: { create: [...] }` anidados en una sola llamada (decisión
//      de esta sesión: no hay ningún cálculo intermedio entre "crear
//      sale+items" y "registrar payments" en T4.1 sin descuentos, así que
//      una sola escritura nested es válida y más simple que dos statements
//      separados — documentado, no adivinado).
//  10. `stockService.descontarPorVenta(tx, { variantId, cantidad, saleId,
//      userId, permitirStockNegativo })` UNA VEZ POR LÍNEA (no una vez por
//      variante agregada — BLUEPRINT §5.3 paso 6 dice "por línea"; la
//      agregación de RN-7 es solo para la validación previa de stock).
//  11. Si `SUM(payments donde metodo === EFECTIVO) > 0`,
//      `cashRegisterService.registrarMovimiento(tx, { sessionId, tipo:
//      'VENTA', monto: sumaEfectivo, referenciaTipo: 'SALE', referenciaId:
//      sale.id, descripcion, userId })` (contrato ya fijado, spec sección
//      4.3, VERDE desde T3.2).
//
// `descripcionSnapshot` (columna NOT NULL): T4.1 tiene que escribir algo
// (la columna no admite null), pero el "congelado formal" completo
// (nombre + talle + color) es nominalmente T4.2 según el propio ticket. Acá
// solo se verifica que quede un string no vacío, sin pinnear su formato
// exacto — decisión de esta sesión para no adelantar el alcance de T4.2.
//
// RN-10 (ocultar `costoUnitario` para SELLER en las respuestas): no se
// prueba acá. El alcance textual de T4.1 (ROADMAP.md, notas de Etapa 4) no
// lo menciona entre lo que este ticket construye — es responsabilidad de
// los endpoints GET/POST de la capa de controller, no de `crearVenta` en
// sí. Se deja fuera a propósito, mismo criterio que "no adelantar tickets
// futuros" (CLAUDE.md regla 10).
//
// ─── Fase 04a (T4.3) — agregado sobre lo de arriba, sesión aparte ────────
//
// Fuente única de esta sección: `ROADMAP.md` T4.3 y la nota en prosa
// "Alcance de T4.3 achicado a propósito (2026-08-25)" debajo de la tabla de
// Etapa 4; `BLUEPRINT.md` §5.3 (descuentos), AD-18 (prorrateo, sección 2),
// §9.3 (redondeo/prorrateo/los 2 tests obligatorios), §6 invariantes 4 y
// 12; `state/reports/modulo-sales-spec.md` RN-4 y RN-5;
// `state/AMBIGUITIES.md` AMB-14 (incluida la nota "Construcción diferida
// (2026-08-25)"); `backend/prisma/schema.prisma` modelo `SaleDiscount` y
// enum `SaleDiscountTipo` (solo como tipos, no como lógica). NO se abrió
// `sales.service.ts` para escribir nada de lo que sigue.
//
// Contrato ampliado de `crearVenta(tx, input)` para T4.3 (decisión de esta
// sesión, ya que `sales.service.ts` no se puede mirar):
//   input += {
//     discounts?: Array<{ descripcion: string; porcentaje?: Decimal.Value; monto: Decimal.Value }>;
//     esOwner: boolean;   // NUEVO CAMPO OBLIGATORIO, mismo patrón que
//                         // `cerrarSesion` de `cash-registers` (ya VERDE):
//                         // lo resuelve el futuro controller a partir de
//                         // `user.rol`, nunca se confía en lo que manda el
//                         // cliente. `crearVenta` lo recibe ya resuelto.
//   }
// `descuentoTotal = SUM(discounts[].monto)`, con `monto` efectivo de un
// descuento porcentual igual a `applyPercentage(subtotal, porcentaje)`
// (`common/money`, ya existe desde T0.12).
//
// Tope duro (invariante 4), siempre, para cualquier rol:
// `0 ≤ descuentoTotal ≤ subtotal`. Por encima, rechazo 400 sin escribir
// nada.
//
// Tope del vendedor (`max_descuento_vendedor_pct`,
// `settingsService.getInt('max_descuento_vendedor_pct')`, sembrado en 10):
// se evalúa `descuentoTotal / subtotal` contra ese porcentaje SOLO SI
// `esOwner === false`. Si `esOwner === true`, el descuento se acepta sin
// evaluar el tope del vendedor en absoluto — ni siquiera se espera que
// `settingsService.getInt` sea invocado para esa clave en ese camino
// (alcance textual del ROADMAP: "una dueña no tiene límite de vendedora").
// Si `esOwner === false` y lo supera: rechazo 400, sin ningún mecanismo de
// autorización todavía (AMB-14 queda diferida a un ticket futuro chico) —
// es un bloqueo simple y correcto para este alcance, no un bug.
//
// `sale_discounts` se escribe con `tipo: 'MANUAL'` (único valor del enum
// hoy), `descripcion`, `monto`, `porcentaje` solo si se cargó como tal, y
// **`autorizadoPorUserId: null` siempre** en este ticket — tanto con
// `esOwner: true` como `esOwner: false` dentro de tope — porque nunca se
// autorizó nada explícitamente todavía (el mecanismo de contraseña de
// AMB-14 no se construye acá). Relación en el schema: `Sale.discounts`
// (`SaleDiscount[]`), así que se asume `sale.create({ data: { ...,
// discounts: { create: [...] } } })`, mismo patrón nested que `items` y
// `payments` en T4.1.
//
// Prorrateo real (AD-18/RN-5, `prorate()` de `common/money/money.util.ts`,
// ya existe desde T0.12, no se reimplementa acá): con `descuentoTotal > 0`,
// `netoLinea` dejar de coincidir con `subtotalLinea` — se calcula
// `prorate(subtotalesDeLinea, total)` y el resultado se persiste por línea,
// en el mismo orden de inserción (que es el de `id`, para el desempate de
// residuo "menor id").
//
// ─── Ajuste de tooling sobre los tests VIEJOS de T4.1/T4.2 (esta sesión) ─
//
// `esOwner: true` se agregó a las 14 llamadas a `crearVenta` que ya
// existían en este archivo, ANTES de escribir ningún test nuevo de T4.3.
// Es un ajuste puramente de tipos, no de comportamiento: hoy
// (`sales.service.ts` real, sin tocar) `crearVenta` no exige `esOwner`
// todavía, así que agregarlo no cambiaba ninguna aserción existente ni el
// resultado de esos 14 casos (siguen pasando igual). Se hizo de forma
// preventiva porque, una vez que la Fase 04 (implementación) haga
// `esOwner` un campo obligatorio del contrato real, esas 14 llamadas
// dejarían de compilar si no lo tuvieran — y un error de compilación ahí
// no sería "la razón correcta" de rojo (tapa la ausencia de funcionalidad
// real). Sin este ajuste, la sesión de implementación se encontraría con
// una ruptura de compilación en tests que no tocó y que no tiene nada que
// ver con lo que implementó.
//
// Los tests NUEVOS de T4.3, más abajo, pasan `discounts`/`esOwner` a
// través de una variable con un tipo explícito más ancho
// (`CrearVentaInputT43`) en vez de un objeto literal inline — evita que
// TypeScript los rechace por "propiedad extra no reconocida" contra el
// tipo real (todavía angosto) del parámetro de `crearVenta`, y así el rojo
// que producen es un rojo de aserción (falta la funcionalidad) en vez de
// un rojo de compilación, que es justo la distinción que pide la fase 04a.

interface VariantRow {
  id: number;
  precioVenta: Prisma.Decimal;
  costoActual: Prisma.Decimal;
  stockActual: number;
  product: { nombre: string };
  size: { nombre: string } | null;
  color: { nombre: string } | null;
}

// Fase 04 (T4.2, implementación): `product`/`size`/`color` agregados al
// mock — T4.2 extendió el `select` de `tx.variant.findMany` para armar
// `descripcion_snapshot` (BLUEPRINT §3.4). No es un debilitamiento de
// ninguna aserción de T4.1: los tests de ese ticket nunca comprobaban el
// contenido de `descripcionSnapshot` más allá de "no vacío", así que
// agregar estos campos al fixture no cambia el comportamiento que
// verifican, solo evita que revienten con "Cannot read properties of
// undefined" ahora que el servicio real los consulta.
function buildVariantRow(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    id: 10,
    precioVenta: new Prisma.Decimal('100.00'),
    costoActual: new Prisma.Decimal('60.00'),
    stockActual: 10,
    product: { nombre: 'Producto de prueba' },
    size: { nombre: 'M' },
    color: { nombre: 'Negro' },
    ...overrides,
  };
}

interface SessionRow {
  id: number;
  estado: 'ABIERTA' | 'CERRADA';
}

function buildSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return { id: 1, estado: 'ABIERTA', ...overrides };
}

interface SaleItemCreateInput {
  variantId: number;
  descripcionSnapshot: string;
  cantidad: number;
  precioUnitario: Prisma.Decimal.Value;
  costoUnitario: Prisma.Decimal.Value;
  subtotal: Prisma.Decimal.Value;
  netoLinea: Prisma.Decimal.Value;
  netoUnitario: Prisma.Decimal.Value;
}

interface PaymentCreateInput {
  metodo: PaymentMetodo;
  monto: Prisma.Decimal.Value;
  referencia?: string | null;
}

// T4.3 — forma esperada de un `sale_discounts` a crear, nested dentro de
// `sale.create` (relación `Sale.discounts`, schema.prisma). `tipo: 'MANUAL'`
// es el único valor del enum `SaleDiscountTipo` hoy; `autorizadoPorUserId`
// siempre `null` en este ticket (nunca se autorizó nada explícitamente,
// AMB-14 diferida).
interface SaleDiscountCreateInput {
  tipo: 'MANUAL';
  descripcion: string;
  porcentaje?: Prisma.Decimal.Value | null;
  monto: Prisma.Decimal.Value;
  autorizadoPorUserId: number | null;
}

interface SaleCreateCall {
  data: {
    fecha: Date;
    userId: number;
    cashRegisterSessionId: number;
    subtotal: Prisma.Decimal.Value;
    descuentoTotal: Prisma.Decimal.Value;
    ajusteRedondeo: Prisma.Decimal.Value;
    total: Prisma.Decimal.Value;
    items: { create: SaleItemCreateInput[] };
    payments: { create: PaymentCreateInput[] };
    // Opcional: T4.1/T4.2 nunca lo mandaban (descuento_total fijo en 0).
    discounts?: { create: SaleDiscountCreateInput[] };
    // T4.5 (RN-9, AD-10) — opcional acá porque T4.1-T4.4 nunca lo mandaban;
    // se vuelve el foco de esta sección de tests.
    idempotencyKey?: string;
  };
}

interface CreatedSale {
  id: number;
  numero: number;
  items: Array<SaleItemCreateInput & { id: number }>;
  payments: Array<PaymentCreateInput & { id: number }>;
  discounts: Array<SaleDiscountCreateInput & { id: number }>;
}

function buildCreatedSaleFromCall(
  call: SaleCreateCall,
  saleId = 501,
): CreatedSale {
  return {
    id: saleId,
    numero: saleId,
    items: call.data.items.create.map((item, index) => ({
      id: index + 1,
      ...item,
    })),
    payments: call.data.payments.create.map((p, index) => ({
      id: index + 1,
      ...p,
    })),
    discounts: (call.data.discounts?.create ?? []).map((d, index) => ({
      id: index + 1,
      ...d,
    })),
  };
}

interface MockTx {
  variant: {
    findMany: jest.Mock<Promise<VariantRow[]>, [unknown]>;
  };
  sale: {
    create: jest.Mock<Promise<CreatedSale>, [SaleCreateCall]>;
  };
  $queryRaw: jest.Mock<
    Promise<unknown[]>,
    [TemplateStringsArray, ...unknown[]]
  >;
}

function buildMockTx(variantRows: VariantRow[]): MockTx {
  return {
    variant: {
      findMany: jest
        .fn<Promise<VariantRow[]>, [unknown]>()
        .mockResolvedValue(variantRows),
    },
    sale: {
      create: jest
        .fn<Promise<CreatedSale>, [SaleCreateCall]>()
        .mockImplementation((call) =>
          Promise.resolve(buildCreatedSaleFromCall(call)),
        ),
    },
    $queryRaw: jest
      .fn<Promise<unknown[]>, [TemplateStringsArray, ...unknown[]]>()
      .mockResolvedValue([]),
  };
}

function asTx(tx: MockTx): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

interface Deps {
  stockService: {
    descontarPorVenta: jest.Mock<Promise<void>, [unknown, unknown]>;
  };
  cashRegisterService: {
    getSesionAbiertaOrThrow: jest.Mock<Promise<SessionRow>, [unknown]>;
    registrarMovimiento: jest.Mock<
      Promise<{ id: number }>,
      [unknown, { monto: Prisma.Decimal.Value }]
    >;
  };
  settingsService: {
    getBool: jest.Mock<Promise<boolean>, [string]>;
    // T4.3 — `getInt('max_descuento_vendedor_pct')`, sembrado en 10 (T0.13).
    getInt: jest.Mock<Promise<number>, [string]>;
  };
}

function buildDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    stockService: {
      descontarPorVenta: jest
        .fn<Promise<void>, [unknown, unknown]>()
        .mockResolvedValue(undefined),
    },
    cashRegisterService: {
      getSesionAbiertaOrThrow: jest
        .fn<Promise<SessionRow>, [unknown]>()
        .mockResolvedValue(buildSessionRow()),
      registrarMovimiento: jest
        .fn<
          Promise<{ id: number }>,
          [unknown, { monto: Prisma.Decimal.Value }]
        >()
        .mockResolvedValue({ id: 999 }),
    },
    settingsService: {
      getBool: jest.fn<Promise<boolean>, [string]>().mockResolvedValue(false),
      getInt: jest.fn<Promise<number>, [string]>().mockResolvedValue(10),
    },
    ...overrides,
  };
}

// ─── T4.3 — contrato ampliado del input de `crearVenta` ──────────────────
//
// Definido acá (no en `sales.service.ts`, que no se abrió) porque es lo que
// esta sesión decide que el contrato DEBERÍA aceptar, derivado de la
// especificación. Se pasa a `crearVenta` a través de una variable con este
// tipo (nunca como objeto literal inline) para que la propiedad extra
// (`discounts`/`esOwner`, que el tipo real de hoy no declara) no dispare el
// chequeo de "excess property" de TypeScript en la llamada — eso
// convertiría el rojo esperado (falta la funcionalidad) en un rojo de
// compilación, que es justo lo que la fase 04a pide evitar.
interface DiscountInputT43 {
  descripcion: string;
  porcentaje?: Prisma.Decimal.Value;
  monto?: Prisma.Decimal.Value;
}

interface CrearVentaInputT43 {
  userId: number;
  items: Array<{ variantId: number; cantidad: number }>;
  payments: Array<{
    metodo: PaymentMetodo;
    monto: Prisma.Decimal.Value;
    referencia?: string;
  }>;
  discounts?: DiscountInputT43[];
  esOwner: boolean;
  idempotencyKey: string;
}

// ─── T4.5 — idempotencia (RN-9, AD-10, BLUEPRINT §9.7) ───────────────────
//
// Fuente única: `ROADMAP.md` (T4.5) y su alcance real ya decidido de
// antemano (no reinterpretado acá): `crearVenta` acepta un nuevo campo
// obligatorio `idempotencyKey: string`, que se persiste tal cual en
// `sales.idempotency_key` (`tx.sale.create({ data: { ...,
// idempotencyKey: input.idempotencyKey } })`) — ya `@unique` en el schema
// desde la fase 01. `crearVenta` NO envuelve su propia llamada con
// `withIdempotency`: recibe el `tx` ya abierto por quien llama (nunca abre
// su propia transacción, contrato de T4.1), y `withIdempotency` necesita
// hacer una lectura de recuperación DESPUÉS de que la transacción que
// falló ya terminó — esa responsabilidad es de quien abre la transacción
// (el futuro `SalesController`, T4.10/T4.11, todavía no existe). Esta
// sesión NO leyó `sales.service.ts` — mismo tipo ampliado por variable
// (no objeto literal inline) que `CrearVentaInputT43`, para que la
// propiedad nueva no dispare "excess property" de TypeScript contra el
// tipo real (todavía angosto) del parámetro — así el rojo que produce es
// un rojo de aserción (el campo no se persiste), no un rojo de
// compilación.
interface CrearVentaInputT45 extends CrearVentaInputT43 {
  idempotencyKey: string;
}

// ─── Fase 04a (T4.6) — ajuste de redondeo (RN-6, AD-14, invariante 4) ────
//
// Fuente única: `ROADMAP.md` T4.6 y la nota en prosa "Hallazgos técnicos
// menores (fase 06)" bajo la tabla de Etapa 4 ("`total >= 0` no se sigue
// automáticamente de las otras reglas del invariante 4... asignado a
// T4.6"); `BLUEPRINT.md` §9.3 (reglas de redondeo, AD-14), AD-14 (sección
// 2), invariante 4 (sección 6); `state/reports/modulo-sales-spec.md` RN-6
// (líneas 117-119), el ejemplo numérico de la sección 3 (`subtotal=$0.50,
// descuento_total=$0.50, ajuste_redondeo=-$0.90 → total=-$0.90`) y la
// tabla de errores (sección 7, "El ajuste de redondeo deja el total en
// negativo"); `backend/prisma/schema.prisma` modelo `Sale`, campo
// `ajusteRedondeo` (`Decimal(12,2)`, `@default(0)`, ya existe desde la
// fase 01). NO se abrió `sales.service.ts`.
//
// Contrato ampliado de `crearVenta(tx, input)` para T4.6 (decisión de esta
// sesión): `input += { ajusteRedondeo?: Prisma.Decimal.Value }`, opcional
// — default `0` si no se manda, para que las ~70 llamadas preexistentes de
// T4.1-T4.5 (que nunca lo mandan) sigan funcionando exactamente igual, con
// `ajusteRedondeo = 0` implícito. Mismo patrón de tipo ampliado por
// variable (nunca objeto literal inline) que `CrearVentaInputT43`/`T45`,
// para que la propiedad nueva no dispare "excess property" de TypeScript
// contra el tipo real (todavía angosto) del parámetro.
//
// Reglas a probar (RN-6, invariante 4):
//   1. `|ajuste_redondeo| < 1` — un valor `>= 1` o `<= -1` se rechaza con
//      400, ANTES de escribir nada.
//   2. `total = subtotal - descuento_total + ajuste_redondeo`, verificado
//      sobre `tx.sale.create` con ajuste positivo, negativo y cero.
//   3. `total` resultante negativo se rechaza explícitamente (invariante
//      4), con el mensaje exacto de la spec ("El ajuste de redondeo deja
//      el total en negativo"), ANTES de escribir nada — esto convierte el
//      `it.todo` que T4.1 había dejado reservado más arriba, ahora
//      alcanzable porque `ajusteRedondeo` deja de estar fijo en 0.
//   4. El prorrateo (`prorate()`, ya usado desde T4.2/T4.3) sigue usando
//      el `total` FINAL (con el ajuste ya aplicado) para `netoLinea` de
//      cada línea — no el subtotal ni el total sin ajustar.
interface CrearVentaInputT46 extends CrearVentaInputT45 {
  ajusteRedondeo?: Prisma.Decimal.Value;
}

function buildService(deps: Deps): SalesService {
  return new SalesService(
    {} as PrismaService,
    deps.stockService as unknown as StockService,
    deps.cashRegisterService as unknown as CashRegisterService,
    deps.settingsService as unknown as SettingsService,
  );
}

function sqlText(call: unknown[]): string {
  return (call[0] as string[]).join('').toLowerCase();
}

describe('SalesService.crearVenta', () => {
  describe('camino feliz (RN-1, RN-2, invariantes 3/7/12)', () => {
    it('una línea, sin descuento, pago único en efectivo: descuenta stock y registra el movimiento de caja correcto', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const result = await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 2 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('200.00'),
          },
        ],
      });

      expect(result.id).toBe(501);
      expect(tx.sale.create).toHaveBeenCalledTimes(1);
      const call = tx.sale.create.mock.calls[0][0];
      const expectedSubtotal = lineSubtotal(2, variant.precioVenta);
      expect(new Prisma.Decimal(call.data.subtotal).toString()).toBe(
        expectedSubtotal.toString(),
      );
      expect(new Prisma.Decimal(call.data.descuentoTotal).toString()).toBe('0');
      expect(new Prisma.Decimal(call.data.ajusteRedondeo).toString()).toBe('0');
      expect(new Prisma.Decimal(call.data.total).toString()).toBe(
        expectedSubtotal.toString(),
      );
      expect(call.data.userId).toBe(7);
      expect(call.data.cashRegisterSessionId).toBe(1);

      // Invariante 12 (la parte que le toca a T4.1, sin descuento/ajuste):
      // subtotal == SUM(sale_items.subtotal) y SUM(neto_linea) == total.
      const item = call.data.items.create[0];
      expect(new Prisma.Decimal(item.subtotal).toString()).toBe(
        expectedSubtotal.toString(),
      );
      expect(new Prisma.Decimal(item.netoLinea).toString()).toBe(
        expectedSubtotal.toString(),
      );
      expect(new Prisma.Decimal(item.netoUnitario).toString()).toBe(
        variant.precioVenta.toString(),
      );
      expect(item.descripcionSnapshot.length).toBeGreaterThan(0);
      expect(item.precioUnitario.toString()).toBe(
        variant.precioVenta.toString(),
      );
      expect(item.costoUnitario.toString()).toBe(
        variant.costoActual.toString(),
      );

      // Descuenta stock una vez, con los datos correctos (contrato de la
      // spec, sección 4.2: variantId, cantidad, saleId, userId,
      // permitirStockNegativo).
      expect(deps.stockService.descontarPorVenta).toHaveBeenCalledTimes(1);
      expect(deps.stockService.descontarPorVenta).toHaveBeenCalledWith(
        asTx(tx),
        expect.objectContaining({
          variantId: 10,
          cantidad: 2,
          saleId: 501,
          userId: 7,
          permitirStockNegativo: false,
        }),
      );

      // Invariante 7: el único pago es EFECTIVO → un solo movimiento de
      // caja, tipo VENTA, referenciando la venta, por el monto correcto.
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      expect(deps.cashRegisterService.registrarMovimiento).toHaveBeenCalledWith(
        asTx(tx),
        expect.objectContaining({
          sessionId: 1,
          tipo: 'VENTA',
          referenciaTipo: 'SALE',
          referenciaId: 501,
          userId: 7,
        }),
      );
      const movimientoCall =
        deps.cashRegisterService.registrarMovimiento.mock.calls[0][1];
      expect(new Prisma.Decimal(movimientoCall.monto).toString()).toBe(
        expectedSubtotal.toString(),
      );
    });

    it('pago 100% tarjeta: NO llama a registrarMovimiento (invariante 7)', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.TARJETA_CREDITO,
            monto: new Prisma.Decimal('100.00'),
          },
        ],
      });

      expect(deps.stockService.descontarPorVenta).toHaveBeenCalledTimes(1);
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('pago mixto (efectivo + tarjeta): el movimiento de caja es solo por la parte en efectivo', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('300.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('120.00'),
          },
          {
            metodo: PaymentMetodo.TARJETA_DEBITO,
            monto: new Prisma.Decimal('180.00'),
          },
        ],
      });

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const movimientoCall =
        deps.cashRegisterService.registrarMovimiento.mock.calls[0][1];
      expect(new Prisma.Decimal(movimientoCall.monto).toString()).toBe('120');
    });

    it('varios pagos EFECTIVO en la misma venta se suman en UN solo movimiento de caja, no uno por pago (RN-1 paso 7)', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('300.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.00'),
          },
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('200.00'),
          },
        ],
      });

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const movimientoCall =
        deps.cashRegisterService.registrarMovimiento.mock.calls[0][1];
      expect(new Prisma.Decimal(movimientoCall.monto).toString()).toBe('300');
    });
  });

  describe('RN-7 — agregación de cantidad por variante', () => {
    it('dos líneas de la MISMA variante: la cantidad descontada es la suma, con un descontarPorVenta por línea (no fusionado)', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 10 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [
          { variantId: 10, cantidad: 3 },
          { variantId: 10, cantidad: 4 },
        ],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('700.00'),
          },
        ],
      });

      // "un stock_movements por línea" (BLUEPRINT §5.3 paso 6) — dos
      // llamadas, una por cada línea, con su propia cantidad.
      expect(deps.stockService.descontarPorVenta).toHaveBeenCalledTimes(2);
      const cantidades = deps.stockService.descontarPorVenta.mock.calls
        .map((c) => (c[1] as { cantidad: number }).cantidad)
        .sort((a, b) => a - b);
      expect(cantidades).toEqual([3, 4]);
    });

    it('vender 3+3 unidades de una variante con stock 5 se rechaza junto (RN-7: la suma de las líneas, no cada una por separado)', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          esOwner: true,
          idempotencyKey: 'idem-test-key',
          items: [
            { variantId: 10, cantidad: 3 },
            { variantId: 10, cantidad: 3 },
          ],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('600.00'),
            },
          ],
        }),
      ).rejects.toThrow(/insuficiente/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });
  });

  describe('RN-3 — stock insuficiente y permitir_venta_sin_stock', () => {
    it('vender 3 unidades de una variante con stock 2 se rechaza y no genera ningún movimiento de stock ni de caja', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 2 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          esOwner: true,
          idempotencyKey: 'idem-test-key',
          items: [{ variantId: 10, cantidad: 3 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('300.00'),
            },
          ],
        }),
      ).rejects.toThrow(/insuficiente/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('permitir_venta_sin_stock = true: permite la venta igual con stock insuficiente', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 1 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps({
        settingsService: {
          getBool: jest
            .fn<Promise<boolean>, [string]>()
            .mockResolvedValue(true),
          getInt: jest.fn<Promise<number>, [string]>().mockResolvedValue(10),
        },
      });
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          esOwner: true,
          idempotencyKey: 'idem-test-key',
          items: [{ variantId: 10, cantidad: 5 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('500.00'),
            },
          ],
        }),
      ).resolves.toBeDefined();

      expect(deps.stockService.descontarPorVenta).toHaveBeenCalledWith(
        asTx(tx),
        expect.objectContaining({ permitirStockNegativo: true }),
      );
    });

    it('lee permitir_venta_sin_stock de SettingsService con la clave exacta', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.00'),
          },
        ],
      });

      expect(deps.settingsService.getBool).toHaveBeenCalledWith(
        'permitir_venta_sin_stock',
      );
    });
  });

  describe('invariante 3 — SUM(payments.monto) == sales.total', () => {
    it('la suma de los pagos distinta del total rechaza la venta antes de escribir nada', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          esOwner: true,
          idempotencyKey: 'idem-test-key',
          items: [{ variantId: 10, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('90.00'),
            },
          ],
        }),
      ).rejects.toThrow(/no cubren|total/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('la suma de los pagos que EXCEDE el total también rechaza (la igualdad tiene que ser exacta)', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          esOwner: true,
          idempotencyKey: 'idem-test-key',
          items: [{ variantId: 10, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      ).rejects.toThrow(/no cubren|total/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
    });
  });

  describe('RN-1 paso 1 — sesión de caja abierta, siempre (hallazgo sección 5 de la spec)', () => {
    it('sin sesión de caja abierta: rechaza con el mismo mensaje que cash-registers, sin escribir nada', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps({
        cashRegisterService: {
          getSesionAbiertaOrThrow: jest
            .fn<Promise<SessionRow>, [unknown]>()
            .mockRejectedValue(new Error('No hay una sesión de caja abierta')),
          registrarMovimiento: jest.fn<
            Promise<{ id: number }>,
            [unknown, { monto: Prisma.Decimal.Value }]
          >(),
        },
      });
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          esOwner: true,
          idempotencyKey: 'idem-test-key',
          items: [{ variantId: 10, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('100.00'),
            },
          ],
        }),
      ).rejects.toThrow(/sesi[oó]n.*abiert/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('toma el lock de la fila de sesión SIEMPRE, incluso en una venta sin ningún pago en efectivo (hallazgo real de la sección 5 de la spec)', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.TARJETA_CREDITO,
            monto: new Prisma.Decimal('100.00'),
          },
        ],
      });

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();

      const sessionLockCall = tx.$queryRaw.mock.calls.find((call) =>
        sqlText(call).includes('cash_register_sessions'),
      );
      expect(sessionLockCall).toBeDefined();
      expect(sqlText(sessionLockCall!)).toContain('for update');
      expect(sessionLockCall![1]).toBe(1);
    });
  });

  describe('BLUEPRINT §9.4 — lock de variantes ordenado por id', () => {
    it('toma un solo lock de las variantes involucradas, ordenado por id ascendente, antes de leer/validar stock', async () => {
      const rows = [
        buildVariantRow({ id: 30, stockActual: 10 }),
        buildVariantRow({ id: 10, stockActual: 10 }),
        buildVariantRow({ id: 20, stockActual: 10 }),
      ];
      const tx = buildMockTx(rows);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [
          { variantId: 30, cantidad: 1 },
          { variantId: 10, cantidad: 1 },
          { variantId: 20, cantidad: 1 },
        ],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('300.00'),
          },
        ],
      });

      const variantLockCalls = tx.$queryRaw.mock.calls.filter((call) =>
        sqlText(call).includes('variants'),
      );
      expect(variantLockCalls).toHaveLength(1);

      const variantLockCall = variantLockCalls[0];
      expect(sqlText(variantLockCall)).toContain('for update');
      expect(sqlText(variantLockCall)).toContain('order by id');

      const joinArg = variantLockCall[1] as Prisma.Sql;
      expect(joinArg.values).toEqual([10, 20, 30]);

      // El lock de variantes ocurre antes de leer el stock real.
      const lockCallIndex = tx.$queryRaw.mock.calls.indexOf(variantLockCall);
      const lockOrder = tx.$queryRaw.mock.invocationCallOrder[lockCallIndex];
      const findManyOrder = tx.variant.findMany.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(findManyOrder);
    });
  });

  // Invariante 4: `total == subtotal - descuento_total + ajuste_redondeo`,
  // con `total >= 0` de forma explícita e independiente de las otras
  // cláusulas (hallazgo real de la spec, sección 3: la combinación de
  // `0 <= descuento_total <= subtotal` y `|ajuste_redondeo| < 1` NO
  // garantiza `total >= 0` por sí sola). En T4.1, `descuento_total` y
  // `ajuste_redondeo` estaban fijos en 0, así que el escenario del
  // hallazgo (`subtotal=$0.50, descuento=$0.50, ajuste=-$0.90 →
  // total=-$0.90`) no era alcanzable con los inputs que ese ticket
  // aceptaba — quedó como `it.todo` reservado explícitamente para T4.6,
  // que es donde `ajusteRedondeo` deja de estar fijo en 0. Convertido acá
  // en un test real, con exactamente los mismos números del hallazgo (no
  // se cambia la intención original del caso).
  describe('invariante 4 — total >= 0', () => {
    it('total resultante negativo se rechaza (T4.6: ajusteRedondeo deja de estar fijo en 0) — mismos números del hallazgo de la spec: subtotal=$0.50, descuento_total=$0.50, ajuste_redondeo=-$0.90 → total=-$0.90, sin escribir nada', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('0.50'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      // El total (-$0.90) es intrínsecamente impagable con un monto
      // positivo real, así que el pago no puede "coincidir" con él bajo
      // ningún criterio — se manda un monto positivo arbitrario ($1.00),
      // deliberadamente distinto de cualquier total posible, para que el
      // rechazo solo pueda venir de la validación de `total >= 0` (que
      // tiene que ocurrir ANTES de comparar contra los pagos, mismo
      // criterio que el resto de las validaciones tempranas del archivo).
      // Un pago de $0 dispararía en cambio la validación, ya existente,
      // de "el monto de cada pago tiene que ser mayor a 0" — un rechazo
      // real pero por una razón distinta a la que este test verifica.
      const input: CrearVentaInputT46 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          { metodo: PaymentMetodo.EFECTIVO, monto: new Prisma.Decimal('1.00') },
        ],
        discounts: [
          { descripcion: 'Descuento total', monto: new Prisma.Decimal('0.50') },
        ],
        ajusteRedondeo: new Prisma.Decimal('-0.90'),
      };

      await expect(service.crearVenta(asTx(tx), input)).rejects.toThrow(
        /ajuste de redondeo deja el total en negativo/i,
      );

      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });
  });
});

describe('SalesService.crearVenta — T4.3 descuentos (RN-4, RN-5, invariante 4, AMB-14 diferida)', () => {
  describe('tope duro — 0 ≤ descuento_total ≤ subtotal, siempre, para cualquier rol', () => {
    it('descuento_total > subtotal con esOwner: true se rechaza igual (invariante 4), sin escribir nada', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          { metodo: PaymentMetodo.EFECTIVO, monto: new Prisma.Decimal('0') },
        ],
        discounts: [
          {
            descripcion: 'Descuento excesivo',
            monto: new Prisma.Decimal('150.00'),
          },
        ],
      };

      await expect(service.crearVenta(asTx(tx), input)).rejects.toThrow(
        /subtotal/i,
      );

      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('descuento_total > subtotal con esOwner: false también se rechaza (el tope duro no depende del rol)', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: false,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          { metodo: PaymentMetodo.EFECTIVO, monto: new Prisma.Decimal('0') },
        ],
        discounts: [
          {
            descripcion: 'Descuento excesivo',
            monto: new Prisma.Decimal('101.00'),
          },
        ],
      };

      await expect(service.crearVenta(asTx(tx), input)).rejects.toThrow(
        /subtotal/i,
      );
      expect(tx.sale.create).not.toHaveBeenCalled();
    });
  });

  describe('tope del vendedor (max_descuento_vendedor_pct) — solo se evalúa si esOwner === false', () => {
    it('esOwner: false, 8% de descuento con tope 10%: pasa sin problema', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('1000.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);
      const monto = applyPercentage('1000.00', '8');

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: false,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('1000.00').minus(monto),
          },
        ],
        discounts: [{ descripcion: 'Promo 8%', porcentaje: '8', monto }],
      };

      await expect(service.crearVenta(asTx(tx), input)).resolves.toBeDefined();
      expect(tx.sale.create).toHaveBeenCalledTimes(1);
    });

    it('esOwner: false, 15% de descuento con tope 10%: se rechaza, sin escribir nada, sin mecanismo de autorización (AMB-14 diferida)', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('1000.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);
      const monto = applyPercentage('1000.00', '15');

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: false,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('1000.00').minus(monto),
          },
        ],
        discounts: [{ descripcion: 'Promo 15%', porcentaje: '15', monto }],
      };

      await expect(service.crearVenta(asTx(tx), input)).rejects.toThrow(
        /l[ií]mite.*vendedor|vendedor.*l[ií]mite/i,
      );
      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('esOwner: false, dos descuentos manuales del 8% cada uno (16% agregado): se rechaza — el tope se evalúa sobre descuento_total, no por descuento separado', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('1000.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);
      const montoCadaUno = applyPercentage('1000.00', '8');

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: false,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('1000.00')
              .minus(montoCadaUno)
              .minus(montoCadaUno),
          },
        ],
        discounts: [
          { descripcion: 'Promo 8% (1)', porcentaje: '8', monto: montoCadaUno },
          { descripcion: 'Promo 8% (2)', porcentaje: '8', monto: montoCadaUno },
        ],
      };

      await expect(service.crearVenta(asTx(tx), input)).rejects.toThrow(
        /l[ií]mite.*vendedor|vendedor.*l[ií]mite/i,
      );
      expect(tx.sale.create).not.toHaveBeenCalled();
    });

    it('esOwner: true, 50% de descuento (muy por encima del tope del vendedor): pasa igual, sin evaluar el tope del vendedor en absoluto', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('1000.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);
      const monto = applyPercentage('1000.00', '50');

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('1000.00').minus(monto),
          },
        ],
        discounts: [
          { descripcion: 'Descuento de la dueña', porcentaje: '50', monto },
        ],
      };

      await expect(service.crearVenta(asTx(tx), input)).resolves.toBeDefined();
      expect(tx.sale.create).toHaveBeenCalledTimes(1);
      // "sin evaluar el tope del vendedor en absoluto" — ni siquiera se
      // consulta el setting cuando esOwner es true.
      expect(deps.settingsService.getInt).not.toHaveBeenCalled();
    });
  });

  describe('registro de sale_discounts (RN-4) — camino feliz', () => {
    it('descuento manual por monto, esOwner: true: sale_discounts queda con tipo MANUAL, descripcion, monto, SIN porcentaje, autorizado_por_user_id null', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('500.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('450.00'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento manual',
            monto: new Prisma.Decimal('50.00'),
          },
        ],
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.descuentoTotal).toString()).toBe(
        '50',
      );
      expect(call.data.discounts?.create).toHaveLength(1);
      const discount = call.data.discounts!.create[0];
      expect(discount.tipo).toBe('MANUAL');
      expect(discount.descripcion).toBe('Descuento manual');
      expect(new Prisma.Decimal(discount.monto).toString()).toBe('50');
      expect(discount.porcentaje == null).toBe(true);
      expect(discount.autorizadoPorUserId).toBeNull();
    });

    it('descuento manual por monto, esOwner: false (dentro del tope): mismo resultado, autorizado_por_user_id también null', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('500.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: false,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('475.00'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento manual chico',
            monto: new Prisma.Decimal('25.00'),
          },
        ],
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      const discount = call.data.discounts!.create[0];
      expect(discount.autorizadoPorUserId).toBeNull();
    });

    it('descuento cargado como porcentaje: el monto efectivo coincide con applyPercentage(subtotal, porcentaje) y se guarda el porcentaje', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('333.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);
      const montoEsperado = applyPercentage('333.00', '10');

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: false,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('333.00').minus(montoEsperado),
          },
        ],
        discounts: [
          { descripcion: 'Promo 10%', porcentaje: new Prisma.Decimal('10') },
        ],
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      const discount = call.data.discounts!.create[0];
      expect(new Prisma.Decimal(discount.monto).toString()).toBe(
        montoEsperado.toString(),
      );
      expect(new Prisma.Decimal(discount.porcentaje!).toString()).toBe('10');
    });
  });

  describe('prorrateo real a las líneas (AD-18, RN-5) — con descuento > 0, neto_linea usa prorate()', () => {
    it('3 líneas, descuento que deja residuo naïve: SUM(neto_linea) da exactamente el total, ajustado a la línea de mayor neto (mismos números que el test obligatorio #2 de BLUEPRINT §9.3)', async () => {
      // subtotal = 10.00 + 10.00 + 10.01 = 30.01; descuento manual 3.01;
      // total = 27.00. `prorate(['10.00','10.00','10.01'], '27.00')` ya
      // está probado en `money.util.spec.ts` y da ['9.00','9.00','9.00'].
      const v1 = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('10.00'),
      });
      const v2 = buildVariantRow({
        id: 20,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('10.00'),
      });
      const v3 = buildVariantRow({
        id: 30,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('10.01'),
      });
      const tx = buildMockTx([v1, v2, v3]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: true, // evita cualquier interacción con el tope del vendedor
        idempotencyKey: 'idem-test-key',
        items: [
          { variantId: 10, cantidad: 1 },
          { variantId: 20, cantidad: 1 },
          { variantId: 30, cantidad: 1 },
        ],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('27.00'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento variado',
            monto: new Prisma.Decimal('3.01'),
          },
        ],
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.total).toString()).toBe('27');

      const netos = call.data.items.create.map((item) =>
        new Prisma.Decimal(item.netoLinea).toFixed(2),
      );
      const expectedNetos = prorate(['10.00', '10.00', '10.01'], '27.00').map(
        (n) => n.toFixed(2),
      );
      expect(netos).toEqual(expectedNetos);

      const sumNetos = call.data.items.create.reduce(
        (sum, item) => sum.plus(new Prisma.Decimal(item.netoLinea)),
        new Prisma.Decimal(0),
      );
      expect(sumNetos.toFixed(2)).toBe('27.00');
    });
  });

  describe('BLUEPRINT §9.3, tests obligatorios — flujo completo de una venta real (no solo la primitiva de common/money)', () => {
    it('test obligatorio #1: 15% de descuento sobre $2.999 da un total de $2.549,15, persistido en la venta completa', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('2999.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: true, // 15% > tope del 10% del vendedor
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('2549.15'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento 15%',
            porcentaje: new Prisma.Decimal('15'),
          },
        ],
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.subtotal).toString()).toBe('2999');
      expect(new Prisma.Decimal(call.data.descuentoTotal).toString()).toBe(
        '449.85',
      );
      expect(new Prisma.Decimal(call.data.total).toString()).toBe('2549.15');
      const item = call.data.items.create[0];
      expect(new Prisma.Decimal(item.netoLinea).toString()).toBe('2549.15');
    });

    // Test obligatorio #2 de BLUEPRINT §9.3 (venta de 3 líneas con
    // descuento cuyo prorrateo naïve deja residuo, SUM(neto_linea) == total
    // exacto): no se duplica acá como test aparte — es exactamente el test
    // 'prorrateo real a las líneas (AD-18, RN-5)' de más arriba, con los
    // mismos números del ejemplo de BLUEPRINT §9.3 (10.00 + 10.00 + 10.01,
    // total 27.00). Un test que solo repitiera esa aserción sin agregar
    // nada no verificaría nada nuevo (violaría la regla de la fase 04a de
    // no escribir tests que no prueben algo real).
  });

  describe('invariante 12 — subtotal == SUM(sale_items.subtotal), descuento_total == SUM(sale_discounts.monto), SUM(sale_items.neto_linea) == total', () => {
    it('con descuento real, las tres igualdades se cumplen exactamente', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('200.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: false,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 2 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('360.00'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento 10%',
            porcentaje: '10',
            monto: new Prisma.Decimal('40.00'),
          },
        ],
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      const subtotalLinea = lineSubtotal(2, variant.precioVenta);
      expect(new Prisma.Decimal(call.data.subtotal).toString()).toBe(
        subtotalLinea.toString(),
      );
      const sumItemSubtotal = call.data.items.create.reduce(
        (sum, item) => sum.plus(new Prisma.Decimal(item.subtotal)),
        new Prisma.Decimal(0),
      );
      expect(sumItemSubtotal.toString()).toBe(
        new Prisma.Decimal(call.data.subtotal).toString(),
      );

      const sumDiscountMonto = (call.data.discounts?.create ?? []).reduce(
        (sum, d) => sum.plus(new Prisma.Decimal(d.monto)),
        new Prisma.Decimal(0),
      );
      expect(sumDiscountMonto.toString()).toBe(
        new Prisma.Decimal(call.data.descuentoTotal).toString(),
      );

      const sumNetoLinea = call.data.items.create.reduce(
        (sum, item) => sum.plus(new Prisma.Decimal(item.netoLinea)),
        new Prisma.Decimal(0),
      );
      expect(sumNetoLinea.toString()).toBe(
        new Prisma.Decimal(call.data.total).toString(),
      );
    });
  });

  describe('regresión — esOwner ahora es obligatorio, pero sin discounts sigue funcionando como T4.1/T4.2', () => {
    it('discounts ausente, esOwner: false: descuento_total en 0, total == subtotal, igual que antes de T4.3', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT43 = {
        userId: 7,
        esOwner: false,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.00'),
          },
        ],
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.descuentoTotal).toString()).toBe('0');
      expect(new Prisma.Decimal(call.data.total).toString()).toBe('100');
    });
  });
});

// ─── Fase 04a (T4.4) — agregado sobre lo de arriba, sesión aparte ─────────
//
// T4.4 ("Pagos: N por venta, validación suma = total, impacto en caja solo
// si es efectivo") ya está MAYORMENTE construido — fue parte del trabajo
// necesario de T4.1 (no se puede validar/cerrar una venta sin resolver los
// pagos desde el principio, BLUEPRINT §5.3 paso 5, invariantes 3 y 7). Los
// tests de abajo NO reconstruyen ese flujo desde cero — verifican a fondo
// lo que la especificación exige de `payments`, incluyendo el hallazgo de
// CLAUDE.md: un pago con `monto <= 0` combinado con otro que hace que la
// SUMA total siga dando exactamente `sales.total` (invariante 3) pasa el
// único chequeo agregado que existe (la suma), y en la implementación real
// no hay ningún chequeo POR PAGO de `monto > 0` antes de escribir — recién
// explota contra el `CHECK (monto > 0)` crudo de la tabla `payments`
// (confirmado empíricamente en la sesión de integración contra Postgres
// real, no acá: acá el mock no tiene ese CHECK, así que lo que este test
// mockeado verifica es la ausencia de una validación de APLICACIÓN previa
// — si el servicio real no la tiene, `tx.sale.create` se llama igual y la
// promesa RESUELVE en vez de rechazar, lo que hace fallar este test por la
// razón correcta).
//
// Fuente: `BLUEPRINT.md` §5.3 (paso 5), §3.4 (modelo `payments`), AD-3,
// AD-8, invariantes 3 y 7; `state/reports/modulo-sales-spec.md` (RN-1 paso
// 5, sección 3 invariantes 3/7, sección 6 "cantidad en cero o negativa"
// como precedente directo de criterio: "más validación de DTO para un 400
// limpio en vez del CHECK crudo, mismo criterio que el resto del sistema"
// — hoy `payments.monto` no tiene ese equivalente); `schema.prisma` (enum
// `PaymentMetodo`, campo `referencia`); migración init
// (`payments_monto_check CHECK (monto > 0)`, dato de schema).
describe('SalesService.crearVenta — T4.4 pagos (RN-1 paso 5, invariantes 3 y 7, AD-3, AD-8)', () => {
  describe('hallazgo (CLAUDE.md) — pago con monto <= 0 que igual suma el total correcto', () => {
    it('un pago de monto $0 + un pago que cubre el total exacto: no debe pasar como venta válida, se espera un rechazo de validación limpio antes de escribir nada', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          esOwner: true,
          idempotencyKey: 'idem-test-key',
          items: [{ variantId: 10, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('0.00'),
            },
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('100.00'),
            },
          ],
        }),
      ).rejects.toThrow(/monto.*(positivo|mayor a 0|inv[aá]lido)/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('un pago con monto NEGATIVO + un pago que compensa la suma al total exacto: mismo rechazo esperado', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          esOwner: true,
          idempotencyKey: 'idem-test-key',
          items: [{ variantId: 10, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('-50.00'),
            },
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      ).rejects.toThrow(/monto.*(positivo|mayor a 0|inv[aá]lido)/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
    });
  });

  describe('N pagos reales de métodos distintos — todos los métodos del enum aparecen en algún test (AD-3, invariante 7)', () => {
    it('4 pagos, uno de cada método (EFECTIVO, TARJETA_DEBITO, TARJETA_CREDITO, TRANSFERENCIA): la caja se mueve solo por la parte en EFECTIVO', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('1000.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('250.00'),
          },
          {
            metodo: PaymentMetodo.TARJETA_DEBITO,
            monto: new Prisma.Decimal('250.00'),
          },
          {
            metodo: PaymentMetodo.TARJETA_CREDITO,
            monto: new Prisma.Decimal('250.00'),
          },
          {
            metodo: PaymentMetodo.TRANSFERENCIA,
            monto: new Prisma.Decimal('250.00'),
          },
        ],
      });

      const call = tx.sale.create.mock.calls[0][0];
      expect(call.data.payments.create).toHaveLength(4);
      expect(new Prisma.Decimal(call.data.total).toString()).toBe('1000');

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const movimientoCall =
        deps.cashRegisterService.registrarMovimiento.mock.calls[0][1];
      expect(new Prisma.Decimal(movimientoCall.monto).toString()).toBe('250');
    });

    it('N pagos con MÁS de un EFECTIVO mezclados con otros métodos (2 efectivo + crédito + transferencia): un solo movimiento de caja con la suma de los dos efectivo', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('500.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.00'),
          },
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.00'),
          },
          {
            metodo: PaymentMetodo.TARJETA_CREDITO,
            monto: new Prisma.Decimal('150.00'),
          },
          {
            metodo: PaymentMetodo.TRANSFERENCIA,
            monto: new Prisma.Decimal('150.00'),
          },
        ],
      });

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const movimientoCall =
        deps.cashRegisterService.registrarMovimiento.mock.calls[0][1];
      expect(new Prisma.Decimal(movimientoCall.monto).toString()).toBe('200');
    });

    it('ningún pago en EFECTIVO, N pagos de otros métodos (débito + crédito + transferencia): no llama a registrarMovimiento', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('900.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.TARJETA_DEBITO,
            monto: new Prisma.Decimal('300.00'),
          },
          {
            metodo: PaymentMetodo.TARJETA_CREDITO,
            monto: new Prisma.Decimal('300.00'),
          },
          {
            metodo: PaymentMetodo.TRANSFERENCIA,
            monto: new Prisma.Decimal('300.00'),
          },
        ],
      });

      expect(deps.stockService.descontarPorVenta).toHaveBeenCalledTimes(1);
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });
  });

  describe('campo referencia (BLUEPRINT §3.4: "últimos dígitos, nº de operación") — forma exacta del payload armado para tx.sale.create', () => {
    it('se pasa tal cual a payments.create cuando se manda', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('300.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.TARJETA_DEBITO,
            monto: new Prisma.Decimal('300.00'),
            referencia: '4242',
          },
        ],
      });

      const call = tx.sale.create.mock.calls[0][0];
      expect(call.data.payments.create[0].referencia).toBe('4242');
    });

    it('sin referencia: queda null en el payload armado, nunca undefined ni string vacío', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('150.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('150.00'),
          },
        ],
      });

      const call = tx.sale.create.mock.calls[0][0];
      const referencia = call.data.payments.create[0].referencia;
      expect(referencia).toBeNull();
      expect(referencia).not.toBe('');
      expect(referencia).not.toBeUndefined();
    });
  });
});

// ─── Fase 04a (T4.5) — agregado sobre lo de arriba, sesión aparte ─────────
//
// T4.5 ("Aplicar el interceptor de idempotencia a la venta") tiene el
// alcance real recortado y decidido de antemano (ver `ROADMAP.md`, nota de
// esta fecha bajo la Etapa 4, y el propio ticket): `sales` no tiene
// `SalesController` ni módulo Nest todavía (T4.1-T4.4 construyeron
// únicamente `SalesService`, a propósito — los controllers son
// T4.10/T4.11), así que no hay ninguna ruta HTTP donde aplicar
// `IdempotencyInterceptor`/`@IdempotencyKey()` de verdad. Lo que sí es
// responsabilidad de este ticket: (1) `crearVenta` acepta
// `idempotencyKey: string` obligatorio, (2) lo persiste tal cual en
// `sales.idempotency_key` vía `tx.sale.create`, (3) NO lo envuelve con
// `withIdempotency` (esa responsabilidad es de quien abre la transacción
// — el futuro controller). El mecanismo de punta a punta (índice único +
// `withIdempotency`) ya está probado empíricamente contra Postgres real en
// `test/integration/sales-idempotency.integration.spec.ts`, envolviendo
// manualmente `prisma.$transaction((tx) => salesService.crearVenta(tx,
// input))` con `withIdempotency`, exactamente como lo haría el futuro
// controller — no se prueba acá contra un mock, porque lo que hay que
// probar (violación real de unicidad bajo choque) un mock no lo reproduce.
//
// Esta sesión no abrió `sales.service.ts`. Fuente: `ROADMAP.md` (T4.5),
// `BLUEPRINT.md` §9.7 y AD-10 (sección 2),
// `state/reports/modulo-sales-spec.md` RN-9, `schema.prisma`
// (`sales.idempotency_key`, `String? @unique`, ya confirmado desde la fase
// 01), y `common/idempotency/idempotency.util.ts`/`idempotency.interceptor.ts`
// (infraestructura ya construida en T0.14, leídos completos como tooling,
// no como lógica de negocio de `sales`).
describe('SalesService.crearVenta — T4.5 idempotencia (RN-9, AD-10, §9.7)', () => {
  it('pasa el idempotencyKey recibido tal cual a tx.sale.create, sin transformarlo', async () => {
    const variant = buildVariantRow({ id: 10, stockActual: 5 });
    const tx = buildMockTx([variant]);
    const deps = buildDeps();
    const service = buildService(deps);
    const key = 'idem-key-11111111-2222-3333-4444-555555555555';

    const input: CrearVentaInputT45 = {
      userId: 7,
      esOwner: true,
      idempotencyKey: key,
      items: [{ variantId: 10, cantidad: 1 }],
      payments: [
        { metodo: PaymentMetodo.EFECTIVO, monto: new Prisma.Decimal('100.00') },
      ],
    };

    await service.crearVenta(asTx(tx), input);

    expect(tx.sale.create).toHaveBeenCalledTimes(1);
    const call = tx.sale.create.mock.calls[0][0];
    expect(call.data.idempotencyKey).toBe(key);
  });

  it('dos ventas distintas (idempotencyKey distinta en cada una) persisten cada una su propia clave, sin pisarse entre sí', async () => {
    const variant = buildVariantRow({ id: 10, stockActual: 10 });
    const tx = buildMockTx([variant]);
    const deps = buildDeps();
    const service = buildService(deps);

    const inputA: CrearVentaInputT45 = {
      userId: 7,
      esOwner: true,
      idempotencyKey: 'key-a-11111111-2222-3333-4444-555555555555',
      items: [{ variantId: 10, cantidad: 1 }],
      payments: [
        { metodo: PaymentMetodo.EFECTIVO, monto: new Prisma.Decimal('100.00') },
      ],
    };
    const inputB: CrearVentaInputT45 = {
      userId: 7,
      esOwner: true,
      idempotencyKey: 'key-b-11111111-2222-3333-4444-555555555555',
      items: [{ variantId: 10, cantidad: 1 }],
      payments: [
        { metodo: PaymentMetodo.EFECTIVO, monto: new Prisma.Decimal('100.00') },
      ],
    };

    await service.crearVenta(asTx(tx), inputA);
    await service.crearVenta(asTx(tx), inputB);

    expect(tx.sale.create).toHaveBeenCalledTimes(2);
    const callA = tx.sale.create.mock.calls[0][0];
    const callB = tx.sale.create.mock.calls[1][0];
    expect(callA.data.idempotencyKey).toBe(inputA.idempotencyKey);
    expect(callB.data.idempotencyKey).toBe(inputB.idempotencyKey);
  });
});

// ─── Fase 04a (T4.6) — ajuste de redondeo (RN-6, AD-14, invariante 4) ─────
//
// Ver el bloque de comentario junto a `CrearVentaInputT46` (arriba, cerca
// de `buildService`) para la fuente completa y el contrato ampliado
// decidido en esta sesión. Resumen: `input += { ajusteRedondeo?:
// Prisma.Decimal.Value }`, default `0` si se omite.
describe('SalesService.crearVenta — T4.6 ajuste de redondeo (RN-6, AD-14, invariante 4)', () => {
  // Los dos tests de este describe (`ausente` y `= 0 explícito`) verifican
  // compatibilidad hacia atrás, no funcionalidad nueva — hoy, sin
  // implementación de T4.6, `ajusteRedondeo` ya se comporta como si fuera
  // 0 (el servicio ni siquiera lo lee), así que YA pasan antes de
  // implementar. Mismo criterio que el describe 'regresión — esOwner
  // ahora es obligatorio...' de la sección T4.3 más arriba (línea ~1503):
  // un test de compatibilidad legítimo no tiene por qué estar en rojo,
  // porque su punto es justamente que el comportamiento viejo no cambie —
  // tienen que seguir pasando también DESPUÉS de implementar T4.6, como
  // guardas de regresión (ej.: que la implementación real no trate un
  // `Decimal('0')` explícito distinto de un valor ausente).
  describe('valor por defecto — compatibilidad con T4.1-T4.5', () => {
    it('ajusteRedondeo ausente del input: persiste ajusteRedondeo = 0 en tx.sale.create, total == subtotal - descuentoTotal sin cambios', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      // Se pasa como CrearVentaInputT45 a propósito (mismo tipo que las
      // llamadas preexistentes de T4.1-T4.5): confirma que el campo nuevo
      // es opcional y que omitirlo no rompe nada de lo ya construido.
      const input: CrearVentaInputT45 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          { metodo: PaymentMetodo.EFECTIVO, monto: new Prisma.Decimal('100.00') },
        ],
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.ajusteRedondeo).toString()).toBe(
        '0',
      );
      expect(new Prisma.Decimal(call.data.total).toString()).toBe('100');
    });
  });

  describe('límite |ajuste_redondeo| < 1 (RN-6)', () => {
    it('ajusteRedondeo = 0.99 (justo dentro del límite): acepta', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT46 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.99'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('0.99'),
      };

      await expect(service.crearVenta(asTx(tx), input)).resolves.toBeDefined();
      expect(tx.sale.create).toHaveBeenCalledTimes(1);
    });

    it('ajusteRedondeo = -0.99 (justo dentro del límite, negativo): acepta', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT46 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('99.01'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('-0.99'),
      };

      await expect(service.crearVenta(asTx(tx), input)).resolves.toBeDefined();
      expect(tx.sale.create).toHaveBeenCalledTimes(1);
    });

    it('ajusteRedondeo = 1.00 (llega al límite, ya no es menor a 1): rechaza, sin escribir nada', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT46 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('101.00'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('1.00'),
      };

      await expect(service.crearVenta(asTx(tx), input)).rejects.toThrow(
        /ajuste.*redondeo/i,
      );
      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('ajusteRedondeo = -1.00 (llega al límite negativo): rechaza, sin escribir nada', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT46 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('99.00'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('-1.00'),
      };

      await expect(service.crearVenta(asTx(tx), input)).rejects.toThrow(
        /ajuste.*redondeo/i,
      );
      expect(tx.sale.create).not.toHaveBeenCalled();
    });

    it('ajusteRedondeo = 5.00 (muy por encima del límite): rechaza igual', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT46 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('105.00'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('5.00'),
      };

      await expect(service.crearVenta(asTx(tx), input)).rejects.toThrow(
        /ajuste.*redondeo/i,
      );
      expect(tx.sale.create).not.toHaveBeenCalled();
    });
  });

  describe('total = subtotal - descuento_total + ajuste_redondeo (invariante 4)', () => {
    it('ajusteRedondeo positivo, sin descuento: total = subtotal + ajusteRedondeo', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT46 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.30'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('0.30'),
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.subtotal).toString()).toBe('100');
      expect(new Prisma.Decimal(call.data.ajusteRedondeo).toString()).toBe(
        '0.3',
      );
      expect(new Prisma.Decimal(call.data.total).toString()).toBe('100.3');
    });

    it('ajusteRedondeo negativo, sin descuento: total = subtotal + ajusteRedondeo (resta)', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT46 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('99.85'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('-0.15'),
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.total).toString()).toBe('99.85');
    });

    it('ajusteRedondeo = 0 explícito: equivalente a omitirlo, total == subtotal', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT46 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.00'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('0'),
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.total).toString()).toBe('100');
    });

    // Ejemplo textual de AD-14 (BLUEPRINT.md, motivo de la regla): "un 15%
    // sobre $2.999 da $449,85 y el total $2.549,15. Si se cobran $2.549 sin
    // un ajuste explícito, la suma de pagos deja de igualar al total y el
    // sistema rechaza una venta perfectamente normal." Este test arma
    // exactamente ese escenario con `ajusteRedondeo = -0.15` (lo que hace
    // falta para que el total post-descuento de $2.549,15 baje a los
    // $2.549 que se cobran en el mostrador) y confirma que
    // `subtotal - descuento_total + ajuste_redondeo` da el total correcto,
    // aceptando pagos por esa cifra redondeada.
    it('caso motivador de AD-14: 15% de descuento sobre $2.999 + ajusteRedondeo = -$0.15 para cobrar $2.549 exactos', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('2999.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT46 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('2549.00'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento 15%',
            porcentaje: new Prisma.Decimal('15'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('-0.15'),
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.subtotal).toString()).toBe('2999');
      expect(new Prisma.Decimal(call.data.descuentoTotal).toString()).toBe(
        '449.85',
      );
      expect(new Prisma.Decimal(call.data.ajusteRedondeo).toString()).toBe(
        '-0.15',
      );
      expect(new Prisma.Decimal(call.data.total).toString()).toBe('2549');
    });
  });

  describe('prorrateo usa el total FINAL, con el ajuste ya aplicado (AD-18, RN-5)', () => {
    it('3 líneas, descuento + ajusteRedondeo combinados: netoLinea usa prorate(subtotalesDeLinea, total_final), no el subtotal ni el total sin ajustar', async () => {
      // subtotal = 10.00 + 10.00 + 10.01 = 30.01; descuentoTotal = 3.01;
      // ajusteRedondeo = +0.50 → total = 30.01 - 3.01 + 0.50 = 27.50. Si el
      // prorrateo usara el subtotal (30.01) o el total pre-ajuste (27.00,
      // el mismo caso que el test obligatorio #2 sin el ajuste) en vez del
      // total final (27.50), SUM(neto_linea) no daría 27.50 exacto.
      const v1 = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('10.00'),
      });
      const v2 = buildVariantRow({
        id: 20,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('10.00'),
      });
      const v3 = buildVariantRow({
        id: 30,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('10.01'),
      });
      const tx = buildMockTx([v1, v2, v3]);
      const deps = buildDeps();
      const service = buildService(deps);

      const input: CrearVentaInputT46 = {
        userId: 7,
        esOwner: true,
        idempotencyKey: 'idem-test-key',
        items: [
          { variantId: 10, cantidad: 1 },
          { variantId: 20, cantidad: 1 },
          { variantId: 30, cantidad: 1 },
        ],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('27.50'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento variado',
            monto: new Prisma.Decimal('3.01'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('0.50'),
      };

      await service.crearVenta(asTx(tx), input);

      const call = tx.sale.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.total).toString()).toBe('27.5');

      const netos = call.data.items.create.map((item) =>
        new Prisma.Decimal(item.netoLinea).toFixed(2),
      );
      const expectedNetos = prorate(['10.00', '10.00', '10.01'], '27.50').map(
        (n) => n.toFixed(2),
      );
      expect(netos).toEqual(expectedNetos);

      const sumNetos = call.data.items.create.reduce(
        (sum, item) => sum.plus(new Prisma.Decimal(item.netoLinea)),
        new Prisma.Decimal(0),
      );
      expect(sumNetos.toFixed(2)).toBe('27.50');
    });
  });
});
