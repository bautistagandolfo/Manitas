// Seed mínimo de la fase 01: usuario OWNER inicial y categorías de gasto de
// la sección 3.7. Nunca se corre en producción como parte del deploy — ver
// BLUEPRINT.md 9.8 (el seed de datos de desarrollo es un script aparte,
// `seed:dev`).

import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

// Semilla de 3.7. Nunca "Mercadería" (AD-7): comprar stock no es un gasto.
const EXPENSE_CATEGORIES = ['Alquiler', 'Sueldos', 'Servicios', 'Impuestos', 'Mantenimiento', 'Otros'];

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
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
