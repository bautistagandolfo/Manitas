import { Prisma, PrismaClient, SettingTipo } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { SettingsService } from '../../src/common/settings/settings.service';

// T0.13 — sin controller en este ticket (BLUEPRINT §10, servicio interno
// para que sales/returns/cash-registers lo consuman más adelante; la
// pantalla de configuración es T6.9). Mismo patrón que
// stock.integration.spec.ts: se instancia el servicio directo contra
// Postgres real, sin pasar por HTTP.
//
// Los casos de este archivo usan claves de prueba propias (no las 4 reales
// del seed) para no depender de que `prisma/seed.ts` se haya corrido antes,
// ni interferir con esos valores si algún otro proceso los lee en paralelo.

const prisma = new PrismaClient();
const service = new SettingsService(prisma as unknown as PrismaService);

describe('SettingsService (integration)', () => {
  const createdKeys: string[] = [];

  async function createTestSetting(
    overrides: Partial<{
      clave: string;
      valor: string;
      tipo: SettingTipo;
    }> = {},
  ): Promise<string> {
    const clave =
      overrides.clave ?? `test_setting_${Date.now()}_${Math.random()}`;
    await prisma.setting.create({
      data: {
        clave,
        valor: overrides.valor ?? 'false',
        tipo: overrides.tipo ?? SettingTipo.BOOL,
      },
    });
    createdKeys.push(clave);
    return clave;
  }

  afterAll(async () => {
    if (createdKeys.length > 0) {
      await prisma.setting.deleteMany({
        where: { clave: { in: createdKeys } },
      });
    }
    await prisma.$disconnect();
  });

  it('getBool/getInt/getDecimal leen el valor real de la base', async () => {
    const claveBool = await createTestSetting({
      valor: 'true',
      tipo: SettingTipo.BOOL,
    });
    const claveInt = await createTestSetting({
      valor: '42',
      tipo: SettingTipo.INT,
    });
    const claveDecimal = await createTestSetting({
      valor: '123.45',
      tipo: SettingTipo.DECIMAL,
    });

    await expect(service.getBool(claveBool)).resolves.toBe(true);
    await expect(service.getInt(claveInt)).resolves.toBe(42);
    const decimal = await service.getDecimal(claveDecimal);
    expect(decimal.toString()).toBe('123.45');
  });

  it('setBool/setInt/setDecimal actualizan la fila real y registran updatedByUserId', async () => {
    const user = await prisma.user.create({
      data: {
        email: `settings-test-${Date.now()}@manitas.local`,
        passwordHash: 'no-se-usa-en-este-archivo',
        nombre: 'Owner de prueba (settings)',
        rol: 'OWNER',
        activo: true,
      },
    });

    try {
      const claveInt = await createTestSetting({
        valor: '10',
        tipo: SettingTipo.INT,
      });

      await service.setInt(claveInt, 25, user.id);

      const row = await prisma.setting.findUniqueOrThrow({
        where: { clave: claveInt },
      });
      expect(row.valor).toBe('25');
      expect(row.updatedByUserId).toBe(user.id);
    } finally {
      await prisma.user.delete({ where: { id: user.id } });
    }
  });

  it('rechaza escribir una clave que no existe (no la crea)', async () => {
    const clave = `clave_inexistente_${Date.now()}`;

    await expect(service.setBool(clave, true, 1)).rejects.toThrow();

    const row = await prisma.setting.findUnique({ where: { clave } });
    expect(row).toBeNull();
  });

  it('BLUEPRINT §10 / AMB-10: los 4 parámetros reales del seed existen con el tipo y valor correctos', async () => {
    // No corre `prisma/seed.ts` — confirma que, si ya se sembró (dev real o
    // luego de correr el seed a mano), los valores coinciden con la
    // decisión tomada. Si nunca se sembró en este entorno, el test se
    // saltea explícitamente en vez de fallar por un problema de setup
    // ajeno a SettingsService.
    const permitirVentaSinStock = await prisma.setting.findUnique({
      where: { clave: 'permitir_venta_sin_stock' },
    });
    if (!permitirVentaSinStock) {
      console.warn(
        'settings.integration.spec.ts: el seed real (prisma/seed.ts) no corrió en esta base — se saltea la verificación de los 4 parámetros reales.',
      );
      return;
    }

    expect(permitirVentaSinStock.tipo).toBe(SettingTipo.BOOL);
    expect(permitirVentaSinStock.valor).toBe('false');

    const maxDescuento = await prisma.setting.findUniqueOrThrow({
      where: { clave: 'max_descuento_vendedor_pct' },
    });
    expect(maxDescuento.tipo).toBe(SettingTipo.INT);
    expect(maxDescuento.valor).toBe('10');

    const diasPlazo = await prisma.setting.findUniqueOrThrow({
      where: { clave: 'dias_plazo_devolucion' },
    });
    expect(diasPlazo.tipo).toBe(SettingTipo.INT);
    expect(diasPlazo.valor).toBe('30');

    const umbral = await prisma.setting.findUniqueOrThrow({
      where: { clave: 'umbral_diferencia_caja' },
    });
    expect(umbral.tipo).toBe(SettingTipo.DECIMAL);
    expect(new Prisma.Decimal(umbral.valor).toString()).toBe('500');
  });
});
