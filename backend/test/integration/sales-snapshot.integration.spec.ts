import { PrismaClient, Prisma, PaymentMetodo, UserRole } from '@prisma/client';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { SalesService } from '../../src/modules/sales/sales.service';
import { StockService } from '../../src/modules/stock/stock.service';
import { CashRegisterService } from '../../src/modules/cash-registers/cash-register.service';
import { SettingsService } from '../../src/common/settings/settings.service';

// Fase 04a (T4.2) — tests escritos en sesión aislada, contra Postgres real,
// ANTES de tocar la implementación de T4.2 (BLUEPRINT AD-5, §3.4, §5.3;
// `modulo-sales-spec.md` secciones 2/3/6; ticket T4.2 de `ROADMAP.md`).
//
// Restricción cumplida: no se leyó `sales.service.ts` para decidir NINGÚN
// comportamiento de negocio. Lo único que se extrajo de ese archivo fue la
// FIRMA pública estrictamente necesaria para poder compilar/llamar al
// servicio real (constructor y la firma de `crearVenta`, incluidos los
// tipos `CrearVentaInput`/`CrearVentaItemInput`/`CrearVentaPaymentInput`) —
// autorizado explícitamente por la fase 04a ("interfaces o tipos
// estrictamente necesarios para compilar"). Ninguna línea de la lógica
// interna de `descripcion_snapshot`, precio o costo fue mirada ni usada:
// ese cálculo hoy no existe todavía (es exactamente lo que T4.2 debe
// construir) o, si existe, es el placeholder "Variante #{id}" que el propio
// ticket describe desde afuera — dato dado por la consigna, no confirmado
// leyendo código.
//
// `SalesService` (T4.1, ya VERDE) todavía no tiene controller/módulo Nest
// registrado en `AppModule` (T4.1 solo construyó el service) — por eso,
// a diferencia de otras suites de integración de este repo, acá se
// instancia el servicio real directamente (mismo patrón mecánico que
// `cash-registers.integration.spec.ts` usa para `CashRegisterService`:
// `new Servicio(prisma, ...)` contra un `PrismaClient` real, envuelto en
// `prisma.$transaction` porque `crearVenta` exige un `tx` ya abierto) en
// vez de golpear HTTP con supertest.
//
// Qué se prueba: el contenido de `sale_items.descripcion_snapshot` (nombre +
// talle + color al momento de vender, BLUEPRINT §3.4) y que tanto esa
// descripción como `precio_unitario`/`costo_unitario` quedan CONGELADOS —
// no se recalculan si el producto/talle/color/precio/costo de la variante
// cambian después de la venta (AD-5). Sin discounts ni ajusteRedondeo
// (fuera del alcance de T4.1/T4.2 según la propia firma de
// `CrearVentaInput`, que no los declara) — así el subtotal de la línea
// coincide siempre con el total de la venta y los montos de los tests son
// triviales de verificar a mano, sin usar el prorrateo de T4.6.

const prisma = new PrismaClient();
const settingsService = new SettingsService(prisma as unknown as PrismaService);
const stockService = new StockService(prisma as unknown as PrismaService);
const cashRegisterService = new CashRegisterService(
  prisma as unknown as PrismaService,
  settingsService,
);
const salesService = new SalesService(
  prisma as unknown as PrismaService,
  stockService,
  cashRegisterService,
  settingsService,
);

describe('sales — descripcion_snapshot y congelado de precio/costo (T4.2, integración, Postgres real)', () => {
  let sellerId: number;
  const createdUserIds: number[] = [];
  const createdSessionIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];
  const createdSizeIds: number[] = [];
  const createdColorIds: number[] = [];
  const createdSaleIds: number[] = [];

  // Mismo criterio defensivo que `cash-registers.integration.spec.ts`: el
  // índice único parcial de sesión ABIERTA no tolera dos a la vez, así que
  // si quedó una sesión abierta de otra suite (corrida fuera de orden), se
  // cierra directo por Prisma antes de abrir la propia.
  async function closeAnyOpenSessionDirect(): Promise<void> {
    const open = await prisma.cashRegisterSession.findFirst({
      where: { estado: 'ABIERTA' },
    });
    if (open) {
      await prisma.cashRegisterSession.update({
        where: { id: open.id },
        data: {
          estado: 'CERRADA',
          fechaCierre: new Date(),
          userIdCierre: open.userIdApertura,
          montoDeclarado: open.montoInicial,
          montoSistema: open.montoInicial,
          diferencia: new Prisma.Decimal('0.00'),
        },
      });
    }
  }

  async function crearVariante(opts: {
    productoNombre: string;
    sizeId?: number;
    colorId?: number;
    precioVenta: string;
    costoActual: string;
    stock?: number;
  }): Promise<{ variantId: number; productId: number }> {
    const product = await prisma.product.create({
      data: { nombre: opts.productoNombre },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sizeId: opts.sizeId ?? null,
        colorId: opts.colorId ?? null,
        sku: `T42-SNAP-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        precioVenta: new Prisma.Decimal(opts.precioVenta),
        costoActual: new Prisma.Decimal(opts.costoActual),
        stockActual: opts.stock ?? 10,
      },
    });
    createdVariantIds.push(variant.id);

    return { variantId: variant.id, productId: product.id };
  }

  async function venderUnaUnidad(variantId: number, monto: string) {
    const sale = await prisma.$transaction((tx) =>
      salesService.crearVenta(tx, {
        userId: sellerId,
        items: [{ variantId, cantidad: 1 }],
        payments: [
          { metodo: PaymentMetodo.EFECTIVO, monto: new Prisma.Decimal(monto) },
        ],
      }),
    );
    createdSaleIds.push(sale.id);
    const [item] = await prisma.saleItem.findMany({
      where: { saleId: sale.id },
    });
    return { sale, item };
  }

  beforeAll(async () => {
    await closeAnyOpenSessionDirect();

    const seller = await prisma.user.create({
      data: {
        email: `sales-snapshot-test-seller-${Date.now()}@manitas.local`,
        passwordHash: 'no-usado-en-este-archivo',
        nombre: 'Vendedora de prueba (T4.2)',
        rol: UserRole.SELLER,
        activo: true,
      },
    });
    sellerId = seller.id;
    createdUserIds.push(seller.id);

    const session = await prisma.cashRegisterSession.create({
      data: {
        fechaApertura: new Date(),
        userIdApertura: sellerId,
        montoInicial: new Prisma.Decimal('0.00'),
        estado: 'ABIERTA',
      },
    });
    createdSessionIds.push(session.id);
  });

  afterAll(async () => {
    if (createdSaleIds.length > 0) {
      await prisma.payment.deleteMany({
        where: { saleId: { in: createdSaleIds } },
      });
      await prisma.saleItem.deleteMany({
        where: { saleId: { in: createdSaleIds } },
      });
      await prisma.sale.deleteMany({ where: { id: { in: createdSaleIds } } });
    }
    if (createdVariantIds.length > 0) {
      await prisma.stockMovement.deleteMany({
        where: { variantId: { in: createdVariantIds } },
      });
      await prisma.variant.deleteMany({
        where: { id: { in: createdVariantIds } },
      });
    }
    if (createdProductIds.length > 0) {
      await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
      });
    }
    if (createdSizeIds.length > 0) {
      await prisma.size.deleteMany({ where: { id: { in: createdSizeIds } } });
    }
    if (createdColorIds.length > 0) {
      await prisma.color.deleteMany({ where: { id: { in: createdColorIds } } });
    }
    if (createdSessionIds.length > 0) {
      await prisma.cashMovement.deleteMany({
        where: { sessionId: { in: createdSessionIds } },
      });
      await prisma.cashRegisterSession.deleteMany({
        where: { id: { in: createdSessionIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  });

  it('camino feliz: el descripcion_snapshot contiene el nombre del producto, el talle y el color de la variante vendida', async () => {
    const size = await prisma.size.create({
      data: { nombre: `Talle-Feliz-${Date.now()}`, orden: 1 },
    });
    createdSizeIds.push(size.id);
    const color = await prisma.color.create({
      data: { nombre: `Color-Feliz-${Date.now()}` },
    });
    createdColorIds.push(color.id);
    const productoNombre = `Remera Camino Feliz ${Date.now()}`;

    const { variantId } = await crearVariante({
      productoNombre,
      sizeId: size.id,
      colorId: color.id,
      precioVenta: '1000.00',
      costoActual: '500.00',
    });

    const { item } = await venderUnaUnidad(variantId, '1000.00');

    expect(item.descripcionSnapshot).toContain(productoNombre);
    expect(item.descripcionSnapshot).toContain(size.nombre);
    expect(item.descripcionSnapshot).toContain(color.nombre);
    expect(item.descripcionSnapshot.toLowerCase()).not.toMatch(/\bnull\b/);
    expect(item.descripcionSnapshot.toLowerCase()).not.toMatch(/\bundefined\b/);
  });

  it('una variante SIN talle y SIN color genera un descripcion_snapshot no vacío, con el nombre del producto y sin "null"/"undefined" literal', async () => {
    const productoNombre = `Bufanda Sin Talle Ni Color ${Date.now()}`;

    const { variantId } = await crearVariante({
      productoNombre,
      // sizeId / colorId omitidos a propósito: ambos nullable (AD-15).
      precioVenta: '500.00',
      costoActual: '200.00',
    });

    const { item } = await venderUnaUnidad(variantId, '500.00');

    expect(item.descripcionSnapshot.trim().length).toBeGreaterThan(0);
    expect(item.descripcionSnapshot).toContain(productoNombre);
    expect(item.descripcionSnapshot.toLowerCase()).not.toMatch(/\bnull\b/);
    expect(item.descripcionSnapshot.toLowerCase()).not.toMatch(/\bundefined\b/);
  });

  it('una variante con talle pero SIN color genera un descripcion_snapshot con el nombre y el talle, sin "null" literal', async () => {
    const size = await prisma.size.create({
      data: { nombre: `Talle-SoloTalle-${Date.now()}`, orden: 1 },
    });
    createdSizeIds.push(size.id);
    const productoNombre = `Gorro Solo Talle ${Date.now()}`;

    const { variantId } = await crearVariante({
      productoNombre,
      sizeId: size.id,
      // colorId omitido.
      precioVenta: '300.00',
      costoActual: '100.00',
    });

    const { item } = await venderUnaUnidad(variantId, '300.00');

    expect(item.descripcionSnapshot).toContain(productoNombre);
    expect(item.descripcionSnapshot).toContain(size.nombre);
    expect(item.descripcionSnapshot.toLowerCase()).not.toMatch(/\bnull\b/);
    expect(item.descripcionSnapshot.toLowerCase()).not.toMatch(/\bundefined\b/);
  });

  it('una variante con color pero SIN talle genera un descripcion_snapshot con el nombre y el color, sin "null" literal', async () => {
    const color = await prisma.color.create({
      data: { nombre: `Color-SoloColor-${Date.now()}` },
    });
    createdColorIds.push(color.id);
    const productoNombre = `Cartera Solo Color ${Date.now()}`;

    const { variantId } = await crearVariante({
      productoNombre,
      colorId: color.id,
      // sizeId omitido.
      precioVenta: '800.00',
      costoActual: '400.00',
    });

    const { item } = await venderUnaUnidad(variantId, '800.00');

    expect(item.descripcionSnapshot).toContain(productoNombre);
    expect(item.descripcionSnapshot).toContain(color.nombre);
    expect(item.descripcionSnapshot.toLowerCase()).not.toMatch(/\bnull\b/);
    expect(item.descripcionSnapshot.toLowerCase()).not.toMatch(/\bundefined\b/);
  });

  it('el descripcion_snapshot, precio_unitario y costo_unitario de una venta ya hecha NO cambian aunque el producto/talle/color/precio/costo de la variante se modifiquen después (AD-5, congelado)', async () => {
    const sizeOriginal = await prisma.size.create({
      data: { nombre: `Talle-Orig-${Date.now()}`, orden: 1 },
    });
    createdSizeIds.push(sizeOriginal.id);
    const sizeNuevo = await prisma.size.create({
      data: { nombre: `Talle-Nuevo-${Date.now()}`, orden: 2 },
    });
    createdSizeIds.push(sizeNuevo.id);
    const colorOriginal = await prisma.color.create({
      data: { nombre: `Color-Orig-${Date.now()}` },
    });
    createdColorIds.push(colorOriginal.id);
    const colorNuevo = await prisma.color.create({
      data: { nombre: `Color-Nuevo-${Date.now()}` },
    });
    createdColorIds.push(colorNuevo.id);
    const nombreOriginal = `Producto Original ${Date.now()}`;

    const { variantId, productId } = await crearVariante({
      productoNombre: nombreOriginal,
      sizeId: sizeOriginal.id,
      colorId: colorOriginal.id,
      precioVenta: '1000.00',
      costoActual: '600.00',
    });

    const { item: itemAntes } = await venderUnaUnidad(variantId, '1000.00');
    const saleId = itemAntes.saleId;

    // La dueña modifica el producto y la variante DESPUÉS de la venta.
    const nombreNuevo = `Producto Renombrado ${Date.now()}`;
    await prisma.product.update({
      where: { id: productId },
      data: { nombre: nombreNuevo },
    });
    await prisma.variant.update({
      where: { id: variantId },
      data: {
        sizeId: sizeNuevo.id,
        colorId: colorNuevo.id,
        precioVenta: new Prisma.Decimal('2000.00'),
        costoActual: new Prisma.Decimal('1200.00'),
      },
    });

    const [itemDespues] = await prisma.saleItem.findMany({
      where: { saleId },
    });

    // La línea vieja no se mueve: sigue mostrando el estado de cuando se
    // vendió, no el actual de la variante/producto.
    expect(itemDespues.descripcionSnapshot).toBe(itemAntes.descripcionSnapshot);
    expect(itemDespues.descripcionSnapshot).toContain(nombreOriginal);
    expect(itemDespues.descripcionSnapshot).not.toContain(nombreNuevo);
    expect(itemDespues.descripcionSnapshot).toContain(sizeOriginal.nombre);
    expect(itemDespues.descripcionSnapshot).not.toContain(sizeNuevo.nombre);
    expect(itemDespues.descripcionSnapshot).toContain(colorOriginal.nombre);
    expect(itemDespues.descripcionSnapshot).not.toContain(colorNuevo.nombre);

    // precio_unitario / costo_unitario también deben quedar congelados
    // (AD-5) — ya cubierto a nivel mínimo desde T4.1, se repite acá contra
    // el caso puntual de "la variante cambia DESPUÉS de la venta" porque no
    // hay certeza de que ese escenario ya estuviera cubierto.
    expect(itemDespues.precioUnitario.toString()).toBe(
      itemAntes.precioUnitario.toString(),
    );
    expect(itemDespues.costoUnitario.toString()).toBe(
      itemAntes.costoUnitario.toString(),
    );
    expect(Number(itemDespues.precioUnitario)).toBe(1000);
    expect(Number(itemDespues.costoUnitario)).toBe(600);
  });

  it('dos ventas de la misma variante en momentos distintos, con cambios en el medio, reflejan cada una el estado de la variante en SU propio momento', async () => {
    const sizeA = await prisma.size.create({
      data: { nombre: `Talle-Momento-A-${Date.now()}`, orden: 1 },
    });
    createdSizeIds.push(sizeA.id);
    const sizeB = await prisma.size.create({
      data: { nombre: `Talle-Momento-B-${Date.now()}`, orden: 2 },
    });
    createdSizeIds.push(sizeB.id);
    const colorA = await prisma.color.create({
      data: { nombre: `Color-Momento-A-${Date.now()}` },
    });
    createdColorIds.push(colorA.id);
    const colorB = await prisma.color.create({
      data: { nombre: `Color-Momento-B-${Date.now()}` },
    });
    createdColorIds.push(colorB.id);
    const nombreMomentoA = `Producto Momento A ${Date.now()}`;

    const { variantId, productId } = await crearVariante({
      productoNombre: nombreMomentoA,
      sizeId: sizeA.id,
      colorId: colorA.id,
      precioVenta: '1000.00',
      costoActual: '600.00',
    });

    const { item: itemA, sale: saleA } = await venderUnaUnidad(
      variantId,
      '1000.00',
    );

    const nombreMomentoB = `Producto Momento B ${Date.now()}`;
    await prisma.product.update({
      where: { id: productId },
      data: { nombre: nombreMomentoB },
    });
    await prisma.variant.update({
      where: { id: variantId },
      data: {
        sizeId: sizeB.id,
        colorId: colorB.id,
        precioVenta: new Prisma.Decimal('1500.00'),
        costoActual: new Prisma.Decimal('900.00'),
      },
    });

    const { item: itemB } = await venderUnaUnidad(variantId, '1500.00');

    // Releo la línea A: tiene que seguir igual a como quedó al venderse,
    // sin importar que ya se haya hecho la segunda venta.
    const [itemARelectura] = await prisma.saleItem.findMany({
      where: { saleId: saleA.id },
    });

    expect(itemARelectura.descripcionSnapshot).toBe(itemA.descripcionSnapshot);
    expect(itemARelectura.descripcionSnapshot).toContain(nombreMomentoA);
    expect(itemARelectura.descripcionSnapshot).not.toContain(nombreMomentoB);
    expect(itemARelectura.descripcionSnapshot).toContain(sizeA.nombre);
    expect(itemARelectura.descripcionSnapshot).not.toContain(sizeB.nombre);
    expect(itemARelectura.descripcionSnapshot).toContain(colorA.nombre);
    expect(itemARelectura.descripcionSnapshot).not.toContain(colorB.nombre);
    expect(Number(itemARelectura.precioUnitario)).toBe(1000);
    expect(Number(itemARelectura.costoUnitario)).toBe(600);

    // La línea B refleja el estado nuevo, no el viejo.
    expect(itemB.descripcionSnapshot).toContain(nombreMomentoB);
    expect(itemB.descripcionSnapshot).not.toContain(nombreMomentoA);
    expect(itemB.descripcionSnapshot).toContain(sizeB.nombre);
    expect(itemB.descripcionSnapshot).toContain(colorB.nombre);
    expect(Number(itemB.precioUnitario)).toBe(1500);
    expect(Number(itemB.costoUnitario)).toBe(900);

    // Las dos líneas no deben terminar idénticas entre sí.
    expect(itemARelectura.descripcionSnapshot).not.toBe(
      itemB.descripcionSnapshot,
    );
  });
});
