import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Setting, SettingTipo } from '@prisma/client';
import { SettingsService } from './settings.service';
import { PrismaService } from '../../prisma/prisma.service';

function buildRow(overrides: Partial<Setting> = {}): Setting {
  return {
    clave: 'permitir_venta_sin_stock',
    valor: 'false',
    tipo: SettingTipo.BOOL,
    updatedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface MockPrisma {
  setting: {
    findUnique: jest.Mock<Promise<Setting | null>, [unknown]>;
    update: jest.Mock<Promise<Setting>, [unknown]>;
  };
}

function buildMockPrisma(row: Setting | null): MockPrisma {
  return {
    setting: {
      findUnique: jest
        .fn<Promise<Setting | null>, [unknown]>()
        .mockResolvedValue(row),
      update: jest
        .fn<Promise<Setting>, [unknown]>()
        .mockImplementation((args) => {
          const { data } = args as { data: Partial<Setting> };
          return Promise.resolve({ ...(row ?? buildRow()), ...data });
        }),
    },
  };
}

function asPrisma(mock: MockPrisma): PrismaService {
  return mock as unknown as PrismaService;
}

describe('SettingsService', () => {
  describe('getBool', () => {
    it('devuelve true/false parseado del valor guardado', async () => {
      const prisma = buildMockPrisma(
        buildRow({ clave: 'permitir_venta_sin_stock', valor: 'true' }),
      );
      const service = new SettingsService(asPrisma(prisma));

      await expect(service.getBool('permitir_venta_sin_stock')).resolves.toBe(
        true,
      );
    });

    it('lanza NotFoundException si la clave no existe', async () => {
      const prisma = buildMockPrisma(null);
      const service = new SettingsService(asPrisma(prisma));

      await expect(service.getBool('no_existe')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('lanza si la clave existe pero no es de tipo BOOL', async () => {
      const prisma = buildMockPrisma(
        buildRow({
          clave: 'max_descuento_vendedor_pct',
          valor: '10',
          tipo: SettingTipo.INT,
        }),
      );
      const service = new SettingsService(asPrisma(prisma));

      await expect(
        service.getBool('max_descuento_vendedor_pct'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('getInt', () => {
    it('devuelve el entero parseado', async () => {
      const prisma = buildMockPrisma(
        buildRow({
          clave: 'max_descuento_vendedor_pct',
          valor: '10',
          tipo: SettingTipo.INT,
        }),
      );
      const service = new SettingsService(asPrisma(prisma));

      await expect(service.getInt('max_descuento_vendedor_pct')).resolves.toBe(
        10,
      );
    });

    it('lanza si el tipo no es INT', async () => {
      const prisma = buildMockPrisma(buildRow());
      const service = new SettingsService(asPrisma(prisma));

      await expect(service.getInt('permitir_venta_sin_stock')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('getDecimal', () => {
    it('devuelve un Prisma.Decimal parseado del valor guardado', async () => {
      const prisma = buildMockPrisma(
        buildRow({
          clave: 'umbral_diferencia_caja',
          valor: '500.00',
          tipo: SettingTipo.DECIMAL,
        }),
      );
      const service = new SettingsService(asPrisma(prisma));

      const result = await service.getDecimal('umbral_diferencia_caja');
      expect(result).toBeInstanceOf(Prisma.Decimal);
      expect(result.toString()).toBe('500');
    });

    it('lanza si el tipo no es DECIMAL', async () => {
      const prisma = buildMockPrisma(buildRow());
      const service = new SettingsService(asPrisma(prisma));

      await expect(
        service.getDecimal('permitir_venta_sin_stock'),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('setBool / setInt / setDecimal', () => {
    it('setBool actualiza el valor y registra quién lo cambió', async () => {
      const prisma = buildMockPrisma(buildRow());
      const service = new SettingsService(asPrisma(prisma));

      const result = await service.setBool('permitir_venta_sin_stock', true, 9);

      expect(prisma.setting.update).toHaveBeenCalledWith({
        where: { clave: 'permitir_venta_sin_stock' },
        data: { valor: 'true', updatedByUserId: 9 },
      });
      expect(result.valor).toBe('true');
    });

    it('setInt actualiza el valor como string', async () => {
      const prisma = buildMockPrisma(
        buildRow({
          clave: 'max_descuento_vendedor_pct',
          valor: '10',
          tipo: SettingTipo.INT,
        }),
      );
      const service = new SettingsService(asPrisma(prisma));

      await service.setInt('max_descuento_vendedor_pct', 15, 9);

      expect(prisma.setting.update).toHaveBeenCalledWith({
        where: { clave: 'max_descuento_vendedor_pct' },
        data: { valor: '15', updatedByUserId: 9 },
      });
    });

    it('setInt rechaza un valor no entero', async () => {
      const prisma = buildMockPrisma(
        buildRow({
          clave: 'max_descuento_vendedor_pct',
          valor: '10',
          tipo: SettingTipo.INT,
        }),
      );
      const service = new SettingsService(asPrisma(prisma));

      await expect(
        service.setInt('max_descuento_vendedor_pct', 15.5, 9),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.setting.update).not.toHaveBeenCalled();
    });

    it('setDecimal actualiza el valor con dos decimales', async () => {
      const prisma = buildMockPrisma(
        buildRow({
          clave: 'umbral_diferencia_caja',
          valor: '500.00',
          tipo: SettingTipo.DECIMAL,
        }),
      );
      const service = new SettingsService(asPrisma(prisma));

      await service.setDecimal(
        'umbral_diferencia_caja',
        new Prisma.Decimal('750.00'),
        9,
      );

      expect(prisma.setting.update).toHaveBeenCalledWith({
        where: { clave: 'umbral_diferencia_caja' },
        data: { valor: '750', updatedByUserId: 9 },
      });
    });

    it('rechaza escribir una clave inexistente en vez de crearla', async () => {
      const prisma = buildMockPrisma(null);
      const service = new SettingsService(asPrisma(prisma));

      await expect(service.setBool('clave_inventada', true, 9)).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.setting.update).not.toHaveBeenCalled();
    });

    it('rechaza escribir con el setter de tipo equivocado', async () => {
      const prisma = buildMockPrisma(buildRow());
      const service = new SettingsService(asPrisma(prisma));

      await expect(
        service.setInt('permitir_venta_sin_stock', 1, 9),
      ).rejects.toThrow(InternalServerErrorException);
      expect(prisma.setting.update).not.toHaveBeenCalled();
    });
  });
});
