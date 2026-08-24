# QA adversarial — módulo `products`/`variants`+`stock` (2026-08-23)

Fase 08 del protocolo. Objetivo: romper el módulo, no confirmar que
funciona. Alcance: T2.1–T2.13 (`ProductsService`, `VariantsService`,
`StockService`, `PricesService` (bulk update), `CatalogImportService`,
las pantallas de catálogo/grilla/stock del frontend), ya en VERDE desde
la fase 07 (`modulo-products-qa-cierre` en `fase07-cierre-products`).

El hallazgo de severidad ALTA que se encontró abajo **ya está corregido y
probado** en este mismo pase. Ver "Problema pendiente, no bloqueante" al
final para lo que queda como decisión consciente, no como bug.

---

## Hallazgo 1 — Race condition real: doble import concurrente con nombre de producto nuevo crea dos productos duplicados

```
SEVERITY: HIGH
REPRODUCTION: Dos POST /products/import simultáneos, cada uno con un CSV
  que referencia el mismo nombre de producto NUEVO (no existente todavía)
  pero con talle/SKU distintos en cada uno — el "doble click" que esta
  fase exige probar explícitamente.
EXPECTED: Una sola fila en `products` para ese nombre; las dos variantes
  (una de cada import) terminan colgando del mismo `productId`.
ACTUAL: Se creaban dos productos distintos con el mismo nombre, cada uno
  con su propia variante — confirmado empíricamente 15/15 veces con un
  script aislado contra Prisma directo antes del fix, 0/15 después.
ROOT CAUSE: `CatalogImportService.resolveProduct()` hace
  `tx.product.findFirst(...)` y, si no existe, `tx.product.create(...)`,
  dentro de una transacción por fila. A diferencia de brand/category/
  size/color (que sí tienen `@unique` en el schema), `products.nombre`
  NO tiene ninguna restricción de unicidad a nivel de base — dos
  transacciones concurrentes pueden pasar las dos el `findFirst` (ninguna
  ve todavía la fila de la otra bajo READ COMMITTED) y las dos crear.
FIX: `SELECT pg_advisory_xact_lock(hashtext(nombreNormalizado)::bigint)`
  al principio de `resolveProduct()`, antes del `findFirst`. Lock
  scoped a la transacción (se libera solo al commit/rollback, sin
  necesidad de un unlock explícito ni de tocar el schema) — serializa
  por nombre sin exigir ningún índice único que hoy no existe (crear uno
  real es una decisión de negocio: nombres de producto duplicados a
  propósito son legítimos en otros flujos, ver `prices.service.ts`).
  Usa `$executeRaw` (no `$queryRaw` — la función devuelve `void`, que
  `$queryRaw` no puede deserializar, confirmado con el error P2010 antes
  de cambiar el método). Verificado 0/15 carreras después del fix con el
  mismo script aislado, y con un test de integración nuevo a nivel HTTP
  real (8 iteraciones) que confirma que las dos variantes terminan bajo
  el mismo `productId`. Ver `catalog-import.service.ts`, método
  `resolveProduct`.
```

## Hallazgo 2 — Sin límite de tamaño en la grilla de alta de variantes

```
SEVERITY: LOW
REPRODUCTION: POST /products/:id/variants/grid con `sizeIds`/`colorIds`/
  `filas` con miles de elementos.
EXPECTED: Se rechaza antes de tocar la base.
ACTUAL: `CreateVariantGridDto` no tenía ningún `@ArrayMaxSize` en
  `sizeIds`, `colorIds` ni `filas` — solo `@IsArray()`/`@ArrayNotEmpty()`.
  `VariantsService.createGrid()` procesa `filas` secuencialmente dentro
  de una única transacción: un payload enorme la mantendría abierta
  mucho tiempo (riesgo de timeout de transacción o de agotar recursos),
  a diferencia de la importación CSV (T2.13), que procesa cada fila en
  su propia transacción y ya tiene un tope de 5MB en el string del CSV.
  Impacto acotado: la ruta es OWNER-only (ver `variants.controller.ts`),
  no un endpoint público — el "atacante" en el peor caso es el dueño de
  la tienda mandando un payload mal armado por error, no un tercero.
ROOT CAUSE: Falta de cota superior en el DTO — quedó fuera del alcance
  de T2.11 quien lo escribió, no está pedido explícitamente en el
  BLUEPRINT ni en la spec del módulo.
FIX: `@ArrayMaxSize(50)` en `sizeIds`/`colorIds` (una tienda real no
  maneja más de un puñado de talles/colores — 50 deja margen amplio) y
  `@ArrayMaxSize(1000)` en `filas` (permite una grilla de hasta 50×20,
  muy por encima de cualquier alta real). Verificado con dos tests de
  integración nuevos: 1001 filas y 51 `sizeIds` dan 400 sin crear
  ninguna variante.
```

---

## Otras pruebas adversariales sin hallazgos (comportamiento ya correcto)

- **Paginación sin cota**: `VariantSearchQueryDto`, `ProductQueryDto` y
  `PriceHistoryQueryDto` ya tienen `pageSize` con `@Max(100)` — no hay
  forma de pedir una página gigante.
- **Todo o nada en la grilla**: una fila con `precioVenta`/`costo` <= 0
  no crea ninguna variante de las demás (ya cubierto por T2.11, revisado
  de nuevo acá).
- **Import CSV, fila individual vs. archivo completo**: un error de una
  fila no aborta las demás (reporte línea por línea, por diseño desde
  T2.13); un problema de encabezado/archivo sí rechaza todo con 400.
  Reenviar el mismo CSV dos veces no duplica nada — cada fila choca con
  la constraint única de `sku` la segunda vez.
- **Bulk price update, edge case de variantes inactivas**: ya corregido
  en la fase 07 (variantId explícito ignora el filtro `activo`).
- **IDOR / recursos ajenos**: no aplica en el sentido clásico — el
  catálogo es compartido por todo el personal autenticado según su rol,
  no hay un modelo de "cada quien ve lo suyo" que romper.
- **Manipulación de IDs**: `/products/999999`, `/variants/999999`, etc.
  dan 404, no 500 ni un error genérico. IDs no numéricos dan 400.
- **Ocultamiento de `costoActual` a SELLER**: confirmado en `search`,
  `findOne` y `update` (tests existentes desde T2.x, revisados de
  nuevo).
- **Autorización server-side**: todas las rutas mutantes de precio/costo
  inicial (`create`, `createGrid`, `updatePrice`, `catalog-import`,
  `stock/entradas`, `stock/ajustes`) tienen `@Roles(OWNER)` — un SELLER
  recibe 403, no un error silencioso ni un 200 parcial.
- **Mass assignment**: el `ValidationPipe` global (`whitelist: true,
  forbidNonWhitelisted: true`, configurado desde la fase 00 y ya
  probado en el módulo `auth`) también cubre estas rutas — campos de
  más en el body dan 400.
- **SQL injection**: Prisma parametriza todo; el único SQL crudo del
  módulo (`$queryRaw`/`$executeRaw` en `stock.service.ts` y en el fix
  del Hallazgo 1) usa template tags parametrizados, nunca concatena
  strings.
- **UI — doble click / doble submit**: `ProductForm`, `VariantGridPage`
  y los 4 modals de stock/precio deshabilitan su botón de submit
  mientras la request está en vuelo (`disabled={submitting}` /
  `disabled={submitting} loading={submitting}`), verificado en código.
- **UI — validación cliente vs. servidor**: probado en vivo (Browser
  pane) — un `nombre` vacío se rechaza en el cliente sin golpear la API;
  un `nombre` de 270 caracteres (supera el `@MaxLength(200)` del DTO,
  que el formulario no replica) golpea la API, recibe 400 y se muestra
  en un `Alert` sin perder el estado del formulario ni romper la
  pantalla — ver "Problema pendiente" abajo por el idioma del mensaje.

## Problema pendiente, no bloqueante (decisión consciente, no bug)

```
SEVERITY: LOW (aceptado, documentado en TECH_DEBT.md como TD-8)
DESCRIPCIÓN: Los 10 puntos de `frontend/src/features/catalog/**` que
  capturan `ApiError` muestran `err.message` tal cual lo manda el
  backend. Para cualquier regla que el formulario no valida en el
  cliente (ej. el `nombre` de 200 caracteres del Hallazgo de arriba),
  eso deja pasar el string crudo de class-validator en inglés
  ("nombre must be shorter than or equal to 200 characters") en vez de
  un mensaje en español — reproducido en vivo contra el formulario de
  alta de producto.
POR QUÉ NO SE ARREGLA ACÁ: no es pérdida de datos ni de funcionalidad —
  el error se muestra igual, en un `Alert`, sin romper nada. Arreglarlo
  bien implica una traducción genérica de errores de class-validator o
  espejar cada `@MaxLength`/`@Min`/etc. del backend en cada formulario:
  una mejora de UX transversal a varios módulos y varios formularios, no
  algo que corresponda resolver de forma aislada en este ticket.
RECOMENDACIÓN: aceptar como está por ahora. Si se decide invertir en
  esto, es un cambio de infraestructura de errores del frontend (un
  traductor de mensajes o una capa de mapeo por código), no un parche
  puntual — ver TD-8 en `state/TECH_DEBT.md`.
```

## Testing de mutación

BLUEPRINT §9.8 lo pide explícitamente para `stock` (toca dinero y
stock). Corrido con Stryker sobre `src/modules/stock/**/*.service.ts`
(el resto del módulo — CRUD de catálogo, bulk price update — no está en
la lista de §9.8 y no se forzó).

- **Antes**: 44/70 mutantes matados — **62.86%**, por debajo del umbral
  del 80%. Los 26 sobrevivientes eran, sin excepción, mutaciones de la
  FORMA de los argumentos pasados a Prisma (`where`, `data`, `select`,
  `by`, `_sum`, `isolationLevel` vaciados o alterados) — los tests
  existentes verificaban el comportamiento resultante (qué devuelve,
  qué tira) pero no siempre la forma exacta de la query, y el mock de
  `tx`/`prisma` ignora sus argumentos al responder.
- **Después**: 70/70 mutantes matados — **100%**. Se agregaron
  aserciones `toHaveBeenCalledWith(...)` exactas (no `objectContaining`)
  sobre los `where`/`data` de los tres `update`/`findUniqueOrThrow` de
  `registrarEntrada`/`registrarAjuste`, sobre la forma de
  `findMany`/`groupBy`/`$transaction` de `reconciliar()`, y un test
  nuevo de caso límite `delta = 0` (necesario para distinguir el
  operador real `>= 0` del mutante `> 0` — con `delta` positivo los dos
  se comportan igual). Ningún test existente se modificó en su
  intención, solo se agregaron aserciones y un caso nuevo.
- No quedó ningún sobreviviente que documentar como irrelevante — los
  70 mutantes están cubiertos y matados.

## Resultado final

- Tests unitarios: **176/176** en verde (agregados: 2 en
  `stock.service.spec.ts` para matar mutantes; el resto de la
  cobertura nueva de esta fase es de integración).
- Tests de integración: **161/161** en verde, corridos 3 veces seguidas
  para descartar flakiness (agregados: carrera de import concurrente —
  8 iteraciones —, grilla con 1001 filas, grilla con 51 `sizeIds`).
- `tsc --noEmit`, `npm run build` y `npm run lint`: verde, backend y
  frontend.
- Verificación manual en navegador (Browser pane, backend +
  frontend dev corriendo en paralelo): validación de formulario en
  cliente, error de servidor visible sin romper la pantalla, sin
  hallazgos nuevos más allá del ya documentado.
- Sin datos residuales en la base después de cada corrida de
  integración (cleanup por `trackCreatedByName`/`trackReferenceData`
  existente).

**No se declara el módulo `products`/`variants`+`stock` terminado** —
eso es la fase 12 (production readiness), después de la auditoría de
seguridad (fase 09). Con el Hallazgo 1 corregido y el Hallazgo 2
corregido, no queda ningún problema que debería bloquear el Quality
Gate.
