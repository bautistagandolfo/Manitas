# Fase 16 — Release Candidate (re-corrida, post 3 tickets nuevos)

2026-08-30. Rama `fase16-release-candidate-v3`. Re-corrida de
`state/reports/release-candidate-2026-08-30.md` (READY) tras 3 tickets
nuevos hechos en esta misma sesión, todos post-declaración de Release
Candidate:

1. **Listado de ventas por fecha** (`GET /sales` + búsqueda en
   Devoluciones) — commit `de5fa1b`.
2. **Fix retroactivo**: `GET /expenses` filtraba `desde`/`hasta` en UTC
   ingenuo, no en hora argentina — commit `6d40455`.
3. **SKU automático** en el alta manual de una variante — commit
   `b0345d1`.

Los tres, con su detalle completo, en `state/STATUS.md` (filas del
2026-08-30).

Precondición verificada: Fases 13/14/15 no tuvieron código modificado
por estos tres tickets — solo `sales`/`expenses`/`products`
(read-paths y un alta) se tocaron. Se dan por vigentes salvo lo
reconfirmado abajo.

## Qué cambió desde la corrida anterior (READY, 2026-08-30)

- `GET /sales` (endpoint nuevo, sin `@Roles()` — cualquiera
  autenticado, decidido con el usuario).
- `SalesService.findAll`/`ExpensesService.findAll`: `desde`/`hasta`
  ahora se resuelven en hora argentina (`argentinaDayRangeToUtc`,
  AD-13/T0.7) en vez de `Date.UTC` ingenuo.
- `IsValidCalendarDateConstraint` extraído a un validador compartido
  (`common/validation/`).
- `POST /products/:productId/variants`: `sku` opcional, con
  auto-generación (`generateSku`) cuando falta — backend y frontend
  (`NewVariantPage.tsx`).
- Frontend: sección "Buscar por fecha" en `DevolucionPage.tsx`.

## Verificación repetida (no reciclada)

- **Tests**: `npx jest` → **536/536** backend. `npx jest --config
  test/jest-integration.json` → **449/449** (Postgres real, sin
  contaminación de datos entre corridas — verificado). `npx vitest
  run` (frontend) → **84/84**.
- **Build**: backend (`nest build`) limpio. Frontend (`tsc -b && vite
  build`) limpio — bundle 690.67 kB / 207.35 kB gzip (crecimiento
  esperado por el código nuevo de `sales`/`sku`; TD-10 ya documentaba
  este chunk único, sigue sin bloquear a esta escala).
- **Lint**: backend (`eslint src test`) limpio. Frontend limpio salvo
  el warning cosmético ya conocido (TD-6).
- **Dependencias**: `npm audit` backend → 12 total (5 low/3
  moderate/4 high), `--omit=dev` → 3 high, misma cadena exacta de
  siempre (TD-9, `prisma` CLI vía `@prisma/config`/`deepmerge-ts`, sin
  cambios). Frontend → 0.
- **Secretos**: escaneo manual repetido sobre todo el repo versionado
  (patrones de claves AWS, bloques `PRIVATE KEY`, `password=`/
  `secret=` literales) → sin resultados.
- **Migraciones**: `npx prisma migrate status` → "Database schema is
  up to date!", 4 migraciones, sin pendientes.

## Categorías reconfirmadas específicamente (por los 3 tickets)

- **Permisos**: `GET /sales` sin `@Roles()` es intencional (mismo
  criterio que `POST /sales` — "cualquiera autenticado, es el trabajo
  del vendedor"), decidido explícitamente con el usuario. `SaleListItem`
  no expone `costoUnitario` ni ningún campo de costo/margen (confirmado
  por el `select` explícito y por un test dedicado). `GET /expenses`
  sigue `OWNER`-only, sin cambios de rol — el fix fue solo de cálculo de
  fecha. El alta de variante sigue `OWNER`-only (`AMB-11`,
  `RequireOwner`), sin cambios de acceso — solo se volvió opcional un
  campo.
- **Integridad de datos**: la unicidad de `sku` la sigue garantizando
  la constraint de la base (`@unique`), no el código nuevo — confirmado
  por el test existente "rechaza SKU duplicado con 409" (sigue verde,
  sin tocar). `generateSku` es la misma función ya usada y probada en
  la grilla (T2.11) e importación CSV (T2.13), sin lógica nueva, solo
  un tercer punto de entrada.
- **Mass-assignment**: `stockActual` forzado en el body de alta de
  variante se sigue rechazando con 400 (test existente, sin tocar).
- **Rate limiting**: `GET /sales` no tiene `@nestjs/throttler`, mismo
  patrón ya documentado para las rutas mutantes de dinero
  (TD-12/14/15/16) — acá es directamente un `GET` de solo lectura, sin
  el mismo perfil de riesgo que esas rutas; no amerita una TD nueva.
- **Performance**: `GET /sales` filtra por `sales.fecha` sin índice
  explícito — mismo gap pre-existente y transversal ya documentado en
  TD-17 (`sales`/`returns`/`expenses`, sin índice en `fecha`), no un
  gap nuevo introducido por este ticket.

El resto de las categorías (seguridad general, variables de entorno,
configuración de producción, backups, recuperación ante fallos, E2E,
concurrencia) no tenían ningún cambio de código que pudiera haberlas
afectado desde la corrida anterior — se dan por vigentes sin volver a
recorrerlas una por una (ya cubiertas en detalle en
`release-candidate-2026-08-29.md`/`release-candidate-2026-08-30.md`).

## Verificación manual en vivo (no solo automatizada)

Los tres tickets se probaron además contra el sistema real corriendo
(backend + frontend + Postgres real), no solo con tests:

- **Listado de ventas**: se generó una venta real y se encontró
  buscando por fecha desde Devoluciones, con un click cargando la venta
  al flujo existente. El bug de hora argentina se encontró exactamente
  así, en vivo, no en el papel.
- **SKU automático**: se creó una variante real sin completar el campo
  SKU en el formulario — quedó persistida como `P{productId}-M`,
  confirmando que el frontend ya no bloquea el envío y que el backend
  genera el valor esperado.
- Datos de prueba de ambas verificaciones limpiados manualmente
  (venta/sesión/movimiento de stock; variante de prueba), sin residuo
  funcional relevante — confirmado con la suite completa corriendo
  limpia después.

## Riesgos remanentes (sin cambios, no bloquean)

- **TD-18 (MEDIUM)**: Stryker corrido manualmente en cada Fase 08, no
  integrado a `ci.yml` — riesgo de mantenimiento futuro, no del código
  actual. Los 3 tickets de esta sesión no tocaron ningún módulo de
  plata/cálculo core (no se re-corrió Stryker sobre ellos
  específicamente — son extensiones de listado/validación, no lógica
  de cálculo nueva).
- **TD-19 (LOW)**: script `test:e2e`/Playwright colgado sin tests
  reales.
- **B1 de `DECISIONES_PENDIENTES.md`** (AFIP): riesgo de negocio, sin
  cambios desde la corrida anterior.

---

```
RELEASE STATUS: READY

BLOCKERS: ninguno.

HIGH RISKS: ninguno.

MEDIUM RISKS:
- TD-18: Stryker no integrado a CI (riesgo de mantenimiento futuro,
  no del código actual — sin cambios desde la corrida anterior).

TEST SUMMARY: 536/536 unitarios backend, 449/449 integración
  (Postgres real), 84/84 Vitest frontend — todo corrido de nuevo en
  esta re-corrida, no reciclado.
SECURITY SUMMARY: sin CRITICAL/HIGH/MEDIUM nuevos. Permisos/mass-
  assignment/integridad de sku reconfirmados específicamente para los
  3 tickets nuevos (ver arriba). npm audit repetido: 12/3 high backend
  (sin cambios, TD-9), 0 frontend. Sin secretos expuestos.
BUILD: limpio en ambos proyectos (bundle frontend creció ~6 kB gzip,
  esperado, TD-10 sigue sin bloquear).
DATABASE: migraciones al día, sin pendientes.
DEPLOYMENT: sin cambios desde la corrida anterior — sigue pendiente
  únicamente configurar los 6 secrets reales del backup (T0.6) una vez
  que exista hosting real, antes de la Fase 18.
REMAINING RISKS: TD-18/TD-19 (deuda técnica ya documentada, no
  bloqueante), B1 de DECISIONES_PENDIENTES.md (decisión de negocio
  pendiente de confirmar con la clienta, no de código).
```

## Problemas pendientes

Ninguno que bloquee. **El sistema completo, con los 3 tickets nuevos
de esta sesión ya incluidos, queda re-confirmado como Release
Candidate.** Sigue, cuando corresponda (no en esta sesión, requieren
hosting real provisionado): Fase 17 (backup restore drill contra un
backup real, con los secrets configurados), Fase 18 (deploy checklist,
autorización humana) y Fase 19 (production smoke test).
