import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient, Setting, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

// T6.9 — GET/PATCH /settings, OWNER-only (BLUEPRINT §3.8: "Solo OWNER
// los modifica"). Archivo aparte de `settings.integration.spec.ts`
// (T0.13, que prueba `SettingsService` directo contra Postgres, sin
// HTTP, con sus propias claves de prueba) — mismo criterio que
// `sales.integration.spec.ts` vs `sales-controller.integration.spec.ts`:
// service-level y HTTP-level en archivos separados.
//
// Los 4 parámetros son filas GLOBALES ya sembradas por `prisma/seed.ts`
// — no se crean ni se borran acá, así que cada test que modifica una
// fila la restaura a su valor original antes de terminar (no en un
// `afterAll` colectivo: un test que falla a mitad de camino no puede
// dejar `dias_plazo_devolucion` corrompido para el resto de la suite
// completa — `sales`/`returns`/`cash-registers` dependen de estos
// valores por defecto en sus propios tests).

const prisma = new PrismaClient();

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

interface SettingBody {
  clave: string;
  valor: string;
  tipo: 'BOOL' | 'INT' | 'DECIMAL';
  updatedByUserId: number | null;
}

describe('settings controller (integration, T6.9)', () => {
  let app: INestApplication<App>;
  let ownerCookie: string;
  let sellerCookie: string;
  let ownerId: number;
  const createdUserIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  async function restaurar(row: Setting): Promise<void> {
    await prisma.setting.update({
      where: { clave: row.clave },
      data: { valor: row.valor, updatedByUserId: row.updatedByUserId },
    });
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const passwordHash = await argon2.hash('password123');

    const owner = await prisma.user.create({
      data: {
        email: 'settings-controller-test-owner@manitas.local',
        passwordHash,
        nombre: 'Owner de prueba (settings controller)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);
    ownerId = owner.id;

    const seller = await prisma.user.create({
      data: {
        email: 'settings-controller-test-seller@manitas.local',
        passwordHash,
        nombre: 'Seller de prueba (settings controller)',
        rol: UserRole.SELLER,
        activo: true,
      },
    });
    createdUserIds.push(seller.id);

    const ownerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: owner.email, password: 'password123' })
      .expect(200);
    ownerCookie = extractCookie(ownerLogin.headers['set-cookie']);

    const sellerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: seller.email, password: 'password123' })
      .expect(200);
    sellerCookie = extractCookie(sellerLogin.headers['set-cookie']);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  describe('GET /settings', () => {
    it('sin sesión → 401', async () => {
      await request(app.getHttpServer()).get('/settings').expect(401);
    });

    it('con SELLER → 403', async () => {
      await sold(request(app.getHttpServer()).get('/settings')).expect(403);
    });

    it('con OWNER → 200, devuelve los 4 parámetros de BLUEPRINT §10', async () => {
      const response = await owned(
        request(app.getHttpServer()).get('/settings'),
      ).expect(200);

      const body = response.body as SettingBody[];
      const claves = body.map((s) => s.clave).sort();
      expect(claves).toEqual([
        'dias_plazo_devolucion',
        'max_descuento_vendedor_pct',
        'permitir_venta_sin_stock',
        'umbral_diferencia_caja',
      ]);
    });
  });

  describe('PATCH /settings/:clave — autenticación y rol', () => {
    it('sin sesión → 401', async () => {
      await request(app.getHttpServer())
        .patch('/settings/dias_plazo_devolucion')
        .send({ valor: '45' })
        .expect(401);
    });

    it('con SELLER → 403, sin escribir', async () => {
      const antes = await prisma.setting.findUniqueOrThrow({
        where: { clave: 'dias_plazo_devolucion' },
      });

      await sold(
        request(app.getHttpServer()).patch('/settings/dias_plazo_devolucion'),
      )
        .send({ valor: '999' })
        .expect(403);

      const despues = await prisma.setting.findUniqueOrThrow({
        where: { clave: 'dias_plazo_devolucion' },
      });
      expect(despues.valor).toBe(antes.valor);
    });
  });

  describe('PATCH /settings/:clave — camino feliz por tipo', () => {
    it('BOOL (permitir_venta_sin_stock): "true"/"false" reales, valor persistido y updatedByUserId con el OWNER que lo cambió', async () => {
      const original = await prisma.setting.findUniqueOrThrow({
        where: { clave: 'permitir_venta_sin_stock' },
      });
      try {
        const response = await owned(
          request(app.getHttpServer()).patch(
            '/settings/permitir_venta_sin_stock',
          ),
        )
          .send({ valor: 'true' })
          .expect(200);

        const body = response.body as SettingBody;
        expect(body.valor).toBe('true');
        expect(body.updatedByUserId).toBe(ownerId);

        const stored = await prisma.setting.findUniqueOrThrow({
          where: { clave: 'permitir_venta_sin_stock' },
        });
        expect(stored.valor).toBe('true');
        expect(stored.updatedByUserId).toBe(ownerId);
      } finally {
        await restaurar(original);
      }
    });

    it('INT (max_descuento_vendedor_pct): un entero nuevo se persiste', async () => {
      const original = await prisma.setting.findUniqueOrThrow({
        where: { clave: 'max_descuento_vendedor_pct' },
      });
      try {
        const response = await owned(
          request(app.getHttpServer()).patch(
            '/settings/max_descuento_vendedor_pct',
          ),
        )
          .send({ valor: '20' })
          .expect(200);

        expect((response.body as SettingBody).valor).toBe('20');
        const stored = await prisma.setting.findUniqueOrThrow({
          where: { clave: 'max_descuento_vendedor_pct' },
        });
        expect(stored.valor).toBe('20');
      } finally {
        await restaurar(original);
      }
    });

    it('DECIMAL (umbral_diferencia_caja): un monto nuevo se persiste', async () => {
      const original = await prisma.setting.findUniqueOrThrow({
        where: { clave: 'umbral_diferencia_caja' },
      });
      try {
        const response = await owned(
          request(app.getHttpServer()).patch(
            '/settings/umbral_diferencia_caja',
          ),
        )
          .send({ valor: '650.00' })
          .expect(200);

        expect(Number((response.body as SettingBody).valor)).toBeCloseTo(
          650,
          2,
        );
        const stored = await prisma.setting.findUniqueOrThrow({
          where: { clave: 'umbral_diferencia_caja' },
        });
        expect(Number(stored.valor)).toBeCloseTo(650, 2);
      } finally {
        await restaurar(original);
      }
    });
  });

  describe('PATCH /settings/:clave — errores', () => {
    it('valor con formato inválido para el tipo real de la clave → 400, sin escribir', async () => {
      const original = await prisma.setting.findUniqueOrThrow({
        where: { clave: 'dias_plazo_devolucion' },
      });

      await owned(
        request(app.getHttpServer()).patch('/settings/dias_plazo_devolucion'),
      )
        .send({ valor: '30.5' })
        .expect(400);

      const stored = await prisma.setting.findUniqueOrThrow({
        where: { clave: 'dias_plazo_devolucion' },
      });
      expect(stored.valor).toBe(original.valor);
    });

    it('clave inexistente → 404', async () => {
      await owned(
        request(app.getHttpServer()).patch('/settings/clave_inventada'),
      )
        .send({ valor: '1' })
        .expect(404);
    });

    it('valor vacío → 400 (ValidationPipe, @IsNotEmpty)', async () => {
      await owned(
        request(app.getHttpServer()).patch('/settings/dias_plazo_devolucion'),
      )
        .send({ valor: '' })
        .expect(400);
    });

    it('mass-assignment: forzar clave/tipo en el body no cambia otra fila (400, el DTO solo acepta valor)', async () => {
      const original = await prisma.setting.findUniqueOrThrow({
        where: { clave: 'dias_plazo_devolucion' },
      });

      await owned(
        request(app.getHttpServer()).patch('/settings/dias_plazo_devolucion'),
      )
        .send({ valor: '45', clave: 'umbral_diferencia_caja', tipo: 'BOOL' })
        .expect(400);

      const stored = await prisma.setting.findUniqueOrThrow({
        where: { clave: 'dias_plazo_devolucion' },
      });
      expect(stored.valor).toBe(original.valor);
    });
  });
});
