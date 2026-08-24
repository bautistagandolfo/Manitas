// Seed mínimo de la fase 01: usuario OWNER inicial y categorías de gasto de
// la sección 3.7. Nunca se corre en producción como parte del deploy — ver
// BLUEPRINT.md 9.8 (el seed de datos de desarrollo es un script aparte,
// `seed:dev`).

import { PrismaClient, SettingTipo, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

// Semilla de 3.7. Nunca "Mercadería" (AD-7): comprar stock no es un gasto.
const EXPENSE_CATEGORIES = ['Alquiler', 'Sueldos', 'Servicios', 'Impuestos', 'Mantenimiento', 'Otros'];

// Los 4 parámetros de BLUEPRINT §10. `umbral_diferencia_caja` en $500 fijos
// (AMB-10, RESUELTA 2026-08-23 — monto fijo, no porcentaje) — el resto son
// los defaults literales del blueprint.
const SETTINGS: { clave: string; valor: string; tipo: SettingTipo }[] = [
  {
    clave: 'permitir_venta_sin_stock',
    valor: 'false',
    tipo: SettingTipo.BOOL,
  },
  {
    clave: 'max_descuento_vendedor_pct',
    valor: '10',
    tipo: SettingTipo.INT,
  },
  {
    clave: 'dias_plazo_devolucion',
    valor: '30',
    tipo: SettingTipo.INT,
  },
  {
    clave: 'umbral_diferencia_caja',
    valor: '500.00',
    tipo: SettingTipo.DECIMAL,
  },
];

async function main(): Promise<void> {
  const email = process.env.SEED_OWNER_EMAIL;
  const password = process.env.SEED_OWNER_PASSWORD;
  const nombre = process.env.SEED_OWNER_NOMBRE;

  if (!email || !password || !nombre) {
    throw new Error(
      'Faltan SEED_OWNER_EMAIL, SEED_OWNER_PASSWORD o SEED_OWNER_NOMBRE. La contraseña del OWNER nunca se hardcodea (BLUEPRINT.md 3.1).',
    );
  }

  const passwordHash = await argon2.hash(password);

  await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash,
      nombre,
      rol: UserRole.OWNER,
      activo: true,
    },
  });

  for (const nombreCategoria of EXPENSE_CATEGORIES) {
    await prisma.expenseCategory.upsert({
      where: { nombre: nombreCategoria },
      update: {},
      create: {
        nombre: nombreCategoria,
        activo: true,
        bloqueada: true,
      },
    });
  }

  // `update: {}`: no pisa un valor que la dueña ya haya cambiado desde la
  // pantalla de configuración (T6.9) en una corrida posterior del seed —
  // solo crea la fila si no existe, mismo criterio que las categorías de
  // gasto de arriba.
  for (const setting of SETTINGS) {
    await prisma.setting.upsert({
      where: { clave: setting.clave },
      update: {},
      create: setting,
    });
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
