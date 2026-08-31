-- Ticket nuevo (post Release Candidate) — hallazgo real: `prisma migrate
-- dev` generó acá un `DROP INDEX "variants_product_size_color_key"`. Ese
-- índice (NULLS NOT DISTINCT en product_id/size_id/color_id, ver
-- 20260823002959_init/migration.sql) nunca está representado en
-- schema.prisma — se agregó a mano porque en su momento Prisma no podía
-- expresar NULLS NOT DISTINCT — así que el diff automático de `migrate
-- dev` lo ve como "no declarado" y propone borrarlo cada vez que corre,
-- sin relación con este ticket. Es la única guarda real contra cargar
-- dos veces el mismo producto sin talle ni color (un cinturón, una
-- cartera) — se sacó el DROP a mano acá; nunca se llegó a aplicar contra
-- la base de dev (se restauró aparte antes de este commit). Pendiente:
-- este mismo problema se va a repetir en el próximo `migrate dev` que
-- alguien corra — no se resuelve en este ticket (fuera de alcance).

-- AlterTable
ALTER TABLE "returns" ADD COLUMN     "customer_id" INTEGER;

-- CreateTable
CREATE TABLE "customers" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "dni" TEXT NOT NULL,
    "telefono" TEXT,
    "activo" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_dni_key" ON "customers"("dni");

-- CreateIndex
CREATE INDEX "returns_customer_id_idx" ON "returns"("customer_id");

-- AddForeignKey
ALTER TABLE "returns" ADD CONSTRAINT "returns_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
