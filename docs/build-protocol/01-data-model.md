# Fase 01 — Modelo de datos

Se ejecuta **una sola vez**, después del setup.

> **Antes de empezar:** verificá que la Fase 00 esté VERDE en
> `state/STATUS.md`. Leé `BLUEPRINT.md` secciones 3 (modelo de datos), 6
> (invariantes) y 9.3 (dinero).

Implementá el esquema completo de Prisma según la **sección 3 del
`BLUEPRINT.md`**, tabla por tabla, sin omitir ninguna.

## Requisitos

1. **Todas** las tablas de la sección 3, con sus campos, tipos y relaciones
   exactos.
2. Todo importe como `Decimal @db.Decimal(12,2)`. **Nunca `Float`.**
3. Todos los índices y restricciones de unicidad indicados en el blueprint,
   incluidos:
   - `variants.sku` único, `variants.barcode` único (nullable).
   - Combinación única (`product_id`, `talle`, `color`).
   - `sales.numero` y `returns.numero` únicos.
   - `idempotency_key` único en `sales` y `returns`.
4. Restricciones a nivel de base de datos donde el blueprint las exige,
   **no solo validación en la aplicación**:
   - `cantidad > 0` en líneas de venta.
   - `monto > 0` en pagos y gastos.
   - Índice único parcial que impida **dos sesiones de caja `ABIERTA`**
     simultáneas.
5. **Secuencias de Postgres** para `sales.numero` y `returns.numero`
   (nunca `MAX(numero) + 1` — ver blueprint 9.4).
6. Primera migración generada y aplicada.
7. `seed.ts` que cree: un usuario `OWNER` inicial (contraseña por variable de
   entorno, nunca hardcodeada) y las categorías de gasto de la sección 3.7.
   **Sin categoría "Mercadería"** (ver AD-7).

## Validación

- La migración corre limpia sobre una base vacía.
- La migración es reversible, o se documenta por qué no lo es.
- El seed corre sin errores.
- Un test de integración verifica que cada restricción de la base
  efectivamente **rechaza** el dato inválido (no alcanza con que exista en
  el esquema).
- Lint, build y CI en verde.

## Restricciones

- Sin lógica de negocio: solo esquema, migración y seed.
- Sin controllers ni services de módulos.
- No inventes tablas que no estén en el blueprint. Si detectás que falta
  algo, **paralo y reportalo** en vez de improvisar: el blueprint es la
  fuente de verdad y se corrige ahí primero.

---

> **Al finalizar:** agregá una fila a `state/STATUS.md` (Fase 01,
> VERDE/BLOQUEADO, hash del commit).
