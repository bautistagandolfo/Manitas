import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExpenseCategoriesService } from './expense-categories.service';
import { PrismaService } from '../../prisma/prisma.service';

// T6.1 — mismo patrón mecánico que `brands.service.spec.ts` (Prisma
// mockeado directo, sin `tx`: este servicio nunca abre una
// transacción de escritura, cada operación es un único `create`/
// `update`/`findMany`, mismo criterio que `brands`/`categories`).
type MockPrisma = {
  expenseCategory: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

function buildMockPrisma(): MockPrisma {
  return {
    expenseCategory: {
      create: jest.fn(),
      // Ticket nuevo (post Release Candidate) — `create`/`update` ahora
      // consultan `findMany` primero (chequeo de duplicado case/acento-
      // insensible, `esNombreDuplicado`). Default `[]` para no romper
      // los tests preexistentes que no le prestan atención a esta
      // consulta nueva — los que sí, la pisan con `mockResolvedValueOnce`.
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
}

function prismaUniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
  });
}

describe('ExpenseCategoriesService', () => {
  let prisma: MockPrisma;
  let service: ExpenseCategoriesService;

  beforeEach(() => {
    prisma = buildMockPrisma();
    service = new ExpenseCategoriesService(prisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('ordena por nombre', async () => {
      prisma.expenseCategory.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(prisma.expenseCategory.findMany).toHaveBeenCalledWith({
        orderBy: { nombre: 'asc' },
      });
    });
  });

  describe('create (RN-1, AD-7)', () => {
    it('crea una categoría, con el nombre exacto que llegó en el DTO', async () => {
      prisma.expenseCategory.create.mockResolvedValue({
        id: 1,
        nombre: 'Limpieza',
      });

      const result = await service.create({ nombre: 'Limpieza' });

      expect(result).toEqual({ id: 1, nombre: 'Limpieza' });
      expect(prisma.expenseCategory.create).toHaveBeenCalledWith({
        data: { nombre: 'Limpieza' },
      });
    });

    it('traduce una violación de nombre único a ConflictException, con el mensaje exacto', async () => {
      prisma.expenseCategory.create.mockRejectedValue(prismaUniqueViolation());

      const call = service.create({ nombre: 'Limpieza' });
      await expect(call).rejects.toBeInstanceOf(ConflictException);
      await expect(call).rejects.toThrow(
        'Ya existe una categoría de gasto con ese nombre',
      );
    });

    // Ticket nuevo (post Release Candidate) — mismo hallazgo real
    // verificado en vivo en `colors.service.ts`: "limpieza" se crea
    // como una categoría nueva y distinta cuando ya existe "Limpieza"
    // (@unique de Postgres es case-sensitive).
    it('rechaza "limpieza" cuando ya existe "Limpieza" — mayúsculas distintas, misma categoría', async () => {
      prisma.expenseCategory.findMany.mockResolvedValue([
        { nombre: 'Limpieza' },
      ]);

      await expect(
        service.create({ nombre: 'limpieza' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.expenseCategory.create).not.toHaveBeenCalled();
    });

    // Fase 08 (QA adversarial): el chequeo de P2002 es específico — un
    // error de Prisma con OTRO código, o un error que ni siquiera es de
    // Prisma, tiene que propagarse tal cual, nunca traducirse a
    // ConflictException (eso escondería el error real detrás de un
    // mensaje de "nombre duplicado" que no es lo que pasó).
    it('un error de Prisma con otro código (no P2002) se propaga sin traducir', async () => {
      const otroError = new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed',
        { code: 'P2003', clientVersion: '6.19.3' },
      );
      prisma.expenseCategory.create.mockRejectedValue(otroError);

      await expect(service.create({ nombre: 'Limpieza' })).rejects.toBe(
        otroError,
      );
    });

    it('un error que no es de Prisma se propaga sin traducir', async () => {
      const errorGenerico = new Error('la base no responde');
      prisma.expenseCategory.create.mockRejectedValue(errorGenerico);

      await expect(service.create({ nombre: 'Limpieza' })).rejects.toBe(
        errorGenerico,
      );
    });

    // AD-7, literal: nunca "Mercadería" — probado con la tilde, sin
    // tilde, mayúsculas y como substring dentro de un nombre más largo,
    // para los tres patrones que el blueprint da como ejemplo.
    it.each([
      'Mercadería',
      'mercaderia',
      'MERCADERÍA',
      'Compra de mercadería para reventa',
      'Compra de ropa',
      'Pago a proveedores',
    ])('rechaza "%s" — alude a compra de mercadería (AD-7)', async (nombre) => {
      const call = service.create({ nombre });
      await expect(call).rejects.toBeInstanceOf(BadRequestException);
      await expect(call).rejects.toThrow(
        'Comprar mercadería no es un gasto — se registra como ingreso de stock',
      );
      expect(prisma.expenseCategory.create).not.toHaveBeenCalled();
    });

    // Fase 08 — límites exactos del filtro Unicode de `normalizar`
    // (0x0300–0x036F, "Combining Diacritical Marks"), no solo el caso de
    // en medio del rango que ya cubre "Mercadería" (é = e + U+0301).
    it('rechaza un nombre con acento grave (U+0300, el primer combinante del rango) — "mercadèria"', async () => {
      // 'è' descompone (NFD) en 'e' + U+0300 exacto: el límite INFERIOR
      // del rango que `normalizar` tiene que descartar.
      await expect(
        service.create({ nombre: 'Comprar mercadèria' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.expenseCategory.create).not.toHaveBeenCalled();
    });

    it('rechaza un nombre con el combinante U+036F insertado a mano (el último del rango)', async () => {
      // U+036F ("combining latin small letter x") es el límite SUPERIOR
      // exacto del rango — no aparece en ningún acento español real, se
      // inserta a mano para probar el límite del filtro en sí, no un
      // caso de negocio. Insertado entre "mercaderi" y "a" para que,
      // filtrado correctamente, quede "mercaderia" intacto.
      const nombre = `Pago a mercaderi${String.fromCodePoint(0x036f)}a falsa`;
      await expect(service.create({ nombre })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.expenseCategory.create).not.toHaveBeenCalled();
    });

    it('acepta un nombre que no alude a mercadería, aunque contenga palabras parecidas sueltas', async () => {
      prisma.expenseCategory.create.mockResolvedValue({
        id: 2,
        nombre: 'Insumos de oficina',
      });

      await expect(
        service.create({ nombre: 'Insumos de oficina' }),
      ).resolves.toBeDefined();
    });
  });

  describe('update (RN-1: bloqueada + AD-7)', () => {
    it('actualiza una categoría no bloqueada', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Limpieza',
        activo: true,
        bloqueada: false,
      });
      prisma.expenseCategory.update.mockResolvedValue({
        id: 1,
        nombre: 'Limpieza y mantenimiento',
        activo: true,
        bloqueada: false,
      });

      const result = await service.update(1, {
        nombre: 'Limpieza y mantenimiento',
      });

      expect(result.nombre).toBe('Limpieza y mantenimiento');
      expect(prisma.expenseCategory.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { nombre: 'Limpieza y mantenimiento' },
      });
    });

    // Ticket nuevo (post Release Candidate) — mismo hallazgo que en
    // `create`, aplicado a renombrar. `findUnique` (chequeo de
    // `bloqueada`) pasa igual; lo que la rechaza es el `findMany` nuevo.
    it('rechaza renombrar a "servicios" cuando ya existe "Servicios" en OTRA fila', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Limpieza',
        activo: true,
        bloqueada: false,
      });
      prisma.expenseCategory.findMany.mockResolvedValue([
        { nombre: 'Servicios' },
      ]);

      await expect(
        service.update(1, { nombre: 'servicios' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.expenseCategory.update).not.toHaveBeenCalled();
    });

    it('rechaza con NotFoundException si el id no existe, con el mensaje exacto', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(null);

      const call = service.update(999, { nombre: 'X' });
      await expect(call).rejects.toBeInstanceOf(NotFoundException);
      await expect(call).rejects.toThrow('Categoría de gasto no encontrada');
      expect(prisma.expenseCategory.findUnique).toHaveBeenCalledWith({
        where: { id: 999 },
      });
      expect(prisma.expenseCategory.update).not.toHaveBeenCalled();
    });

    it('rechaza CUALQUIER cambio de nombre en una categoría bloqueada, con el mensaje exacto', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Alquiler',
        activo: true,
        bloqueada: true,
      });

      const call = service.update(1, { nombre: 'Alquiler mensual' });
      await expect(call).rejects.toBeInstanceOf(ConflictException);
      await expect(call).rejects.toThrow(
        'Esta categoría no se puede modificar',
      );
      expect(prisma.expenseCategory.update).not.toHaveBeenCalled();
    });

    it('rechaza CUALQUIER cambio de activo en una categoría bloqueada, con el mensaje exacto', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Alquiler',
        activo: true,
        bloqueada: true,
      });

      const call = service.update(1, { activo: false });
      await expect(call).rejects.toBeInstanceOf(ConflictException);
      await expect(call).rejects.toThrow(
        'Esta categoría no se puede modificar',
      );
      expect(prisma.expenseCategory.update).not.toHaveBeenCalled();
    });

    // Fase 08 — el chequeo de bloqueada dispara solo si el DTO trae
    // `nombre` y/o `activo`; un PATCH con body vacío sobre una
    // categoría bloqueada no tiene nada que bloquear y tiene que
    // pasar igual (releer T6.1: "sí se puede seguir usando en
    // POST /expenses", nada prohíbe un PATCH sin cambios reales).
    it('un PATCH sin nombre ni activo sobre una categoría bloqueada NO se rechaza', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Alquiler',
        activo: true,
        bloqueada: true,
      });
      prisma.expenseCategory.update.mockResolvedValue({
        id: 1,
        nombre: 'Alquiler',
        activo: true,
        bloqueada: true,
      });

      await expect(service.update(1, {})).resolves.toBeDefined();
      expect(prisma.expenseCategory.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: {},
      });
    });

    it('rechaza un nombre que alude a mercadería, aunque la categoría NO esté bloqueada, con el mensaje exacto', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 5,
        nombre: 'Insumos de oficina',
        activo: true,
        bloqueada: false,
      });

      const call = service.update(5, { nombre: 'Compra de mercadería' });
      await expect(call).rejects.toBeInstanceOf(BadRequestException);
      await expect(call).rejects.toThrow(
        'Comprar mercadería no es un gasto — se registra como ingreso de stock',
      );
      expect(prisma.expenseCategory.update).not.toHaveBeenCalled();
    });

    it('traduce una violación de nombre único a ConflictException, con el mensaje exacto', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Limpieza',
        activo: true,
        bloqueada: false,
      });
      prisma.expenseCategory.update.mockRejectedValue(prismaUniqueViolation());

      const call = service.update(1, { nombre: 'Servicios' });
      await expect(call).rejects.toBeInstanceOf(ConflictException);
      await expect(call).rejects.toThrow(
        'Ya existe una categoría de gasto con ese nombre',
      );
    });

    it('un error de Prisma con otro código (no P2002) se propaga sin traducir', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Limpieza',
        activo: true,
        bloqueada: false,
      });
      const otroError = new Prisma.PrismaClientKnownRequestError(
        'Foreign key constraint failed',
        { code: 'P2003', clientVersion: '6.19.3' },
      );
      prisma.expenseCategory.update.mockRejectedValue(otroError);

      await expect(service.update(1, { nombre: 'Servicios' })).rejects.toBe(
        otroError,
      );
    });

    it('un error que no es de Prisma se propaga sin traducir', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Limpieza',
        activo: true,
        bloqueada: false,
      });
      const errorGenerico = new Error('la base no responde');
      prisma.expenseCategory.update.mockRejectedValue(errorGenerico);

      await expect(service.update(1, { nombre: 'Servicios' })).rejects.toBe(
        errorGenerico,
      );
    });

    it('puede desactivar una categoría no bloqueada', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 6,
        nombre: 'Insumos de oficina',
        activo: true,
        bloqueada: false,
      });
      prisma.expenseCategory.update.mockResolvedValue({
        id: 6,
        nombre: 'Insumos de oficina',
        activo: false,
        bloqueada: false,
      });

      const result = await service.update(6, { activo: false });

      expect(result.activo).toBe(false);
    });
  });
});
