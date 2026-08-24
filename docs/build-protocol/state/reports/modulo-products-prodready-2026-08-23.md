# Production Readiness Review — módulo `products`/`variants`+`stock` (2026-08-23)

Fase 12 del protocolo. Fase 11 (re-audit) VERDE, verificado en
`state/STATUS.md` antes de empezar. Sin código modificado (regla
explícita) — solo tests existentes, lint, build, análisis estático
(cobertura) y revisión de código. Este es el gate de cierre del módulo:
solo si queda VERDE se lo puede considerar aprobado para la Integration
Audit (fase 13).

## Security

- **Authentication/authorization**: `AuthGuard`+`RolesGuard` globales
  cubren las 20 rutas del módulo. `@Roles(OWNER)` en las operaciones que
  fijan/cambian costo o precio (`POST /products/:id/variants`, `.../grid`,
  `PATCH /variants/:id/price`, `GET /variants/:id/price-history`,
  `PricesController`, `CatalogImportController`, `StockController`
  completo) — el resto (ABM de catálogo, `PATCH /variants/:id` de
  sku/barcode/activo) abierto a cualquier rol autenticado por diseño
  (BLUEPRINT §5.1). Confirmado ruta por ruta en las fases 09 y 11, sin
  cambios de código desde entonces.
- **Secrets**: el módulo no introduce ningún secreto propio; usa
  `DATABASE_URL`/`JWT_SECRET` ya auditados en `auth`.
- **Data exposure**: `costoActual` oculto a quien no sea OWNER en
  `search`/`findOne`/`update`/`create`/`createGrid` (RN-3) — verificado
  con tests dedicados desde T2.x y de nuevo en las fases 08/09.
  `GlobalExceptionFilter` global sigue sin exponer detalles internos en
  ninguna respuesta 4xx/5xx de este módulo.

Sin hallazgos nuevos. El único hallazgo de la fase 09 (LOW, TD-9,
dependencias de Stryker) sigue igual, reconfirmado en la fase 11 — no
es de seguridad de la aplicación, es superficie de `npm audit` en
tooling de desarrollo.

## Reliability

- **Errors**: `GlobalExceptionFilter` normaliza toda excepción del
  módulo a un body consistente. Errores de Prisma (P2002, P2003, P2025)
  traducidos a mensajes de negocio vía `prisma-error.util.ts` y
  `translateRowError`/`translateWriteError` en vez de propagar el error
  crudo — verificado leyendo el código y con los tests existentes que
  cubren cada código de error.
- **Timeouts** — mismo hallazgo que `auth` (TD-3, no nuevo): el
  `http-client.ts` compartido del frontend no usa `AbortController`, así
  que también aplica a las 10 pantallas de este módulo (catálogo,
  grilla, modals de stock/precio) — un corte de red a mitad de un envío
  deja el formulario "cargando" sin feedback. Ya registrado, no se
  duplica la entrada.
- **Retries**: la importación CSV no reintenta filas fallidas
  automáticamente, por diseño (reporte línea por línea, `AMB-12`/T2.13)
  — reintentar es responsabilidad de quien vuelve a subir el archivo,
  correcto para este flujo (no es una operación idempotente por elección
  consciente, ver comentario en `catalog-import.service.ts`).
- **External failures**: sin llamadas a servicios externos en el
  módulo más allá de Postgres vía Prisma.
- **Estados inconsistentes** — el punto más sensible de este módulo,
  revisado con cuidado:
  - `stock.service.ts` nunca abre su propia transacción (contrato de
    sección 4.2 de la spec) — quien llama controla el límite de la
    transacción, verificado en `stock.controller.ts` y
    `variants.service.createGrid`/`catalog-import.service.ts`.
  - `createGrid` es todo-o-nada: una fila inválida no deja variantes
    parciales creadas (verificado con test dedicado).
  - La importación CSV es intencionalmente lo opuesto: cada fila en su
    propia transacción, para que una fila mala no tire abajo las demás
    — documentado como decisión de negocio (`DECISIONES_PENDIENTES.md`
    C2), no un descuido.
  - La única race condition real encontrada en todo el módulo
    (`resolveProduct` con nombre de producto nuevo duplicado bajo
    concurrencia) está corregida desde la fase 08 con un advisory lock,
    verificada 0/15 después del fix.

## Performance

- **Queries**: sin N+1 verificado leyendo `products.service.ts`
  (`findMany`/`findFirst` con `include: { variants: true }`, sin loops)
  y `variants.service.ts` (validación de `sizeIds`/`colorIds` con
  `findMany({ where: { id: { in: [...] } } })`, en lote, no una consulta
  por id).
- **Unnecessary operations**: `createGrid` y la importación CSV
  procesan filas secuencialmente (no en paralelo) — aceptable a la
  escala del MVP y ya con un tope explícito desde la fase 08
  (`@ArrayMaxSize(1000)` en la grilla; 5MB en el CSV). Sin operación
  redundante identificada (cachés por fila en el importador evitan
  resolver la misma marca/categoría/talle/color dos veces).
- **Memory**: sin caches sin cota ni loops sin límite en el código del
  módulo backend.
- **Slow endpoints**: una importación CSV o una grilla grandes (cientos
  de filas) son inherentemente secuenciales y pueden tardar varios
  segundos — comportamiento esperado y ya acotado, no un hallazgo nuevo.
- **Bundle del frontend** — **hallazgo nuevo (LOW, TD-10)**:
  `vite build` advierte que el chunk principal supera 500 kB
  minificados (611 kB, 187 kB gzip), sin code-splitting por ruta en
  ningún lugar del frontend. Es la primera vez que una fase 12 de este
  protocolo corre un build de producción real y deja constancia del
  tamaño — coincide con que las pantallas de este módulo (T2.12) son
  buena parte del código de UI agregado hasta ahora. No bloquea a la
  escala del MVP.

## Code quality

- **Architecture**: mismo patrón que `auth` (controller/service/DTO
  separados); utilidades compartidas correctamente extraídas
  (`sku.util.ts`, `prisma-error.util.ts`, `money.util.ts` — fase 07).
- **Duplication**: baja. La fase 07 ya eliminó las dos duplicaciones
  reales que existían (`assertPositive`, `violatedConstraint`); no se
  encontró ninguna nueva en esta revisión.
- **Complexity**: `resolveProduct` (advisory lock) y los loops
  secuenciales de `createGrid`/import son la parte más compleja del
  módulo — ambos con comentarios que explican el porqué, no solo el
  qué, y cubiertos por tests dedicados a esa complejidad específica
  (la carrera, el todo-o-nada, el aislamiento por fila).
- **Maintainability**: sin `TODO`/`FIXME`/`HACK` en
  `backend/src/modules/products` ni `backend/src/modules/stock`
  (confirmado por grep).
- **Hallazgos LOW ya registrados, sin cambios**: TD-8 (mensajes de
  `ApiError` sin traducir en 10 puntos del frontend del módulo) y TD-9
  (dependencias de Stryker en `npm audit`, dev-only).
- **Cobertura** (`npm run test:cov`, solo unitarios): `stock.service.ts`
  100%, `prices.service.ts` 100%, `variants.service.ts` 97%,
  `products.service.ts` 93.5%, `brands`/`categories`/`colors`/`sizes`
  .service.ts ~90% cada uno, `catalog-import.service.ts` 76.7% (lo no
  cubierto por unitarios son los métodos privados
  `resolveBrand`/`resolveCategory` y algunas ramas de error — sí
  cubiertos por los 9 tests de integración del importador, misma
  separación deliberada unit/integración que el resto del repo). Los
  controllers en 0% en la corrida unitaria **no son un hueco real** —
  los cubre la suite de integración (161 tests contra HTTP real), igual
  que se documentó en la fase 12 de `auth`. Frontend: `grid.ts`
  (`buildGridRows`/`applyDefaultsToAllRows`, la lógica más no trivial
  de la UI de este módulo) tiene 5 tests unitarios propios con Vitest.

## Observability

- **Logs**: `redact` global (fase 10/11 de `auth`) sigue activo para
  este módulo — reconfirmado en la fase 11 con una sesión real
  golpeando rutas de `variants`.
- **Información útil para debug**: el resultado de
  `POST /products/import` es estructurado por fila
  (`{linea, estado, sku, mensaje}`) — permite depurar exactamente qué
  fila falló y por qué sin tener que revisar logs del servidor.

## Deployment

- **Environment variables**: el módulo no agrega ninguna variable de
  entorno propia.
- **Migrations**: `npx prisma migrate status` → *"Database schema is
  up to date"* (corrido de nuevo en esta fase). Sin pendientes.
- **Configuration**: nada específico del módulo más allá de lo ya
  cubierto por `auth` (CORS, cookies) — sin `connection_limit` explícito
  en `DATABASE_URL`, mismo comentario que la fase 12 de `auth` (revisar
  al elegir el proveedor final).
- **Build**: backend (`nest build`) y frontend (`tsc -b && vite build`)
  verdes — corridos de nuevo en esta fase, no reciclados.

## Tests ejecutados

- Backend unitarios: **176/176** verde (`npm run test`).
- Backend integración: **161/161** verde, 3 corridas seguidas sin
  flakes (`npm run test:integration`, contra Postgres real).
- Frontend: **26/26** verde (`npm run test`, Vitest — incluye los 5
  tests de `grid.ts` específicos de este módulo).
- Frontend build: verde (con la advertencia de tamaño de bundle, TD-10).
- Lint backend: verde. Lint frontend: verde (1 warning cosmético
  preexistente en `AuthContext.tsx`, TD-6, no de este módulo).
- `npx prisma migrate status`: sin pendientes.

---

```
PRODUCTION READY: YES

CRITICAL ISSUES: ninguno
HIGH ISSUES: ninguno
MEDIUM ISSUES: ninguno nuevo — TD-3/TD-4 de `auth` (timeout de fetch,
  parámetros de argon2) siguen aplicando de forma transversal a toda la
  app, incluidas las pantallas de este módulo, pero no son hallazgos
  nuevos de esta fase
LOW ISSUES: 2 preexistentes sin cambios (TD-8 mensajes de error sin
  traducir, TD-9 advisories de Stryker) + 1 nuevo (TD-10, bundle del
  frontend sin code-splitting, 611 kB / 187 kB gzip en un solo chunk)

TEST RESULTS: 176/176 unitarios backend, 161/161 integración backend
  (×3), 26/26 frontend, lint y build (backend y frontend) en verde
SECURITY RESULTS: sin hallazgos nuevos; el único hallazgo de la fase 09
  (LOW, TD-9) reconfirmado sin cambios en la fase 11
PERFORMANCE RESULTS: sin N+1 ni queries problemáticas; procesamiento
  secuencial de CSV/grilla aceptado y acotado desde la fase 08; 1 nuevo
  hallazgo LOW de bundle size (TD-10)
REMAINING RISKS: TD-3, TD-4 (transversales, de `auth`), TD-8, TD-9,
  TD-10 (de este módulo) — todos MEDIUM/LOW, ninguno de seguridad ni de
  integridad de datos/dinero/stock, ninguno bloquea el Quality Gate
```

**Aplicando las reglas de bloqueo de `QUALITY_GATE.md`**: sin CRITICAL,
sin HIGH que afecte seguridad/autenticación/autorización/dinero/stock/
integridad de datos — nada bloquea automáticamente. El único MEDIUM
relevante al dominio de este módulo (dinero/stock) que podría generar
dudas es TD-4 (argon2), pero es de `auth`, no de `products` — no aplica
acá. Todos los LOW quedan documentados en `state/TECH_DEBT.md`.

**El módulo `products`/`variants`+`stock` queda aprobado para la
Integration Audit (fase 13).**
