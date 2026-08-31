import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StockService } from '../stock/stock.service';
import {
  CatalogImportService,
  parseDecimalField,
  parseStockField,
} from './catalog-import.service';
import { ImportCatalogDto } from './dto/import-catalog.dto';

describe('parseDecimalField', () => {
  it('parsea un decimal válido', () => {
    expect(parseDecimalField('10.50', 'precio').toString()).toBe('10.5');
  });

  it('rechaza vacío u omitido', () => {
    expect(() => parseDecimalField('', 'precio')).toThrow(
      /precio es obligatorio/,
    );
    expect(() => parseDecimalField(undefined, 'precio')).toThrow(
      /precio es obligatorio/,
    );
  });

  it('rechaza texto no numérico', () => {
    expect(() => parseDecimalField('abc', 'precio')).toThrow(
      /precio "abc" no es un número válido/,
    );
  });

  it('rechaza 0 o negativo', () => {
    expect(() => parseDecimalField('0', 'costo')).toThrow(/mayor a 0/);
    expect(() => parseDecimalField('-5', 'costo')).toThrow(/mayor a 0/);
  });

  it('rechaza más de 2 decimales', () => {
    expect(() => parseDecimalField('10.999', 'precio')).toThrow(
      /no puede tener más de 2 decimales/,
    );
  });

  it('acepta espacios alrededor del valor', () => {
    expect(parseDecimalField('  25.00  ', 'precio').toString()).toBe('25');
  });

  // Ticket nuevo (post Release Candidate) — hallazgo real de una ronda
  // de auto-revisión: un CSV armado en Excel con configuración
  // regional Argentina escribe los precios con coma decimal. Sin
  // esto, "1500,50" tiraba "no es un número válido" — un import real
  // con precios así fallaba en TODAS las filas.
  describe('formato argentino (coma decimal)', () => {
    it('acepta coma como separador decimal ("1500,50")', () => {
      expect(parseDecimalField('1500,50', 'precio').toString()).toBe('1500.5');
    });

    it('acepta punto de miles + coma decimal ("1.500,50")', () => {
      expect(parseDecimalField('1.500,50', 'precio').toString()).toBe('1500.5');
    });

    it('acepta coma decimal sin parte decimal explícita más allá de 2 dígitos ("1.234.567,89")', () => {
      expect(parseDecimalField('1.234.567,89', 'precio').toString()).toBe(
        '1234567.89',
      );
    });

    // Hallazgo real de esta misma ronda: "10.999" (formato
    // internacional, sin coma) tiene la MISMA forma que "1.999"
    // (mil novecientos noventa y nueve en formato ar) — ambiguo entre
    // "demasiados decimales" (el caso real de arriba, que sigue
    // rechazado) y "separador de miles sin parte decimal". Sin coma
    // de por medio, nunca se adivina — se sigue tratando como decimal
    // internacional de siempre, para no convertir un error de tipeo
    // real en una carga silenciosa del valor equivocado.
    it('sin coma, NO interpreta el punto como separador de miles — "10.999" sigue siendo un error de "demasiados decimales", no $10.999', () => {
      expect(() => parseDecimalField('10.999', 'precio')).toThrow(
        /no puede tener más de 2 decimales/,
      );
    });
  });
});

describe('parseStockField', () => {
  it('parsea un entero válido', () => {
    expect(parseStockField('10')).toBe(10);
  });

  it('acepta 0', () => {
    expect(parseStockField('0')).toBe(0);
  });

  it('rechaza vacío u omitido', () => {
    expect(() => parseStockField('')).toThrow(/stock es obligatorio/);
    expect(() => parseStockField(undefined)).toThrow(/stock es obligatorio/);
  });

  it('rechaza negativos', () => {
    expect(() => parseStockField('-1')).toThrow(/entero mayor o igual a 0/);
  });

  it('rechaza no enteros', () => {
    expect(() => parseStockField('1.5')).toThrow(/entero mayor o igual a 0/);
  });

  it('rechaza texto no numérico', () => {
    expect(() => parseStockField('diez')).toThrow(/entero mayor o igual a 0/);
  });

  // Ticket nuevo (post Release Candidate) — hallazgo real de una ronda
  // de auto-revisión, verificado empíricamente: sin esto,
  // `Number('1.000') === 1` — SIN NINGÚN ERROR. Un import real con
  // "1.000" en la columna de stock (formato argentino, mil unidades)
  // cargaba 1 unidad en silencio, no 1000 — corrupción de stock, no
  // un error visible.
  describe('formato argentino (punto de miles, entero)', () => {
    it('interpreta "1.000" como mil, no como uno', () => {
      expect(parseStockField('1.000')).toBe(1000);
    });

    it('interpreta "12.500" como doce mil quinientos', () => {
      expect(parseStockField('12.500')).toBe(12500);
    });

    it('interpreta "1.234.567" con miles encadenados', () => {
      expect(parseStockField('1.234.567')).toBe(1234567);
    });

    // Fuera del patrón exacto de agrupación de a 3 — no se adivina.
    it('"1.5" NO se interpreta como mil quinientos — sigue siendo un decimal inválido para stock', () => {
      expect(() => parseStockField('1.5')).toThrow(/entero mayor o igual a 0/);
    });
  });
});

// MockTx sigue el mismo patrón que variants.service.spec.ts (createGrid):
// tipos propios sin intersección con Prisma.TransactionClient, para no
// arrastrar los falsos positivos de lint de unbound-method que produce
// esa intersección (ya documentado en ese archivo).
interface MockTx {
  product: { findFirst: jest.Mock; create: jest.Mock };
  brand: { findFirst: jest.Mock; create: jest.Mock };
  category: { findFirst: jest.Mock; create: jest.Mock };
  size: { findFirst: jest.Mock; create: jest.Mock; aggregate: jest.Mock };
  color: { findFirst: jest.Mock; create: jest.Mock };
  variant: { create: jest.Mock };
  priceHistory: { create: jest.Mock };
  $executeRaw: jest.Mock;
}

function buildMockTx(): MockTx {
  return {
    product: { findFirst: jest.fn(), create: jest.fn() },
    brand: { findFirst: jest.fn(), create: jest.fn() },
    category: { findFirst: jest.fn(), create: jest.fn() },
    size: { findFirst: jest.fn(), create: jest.fn(), aggregate: jest.fn() },
    color: { findFirst: jest.fn(), create: jest.fn() },
    variant: { create: jest.fn() },
    priceHistory: { create: jest.fn() },
    // Fase 08 (QA adversarial) — resolveProduct toma un advisory lock
    // (pg_advisory_xact_lock) antes de buscar/crear el producto, ver
    // catalog-import.service.ts. Mock sin efecto, solo para que exista.
    $executeRaw: jest.fn().mockResolvedValue(undefined),
  };
}

describe('CatalogImportService.import (T2.13, AMB-12)', () => {
  let service: CatalogImportService;
  let tx: MockTx;
  let prismaMock: { $transaction: jest.Mock };
  let stockServiceMock: { registrarEntrada: jest.Mock };

  beforeEach(() => {
    tx = buildMockTx();
    prismaMock = {
      $transaction: jest.fn((cb: (tx: MockTx) => unknown) => cb(tx)),
    };
    stockServiceMock = {
      registrarEntrada: jest.fn().mockResolvedValue(undefined),
    };
    service = new CatalogImportService(
      prismaMock as unknown as PrismaService,
      stockServiceMock as unknown as StockService,
    );
  });

  function dto(csv: string): ImportCatalogDto {
    return Object.assign(new ImportCatalogDto(), { csv });
  }

  it('encabezado sin columnas obligatorias: rechaza el archivo completo (400), no reporta filas', async () => {
    await expect(
      service.import(dto('nombre,precio\nRemera,10.00\n'), 1),
    ).rejects.toThrow(/Faltan columnas obligatorias.*costo, stock/);
  });

  it('CSV sin filas de datos: rechaza el archivo completo (400)', async () => {
    await expect(
      service.import(dto('nombre,precio,costo,stock\n'), 1),
    ).rejects.toThrow(/no tiene filas de datos/);
  });

  // Ticket nuevo (post Release Candidate) — hallazgo real, verificado
  // empíricamente contra `csv-parse`: Excel con configuración regional
  // Argentina exporta CSV separado por punto y coma, no por coma (el
  // sistema operativo lo fuerza así porque la coma ya es el separador
  // decimal). Sin detectar esto, un archivo exportado así se leía
  // como UNA sola columna con todo el encabezado pegado, y el chequeo
  // de columnas obligatorias rechazaba el archivo entero — sin
  // explicar la causa real. Antes de este ticket, este mismo CSV
  // hubiera tirado "Faltan columnas obligatorias en el encabezado:
  // nombre, precio, costo, stock".
  it('CSV separado por punto y coma (export típico de Excel en Argentina) se lee igual que uno separado por coma', async () => {
    tx.product.findFirst.mockResolvedValue({ id: 1 });
    tx.variant.create.mockResolvedValue({ id: 1 });

    const csv =
      'nombre;precio;costo;stock\n' + 'Remera basica;1500,50;800;10\n';

    const result = await service.import(dto(csv), 1);

    expect(result.filasCount).toBe(1);
    expect(result.exitosas).toBe(1);
    expect(result.filas[0]).toMatchObject({ estado: 'OK' });
    // Confirma que también se leyó bien el precio con coma decimal
    // ("1500,50", formato argentino) de esta misma fila — no solo que
    // se encontraron las columnas.
    const [{ data }] = tx.variant.create.mock.calls[0] as [
      { data: { precioVenta: Prisma.Decimal } },
    ];
    expect(data.precioVenta.toString()).toBe('1500.5');
  });

  it('fila válida: crea producto nuevo, variante, price_history ALTA y llama a stock.service.registrarEntrada', async () => {
    tx.product.findFirst.mockResolvedValue(null);
    tx.product.create.mockResolvedValue({ id: 100 });
    tx.size.findFirst.mockResolvedValue(null);
    tx.size.aggregate.mockResolvedValue({ _max: { orden: 3 } });
    tx.size.create.mockResolvedValue({ id: 900 });
    tx.color.findFirst.mockResolvedValue(null);
    tx.color.create.mockResolvedValue({ id: 901 });
    tx.variant.create.mockResolvedValue({ id: 1 });

    const csv =
      'nombre,talle,color,sku,precio,costo,stock\n' +
      'Remera básica,M,Negro,REM-M-NEGRO,2000.00,900.00,10\n';

    const result = await service.import(dto(csv), 7);

    expect(result.filasCount).toBe(1);
    expect(result.exitosas).toBe(1);
    expect(result.filas[0]).toMatchObject({
      linea: 2,
      estado: 'OK',
      sku: 'REM-M-NEGRO',
    });

    expect(tx.product.create).toHaveBeenCalledWith({
      data: {
        nombre: 'Remera básica',
        brandId: undefined,
        categoryId: undefined,
      },
    });
    expect(tx.variant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 100,
        sku: 'REM-M-NEGRO',
      }) as unknown,
    });
    expect(tx.priceHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        campo: 'PRECIO_VENTA',
        origen: 'ALTA',
        valorAnterior: null,
        userId: 7,
      }) as unknown,
    });
    expect(stockServiceMock.registrarEntrada).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ variantId: 1, cantidad: 10, userId: 7 }),
    );
  });

  it('reusa un producto existente por nombre (case-insensitive) en vez de crear uno nuevo', async () => {
    tx.product.findFirst.mockResolvedValue({ id: 55 });
    tx.variant.create.mockResolvedValue({ id: 2 });

    const csv =
      'nombre,sku,precio,costo,stock\n' + 'REMERA BÁSICA,SKU-1,10.00,5.00,1\n';

    await service.import(dto(csv), 1);

    expect(tx.product.create).not.toHaveBeenCalled();
    expect(tx.variant.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ productId: 55 }) as unknown,
    });
  });

  it('sin talle/color, genera el SKU sin esos segmentos cuando la celda de SKU viene vacía', async () => {
    tx.product.findFirst.mockResolvedValue({ id: 9 });
    tx.variant.create.mockResolvedValue({ id: 3 });

    const csv =
      'nombre,precio,costo,stock\n' + 'Cinturón de cuero,500.00,200.00,3\n';

    const result = await service.import(dto(csv), 1);

    expect(result.filas[0]).toMatchObject({ estado: 'OK', sku: 'P9' });
  });

  it('una fila inválida no aborta el import: se reporta como error y las demás se procesan', async () => {
    tx.product.findFirst.mockResolvedValue({ id: 1 });
    tx.variant.create.mockResolvedValue({ id: 10 });

    const csv =
      'nombre,precio,costo,stock\n' +
      'Producto malo,abc,10.00,5\n' + // precio inválido
      'Producto bueno,10.00,5.00,5\n';

    const result = await service.import(dto(csv), 1);

    expect(result.filasCount).toBe(2);
    expect(result.exitosas).toBe(1);
    expect(result.fallidas).toBe(1);
    expect(result.filas[0]).toMatchObject({ linea: 2, estado: 'ERROR' });
    expect(result.filas[0].mensaje).toMatch(/precio/);
    expect(result.filas[1]).toMatchObject({ linea: 3, estado: 'OK' });
  });

  it('falta el nombre: error de fila, no rompe el import', async () => {
    const csv = 'nombre,precio,costo,stock\n' + ',10.00,5.00,1\n';

    const result = await service.import(dto(csv), 1);

    expect(result.filas[0]).toMatchObject({ estado: 'ERROR' });
    expect(result.filas[0].mensaje).toMatch(/nombre es obligatorio/);
  });

  it('SKU duplicado (P2002) se traduce a un mensaje de negocio, no al error crudo de Prisma', async () => {
    tx.product.findFirst.mockResolvedValue({ id: 1 });
    tx.variant.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { target: ['sku'] },
      }),
    );

    const csv =
      'nombre,sku,precio,costo,stock\n' + 'Producto,SKU-DUP,10.00,5.00,1\n';

    const result = await service.import(dto(csv), 1);

    expect(result.filas[0]).toMatchObject({ estado: 'ERROR' });
    expect(result.filas[0].mensaje).toBe('Ya existe una variante con ese SKU');
  });

  it('reusa la caché entre filas del mismo producto: solo consulta/crea una vez', async () => {
    tx.product.findFirst.mockResolvedValueOnce(null);
    tx.product.create.mockResolvedValue({ id: 200 });
    tx.size.findFirst.mockResolvedValue(null);
    tx.size.aggregate.mockResolvedValue({ _max: { orden: null } });
    tx.size.create
      .mockResolvedValueOnce({ id: 10 })
      .mockResolvedValueOnce({ id: 11 });
    tx.variant.create
      .mockResolvedValueOnce({ id: 1 })
      .mockResolvedValueOnce({ id: 2 });

    const csv =
      'nombre,talle,sku,precio,costo,stock\n' +
      'Remera,S,REM-S,10.00,5.00,1\n' +
      'Remera,M,REM-M,10.00,5.00,1\n';

    const result = await service.import(dto(csv), 1);

    expect(result.exitosas).toBe(2);
    expect(tx.product.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.product.create).toHaveBeenCalledTimes(1);
  });
});
