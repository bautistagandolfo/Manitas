# Spec del módulo `products` / `variants` + `stock` (2026-08-23)

Fase 06 del protocolo, Etapa 2 de `state/ROADMAP.md` (T2.1–T2.12).
Dependencia declarada (T1.3, guards de `auth`) VERDE. Fuentes:
`BLUEPRINT.md` §3.2, §3.3, §5.2, invariante 1, §7, §9.3, §9.4, §9.8,
§12.2, §12.4; `MVP_SCOPE.md` §3.2 (riesgo ALTO); `DECISIONES_PENDIENTES.md`
A3, A4, A5, C2; `state/AMBIGUITIES.md` AMB-4, AMB-6 (ya resueltas).

**Actualizado 2026-08-23:** T2.1, T2.2 y T0.12 en VERDE; AMB-11
RESUELTA. Ver el estado actualizado al final del documento (después de
la sección 11).

---

## 1. Responsabilidad

Este módulo es dueño de:

- El catálogo: `brands`, `categories`, `sizes`, `colors`, `products`,
  `variants`.
- El **libro de movimientos de stock** (`stock_movements`) y el
  contador denormalizado (`variants.stock_actual`) — vía un único
  servicio, `stock.service.ts` (CLAUDE.md regla 4: **solo ese archivo
  escribe movimientos de stock**, en todo el sistema).
- El historial de precios y costos (`price_history`).
- La actualización masiva de precios.
- La carga inicial masiva por grilla (alta) y por CSV (ver T2.13,
  sección 11).

**Qué NO hace este módulo:**

- No vende. `sales` es quien llama a `stock.service` para descontar
  stock al cerrar una venta (AD-4) — ese descuento, con su propio
  bloqueo de filas multi-variante (§9.4), lo especifica la Fase 06 de
  `sales`, no esta. Acá se especifica y construye la **API interna**
  que `sales`/`returns` van a usar (ver sección 4.2), pero no su
  lógica de venta/devolución.
- No calcula resultados ni márgenes agregados — eso es `resultados`
  (Etapa 6).
- No maneja caja ni pagos — si el ingreso de mercadería se paga en
  efectivo desde el cajón, ese movimiento de caja lo registra
  `cash-registers` como `RETIRO`, nunca este módulo (BLUEPRINT §5.2,
  AD-7). `stock.service` solo escribe el `stock_movements` con su
  `costo_unitario`; no toca `cash_movements`.
- No maneja fotos de producto (§12.5, fuera del MVP a propósito).

## 2. Reglas de negocio

Numeradas para referenciarlas desde tickets y tests.

**RN-1.** La venta y el stock operan **siempre** sobre `variants`,
nunca sobre `products` directamente (§5.2).

**RN-2.** `sku` obligatorio y único; `barcode` opcional pero único si
existe (constraint de base ya presente en el schema, fase 01).

**RN-3.** El costo (`costo_actual`, `stock_movements.costo_unitario`,
y el campo `COSTO` de `price_history`) **solo lo ve y edita `OWNER`**
(§5.2, literal). Ver sección 8 para el resto de la matriz de permisos.

**RN-4.** Ingreso de mercadería: crea un `stock_movements` con
`tipo = ENTRADA` y `costo_unitario` obligatorio, y actualiza
`variants.costo_actual` al valor de ese ingreso (AD-6, costeo por
último costo). **Nunca genera un `expense`** (AD-7) — si se pagó en
efectivo de la caja, es responsabilidad de `cash-registers` registrar
el `RETIRO` correspondiente; este módulo no lo dispara ni lo conoce.

**RN-5.** Ajuste de stock: solo `OWNER`, `motivo` obligatorio,
`delta` puede ser positivo o negativo. Un ajuste que dejaría
`stock_actual < 0` se **rechaza siempre**, sin excepción de
`permitir_venta_sin_stock` — esa bandera, por su nombre y por
BLUEPRINT invariante 5, regula si se puede **vender** sin stock, no si
se puede *corregir a mano* un stock a un número negativo (que no tiene
sentido físico: no existen "-3 unidades" en un estante). Ver sección 6
para el caso límite.

**RN-6.** Baja lógica únicamente: productos y variantes nunca se
borran, aunque no tengan ventas asociadas — es más simple mantener una
sola regla ("nunca se borra") que dos ramas distintas según haya
historial o no (§5.2 solo lo exige cuando *hay* ventas asociadas; acá
se generaliza porque no hay ningún beneficio real en permitir el
borrado físico en el resto de los casos, y si mañana aparece una
venta, la fila ya no se puede borrar de todos modos).

**RN-7.** Una variante dada de baja (`activo = false`) con
`stock_actual > 0` **sigue contando** en el valor de inventario y en
la reconciliación del invariante 1. Lo único que cambia es que
desaparece del buscador de venta (RN-11).

**RN-8.** Alta por grilla (§12.2): se generan todas las combinaciones
talle × color de una vez; el stock inicial de cada combinación **pasa
por `stock.service` como un movimiento `ENTRADA`** con su
`costo_unitario`, uno por variante — nunca se escribe `stock_actual`
directo (AD-4, y lo remarca §5.2 explícitamente: si se hiciera, el
invariante 1 falla desde el día uno en todas las variantes del
sistema).

**RN-9.** Actualización masiva de precios: filtro por marca,
categoría o selección manual; aplica un **porcentaje**; **vista previa
obligatoria** (precio actual vs. resultante) antes de confirmar; cada
cambio aplicado escribe en `price_history` con `origen = MASIVO`.
Solo `OWNER` (A5, §5.2).

**RN-10.** Todo cambio de `precio_venta` o `costo_actual` —manual,
masivo o por ingreso de mercadería— escribe en `price_history`
(AD-16), con el valor anterior, el nuevo, quién y cuándo.

**RN-11.** El buscador unificado acepta nombre de producto, SKU o
código de barras en un solo campo de texto (un lector de barras es un
teclado rápido que termina en Enter — mismo input sirve para los tres
casos). Solo trae variantes con `activo = true` **y** con
`products.activo = true` (un producto dado de baja no debería
resucitar en el buscador solo porque su variante sigue activa —
inferido de RN-7, que solo habla de la variante).

**RN-12.** Listados paginados en el servidor siempre (§12.4) — nunca
se trae el catálogo completo al frontend. El buscador de venta usa
*debounce* ~250ms en el frontend, salvo coincidencia exacta de SKU o
código de barras, que resuelve al instante (esto es responsabilidad
del frontend de `sales`, pero el contrato de API de este módulo tiene
que soportarlo: ver 4.1, `GET /variants/search`).

## 3. Invariantes

De la sección 6 del blueprint, los que este módulo garantiza
directamente:

- **Invariante 1** — `variants.stock_actual == SUM(stock_movements.delta)`
  para cada variante. Se garantiza porque **todo** cambio de stock pasa
  por `stock.service`, que escribe el movimiento y actualiza el
  contador **en la misma transacción** (ver sección 5). T2.8 es el
  test de reconciliación explícito que lo verifica corriendo sobre
  datos reales, no solo confiando en el código.
- **Invariante 5** — `stock_actual >= 0`, salvo
  `permitir_venta_sin_stock` activo. Este módulo lo garantiza para sus
  propias escrituras (`ENTRADA` nunca lo viola, porque solo suma;
  `AJUSTE` lo valida explícitamente, sin excepción — RN-5). La
  excepción de `permitir_venta_sin_stock` es responsabilidad de
  `sales`, no de este módulo — acá no se lee ni se aplica esa bandera.
- **Invariante 6** — ningún `stock_movements` sin `tipo`; si es
  `AJUSTE` tiene `motivo`. Se garantiza a nivel de DTO (`motivo`
  obligatorio en el endpoint de ajuste) y con un `CHECK` de base
  agregado en la fase 01. Los tipos `VENTA`, `DEVOLUCION` y
  `ANULACION` (con su `referencia_tipo`/`referencia_id` obligatorios)
  los emite `sales`/`returns` llamando a la API interna de
  `stock.service` (sección 4.2) — este módulo expone esa API pero no
  la usa él mismo para esos tipos.

## 4. Contratos de API

### 4.1 Endpoints REST

Prefijo común `/api` omitido (ya establecido en `main.ts`). Todos
requieren sesión (`AuthGuard` global); el rol exigido se indica por
endpoint. Todo listado pagina con `page`/`pageSize` (RN-12) y devuelve
`{ items, totalItems, page, pageSize }`. **Corrección post-spec (T2.2):**
"total" a secas dispara el linter local `no-number-money` (BLUEPRINT §9.3
trata cualquier "total" tipado `number` como sospechoso de ser plata) —
se usa `totalItems` en la implementación real desde T2.2 en adelante.

**Catálogo auxiliar** (`brands`, `categories`, `sizes`, `colors` — los
cuatro con la misma forma):

| Método | Ruta | Rol | Body | Notas |
|---|---|---|---|---|
| GET | `/brands` | cualquiera autenticado | — | lista completa, sin paginar (son pocas decenas como mucho — a diferencia de productos/variantes) |
| POST | `/brands` | cualquiera autenticado | `{ nombre }` | `sizes`/`colors` además llevan `orden`. **Corrección post-spec:** no está en la lista de exclusiones de SELLER (§5.1) — ver sección 8, la tabla original acá decía `OWNER` por error de arrastre, corregido antes de T2.1 |
| PATCH | `/brands/:id` | cualquiera autenticado | `{ nombre?, activo? }` | baja lógica vía `activo: false` |

Igual para `/categories`, `/sizes` (con `orden: number` en el body de
alta/edición), `/colors`.

**Productos:**

| Método | Ruta | Rol | Notas |
|---|---|---|---|
| GET | `/products` | cualquiera | paginado, filtros `marca`, `categoria`, `activo` |
| GET | `/products/:id` | cualquiera | incluye sus variantes |
| POST | `/products` | cualquiera autenticado (ver sección 8) | `{ nombre, descripcion?, brandId?, categoryId? }` |
| PATCH | `/products/:id` | cualquiera autenticado | `{ nombre?, descripcion?, brandId?, categoryId?, activo? }` |

**Variantes:**

| Método | Ruta | Rol | Notas |
|---|---|---|---|
| GET | `/variants/search?q=` | cualquiera | RN-11, buscador unificado |
| GET | `/variants/:id` | cualquiera | `costoActual` **omitido si el rol no es `OWNER`** (RN-3) |
| POST | `/products/:id/variants` | cualquiera autenticado | alta de **una** variante suelta (talle/color ya elegidos, sin pasar por la grilla) |
| POST | `/products/:id/variants/grid` | cualquiera autenticado | RN-8, body: `{ sizeIds[], colorIds[], stockPorDefecto?, precioPorDefecto?, costoPorDefecto?, filas: [{ sizeId, colorId, sku?, stock, precioVenta, costo }] }` — genera las combinaciones, cada una vía `stock.service.registrarEntrada` |
| PATCH | `/variants/:id` | cualquiera autenticado | `{ precioVenta?, sku?, barcode?, activo? }` — **nunca `costoActual` ni `stockActual` acá** (eso es RN-3/RN-5, van por sus propios endpoints) |

**Stock:**

| Método | Ruta | Rol | Notas |
|---|---|---|---|
| POST | `/stock/entradas` | `OWNER` (AMB-11, RESUELTA) | `{ variantId, cantidad, costoUnitario }`. **Sin `Idempotency-Key`** — decisión del PO (2026-08-23, ver `ROADMAP.md`): extender T0.14 acá hubiese exigido agregar `idempotency_key` a `stock_movements`, fuera de lo que pide el blueprint. Riesgo de doble click aceptado conscientemente. |
| POST | `/stock/ajustes` | `OWNER` | `{ variantId, delta, motivo }` |
| GET | `/variants/:id/stock-movements` | cualquiera | paginado, historial de solo lectura |

**Precios:**

| Método | Ruta | Rol | Notas |
|---|---|---|---|
| GET | `/variants/:id/price-history` | `OWNER` (incluye costo — RN-3) | paginado |
| POST | `/prices/bulk-update/preview` | `OWNER` | `{ filtro: { brandId?, categoryId?, variantIds? }, porcentaje }` → devuelve la lista `{ variantId, sku, precioActual, precioResultante }` **sin escribir nada** |
| POST | `/prices/bulk-update/apply` | `OWNER` | mismo body que el preview. **Sin `Idempotency-Key`** — decisión del PO (2026-08-23, ver `ROADMAP.md`, mismo criterio que T2.5): `price_history` no tiene `idempotency_key`, y acá el motivo es más fuerte que en T2.5 — una sola aplicación escribe N filas (una por variante), y el mecanismo de T0.14 está pensado para deduplicar una fila por clave, no un batch completo. Aplica y escribe `price_history` con `origen = MASIVO` (RN-9). Riesgo de doble click (aplicar el mismo aumento dos veces) aceptado conscientemente. |

### 4.2 API interna de `stock.service.ts` (no HTTP)

Para que `sales`/`returns`/`cash-registers` (módulos futuros) puedan
cumplir CLAUDE.md regla 4 sin duplicar lógica de stock. Firma
propuesta (ajustable en su propia fase 06, pero el contrato básico
queda fijado acá para no romper esta fase cuando lleguen):

```ts
class StockService {
  // Usado por este módulo (T2.5, T2.6, T2.11):
  registrarEntrada(tx, { variantId, cantidad, costoUnitario, userId }): Promise<void>
  registrarAjuste(tx, { variantId, delta, motivo, userId }): Promise<void>

  // Expuesto para sales/returns (no se llama desde este módulo):
  descontarPorVenta(tx, { variantId, cantidad, saleId, userId }): Promise<void>
  revertirPorDevolucion(tx, { variantId, cantidad, returnId, userId }): Promise<void>
  revertirPorAnulacion(tx, { variantId, cantidad, saleId, userId }): Promise<void>
}
```

Todos los métodos **exigen recibir el `tx` de una transacción ya
abierta** por quien llama (no abren la suya propia) — porque en
`sales`, el movimiento de stock es un paso más dentro de la
transacción completa de la venta (§5.3: validar caja → validar stock →
crear venta → pagos → **stock** → caja), no una operación aislada.

## 5. Transacciones y concurrencia

Patrón general: BLUEPRINT §9.4, ya en uso en `auth`/`users.service.ts`
(fase 08) para una preocupación análoga (una fila, no dinero).

- **`registrarEntrada`** (ENTRADA, siempre `delta > 0`): **no necesita
  `SELECT ... FOR UPDATE` explícito.** Se implementa como un
  incremento atómico —
  `tx.variant.update({ where: { id }, data: { stockActual: { increment: cantidad } } })`
  — Postgres serializa por sí solo los `UPDATE` concurrentes sobre la
  misma fila; no hace falta leer el valor actual porque nunca se
  valida contra un umbral (solo suma). Más simple y sin el costo de
  una espera de lock innecesaria.
- **`registrarAjuste`** (delta positivo o negativo): **si `delta < 0`,
  sí necesita el lock explícito** — hay que leer `stock_actual`,
  validar `stock_actual + delta >= 0` (RN-5) y escribir, todo dentro
  de la misma transacción con `SELECT id FROM variants WHERE id = $1
  FOR UPDATE` antes de leer, mismo motivo que en `auth` (fase 08): sin
  bloquear, dos ajustes negativos concurrentes sobre la misma variante
  pueden leer el mismo `stock_actual` y las dos pasar la validación,
  dejando el contador negativo. Si `delta >= 0`, se comporta como
  `registrarEntrada` (incremento atómico, sin lock).
- **Alta por grilla (T2.11):** N variantes nuevas, cada una con su
  propio `registrarEntrada` — como cada variante es una fila nueva
  (no existe todavía), no hay contención posible entre las filas de
  una misma grilla. Sí hay que envolver **todo el alta** (crear las N
  variantes + sus N movimientos) en una única transacción, para que un
  error a mitad de camino no deje 7 variantes creadas y 3 sin crear.
- **Actualización masiva de precios (`apply`):** una transacción por
  todo el lote (todas las variantes filtradas se actualizan juntas o
  ninguna) — sin necesidad de bloqueo de filas por variante individual
  (nadie más debería estar editando el `precio_venta` de una variante
  concurrentemente con la frecuencia suficiente para que importe, y a
  diferencia del stock, no hay una condición de carrera que pueda
  dejar un invariante roto: el peor caso de una carrera acá es que un
  `PATCH /variants/:id` manual y un bulk-update se pisen, y gane el
  último en escribir — aceptable, ninguno de los dos deja un estado
  matemáticamente inconsistente).
- **SKU/barcode únicos:** la constraint de base (ya en el schema)
  es la defensa real contra la carrera de alta duplicada — el patrón
  ya usado en `auth` (T1.1: capturar `P2002` y traducir a 409) se
  repite acá tal cual.

## 6. Edge cases

- **Ajuste que llevaría el stock a negativo:** rechazado con 409 y
  mensaje explícito ("no podés ajustar a -3: quedan 5 unidades") — no
  hay bandera que lo permita (RN-5).
- **Grilla con 0 combinaciones seleccionadas** (ni un talle ni un
  color elegido): el producto igual permite UNA variante "sin talle ni
  color" (ej. una cartera) — el `UNIQUE NULLS NOT DISTINCT` de la fase
  01 ya lo cubre a nivel de base; el endpoint de grilla debe aceptar
  `sizeIds`/`colorIds` vacíos y generar esa única combinación.
- **SKU repetido al generar por patrón:** el patrón automático
  (sección 11) puede colisionar con un SKU ya editado a mano en otra
  variante — se resuelve igual que cualquier alta: 409 al violar la
  constraint única, la persona edita el SKU sugerido antes de
  confirmar (§12.2 punto 5: "editables").
- **Ingreso de mercadería con cantidad 0 o negativa:** rechazado en el
  DTO (`@IsPositive()` o similar) — un "ingreso" de 0 unidades no es
  un ingreso, y uno negativo es en realidad un ajuste (RN-5, otro
  endpoint, con `motivo`).
- **Búsqueda unificada con código de barras que no existe:** lista
  vacía, no 404 — es una búsqueda, no un lookup por id.
- **Actualización masiva con porcentaje que da un precio negativo**
  (ej. -150%): rechazada en el DTO — un porcentaje de baja no puede
  superar -100% (eso ya daría precio 0), y no tiene sentido permitir
  menos.
- **Actualización masiva sobre variantes inactivas:** se excluyen del
  filtro por defecto (no tiene sentido remarcar algo que no se vende),
  salvo que el filtro sea por selección manual explícita de ids — ahí
  se respeta la selección tal cual, es una decisión consciente de
  quien la hizo.
- **Dos ingresos de mercadería del mismo pedido enviados dos veces**
  (doble click): **riesgo aceptado, no protegido.** Decisión del PO
  (2026-08-23): no extender T0.14 (idempotencia) acá — hubiese exigido
  agregar `idempotency_key` a `stock_movements`, fuera de lo que pide
  el blueprint (§9.7 solo lista `sales`/`returns`/`cash_movements`/
  `expenses`). Un doble click duplica la cantidad ingresada y pisa
  `costo_actual` dos veces con el mismo valor — inofensivo para el
  costo (AD-6 ya asume "el último gana"), pero sí duplica el stock.
- **Variante dada de baja que recibe un ingreso de mercadería:** se
  permite (recibir stock de algo descatalogado que se va a liquidar no
  es un caso raro en indumentaria) — no se exige `activo = true` para
  `registrarEntrada`/`registrarAjuste`, solo para aparecer en el
  buscador de venta (RN-7, RN-11).

## 7. Errores

| Situación | Status | Mensaje al usuario |
|---|---|---|
| SKU o barcode duplicado | 409 | "Ya existe una variante con ese SKU/código de barras" |
| Ajuste dejaría stock negativo | 409 | "No podés ajustar a −N: quedan M unidades" |
| Motivo faltante en ajuste | 400 | "El ajuste de stock necesita un motivo" |
| Rol insuficiente (SELLER en endpoint OWNER-only) | 403 | "No tenés permiso para hacer esto" (mismo mensaje genérico que `RolesGuard` ya usa en `auth`) |
| Producto/variante inexistente | 404 | "Producto no encontrado" / "Variante no encontrada" |
| Porcentaje de actualización masiva inválido | 400 | "El porcentaje no puede dejar el precio en 0 o negativo" |
| `costoActual` en el body de un PATCH normal (SELLER) | 400 (whitelist del `ValidationPipe`, igual que en `auth`) | mensaje genérico de validación |

Todos pasan por el mismo `GlobalExceptionFilter` ya construido en
`auth`/fase 00 — nada nuevo que construir ahí.

## 8. Permisos

| Acción | `OWNER` | `SELLER` |
|---|---|---|
| Ver catálogo (productos, variantes, buscador) | ✅ | ✅ |
| Ver `precioVenta` | ✅ | ✅ |
| Ver `costoActual` / historial de costos | ✅ | ❌ (RN-3, literal) |
| Crear/editar producto (nombre, marca, categoría) | ✅ | ✅ — no está en la lista de exclusiones explícitas de §5.1 ("resultados, gestión de usuarios, costos de productos, cierre de caja"); cargar catálogo día a día es tarea típica de vendedor en un local chico |
| Crear/editar variante — `sku`, `barcode`, `activo` | ✅ | ✅ (mismo razonamiento) |
| Editar `precioVenta` manual (una variante) | ✅ | ❌ (AMB-11, **RESUELTA**: `OWNER`-only) |
| Editar `costoActual` | ✅ | ❌ (RN-3) |
| Ingreso de mercadería (`POST /stock/entradas`) | ✅ | ❌ (AMB-11, **RESUELTA**: `OWNER`-only) |
| Ajuste de stock (`POST /stock/ajustes`) | ✅ | ❌ (RN-5, literal: "permitido solo a OWNER") |
| Actualización masiva de precios | ✅ | ❌ (RN-9, literal: "Solo OWNER") |
| Alta por grilla | ✅ | ✅ para completar talle/color/SKU/stock; la columna de costo queda deshabilitada para `SELLER` (AMB-11, **RESUELTA**: `OWNER`-only) |
| Gestión de marcas/categorías/talles/colores | ✅ | ✅ (no excluido explícitamente) |

## 9. Tests necesarios

- **`stock.service.ts` — tests primero (§9.8, excepción plata/stock):**
  escritos y en rojo antes de implementar, derivados de RN-4, RN-5,
  invariante 1 e invariante 5. Incluye el caso de concurrencia de
  ajuste negativo (dos ajustes simultáneos que dejarían el stock
  negativo si no hubiera lock — mismo patrón de prueba que la fase 08
  de `auth` para el último OWNER activo, adaptado a stock).
- **Unitarios:** `stock.service` (Prisma mockeado), `products.service`,
  `variants.service`, `price-history` write helper, cálculo de
  actualización masiva (porcentaje → precio resultante, con las
  reglas de redondeo de §9.3 — **requiere T0.12**, ver sección 11).
- **Integración (Postgres real):**
  - Alta por grilla → confirma que se crearon N variantes y N
    `stock_movements` tipo `ENTRADA`, nunca `stock_actual` escrito
    directo.
  - Ingreso de mercadería → `costo_actual` actualizado + fila en
    `price_history` con `origen = INGRESO_MERCADERIA`.
  - Ajuste que dejaría stock negativo → 409, sin escribir nada.
  - Constraint única de SKU/barcode → 409 al duplicar.
  - `UNIQUE NULLS NOT DISTINCT` en (`product_id`, `size_id`,
    `color_id`) → no se puede cargar dos veces un artículo sin talle
    ni color.
  - Actualización masiva: preview no escribe nada; apply sí, y cada
    variante afectada tiene su fila nueva en `price_history` con
    `origen = MASIVO`.
  - `PATCH /variants/:id` con `costoActual` en el body → 400
    (whitelist), igual que el test de mass-assignment de `auth`.
  - `GET /variants/:id` con sesión `SELLER` → respuesta sin
    `costoActual`.
- **Test de reconciliación (T2.8, invariante 1):** recorre todas las
  variantes de una base de prueba con movimientos variados (entradas,
  ajustes) y verifica `stock_actual == SUM(delta)` para cada una — no
  alcanza con probarlo variante por variante en los tests de arriba,
  tiene que correr como chequeo agregado, igual que exige la sección 6
  del blueprint.
- **Mutación (Stryker):** obligatorio sobre `stock.service.ts`
  específicamente — es el nombre literal en la lista de BLUEPRINT
  §9.8 ("`sales`, `stock`, `cash-registers`, `returns`, `results`").
  **No** aplica al resto del módulo (catálogo CRUD, actualización
  masiva de precios) — no están en esa lista, aunque toquen dinero;
  se corre en la fase de QA adversarial (08), no acá.
- **E2E (Playwright):** cargar un producto nuevo con variantes por
  grilla, con costo, viendo el stock reflejado — es el flujo #2 de
  `MVP_SCOPE.md` §7. Se construye en la Fase 14, no en este módulo.

## 10. Ambigüedades

Dos preguntas nuevas para el PO, agregadas a `state/AMBIGUITIES.md`
como AMB-11 y AMB-12 (detalle completo ahí, resumen acá):

- **AMB-11 — RESUELTA.** ¿Un `SELLER` puede editar `precioVenta`
  manualmente, cargar el costo en la grilla, o hacer ingreso de
  mercadería? El PO aprobó la recomendación: las tres,
  `OWNER`-only — consistente con que el costo en general es su
  terreno exclusivo (§5.2). Aplicado en la sección 8 (matriz de
  permisos): `PATCH /variants/:id` con `precioVenta`,
  `POST /stock/entradas` y la columna de costo de la grilla
  (`POST /products/:id/variants/grid`) exigen `@Roles(OWNER)`.
- **AMB-12 (MEDIO):** carga inicial por CSV (`DECISIONES_PENDIENTES.md`
  C2) — el ticket ya está decidido ("es un ticket nuevo de la Etapa
  2, no un extra"), agregado acá como **T2.13** (ver sección 11). Lo
  que falta es el formato exacto de columnas, que depende de B4
  (`DECISIONES_PENDIENTES.md`, "¿con qué maneja hoy el catálogo y el
  stock?"), todavía **PENDIENTE** con la clienta.
  **Recomendación:** no bloquear T2.13 por B4 — definir un formato de
  columnas propio razonable (nombre, marca, categoría, talle, color,
  SKU, barcode, precio, costo, stock inicial) como plantilla que se le
  entrega a la clienta para completar, e importar reglas de validación
  con reporte de errores línea por línea (ya explícito en C2). Si B4
  revela que ya tiene una planilla con otro formato, se ajusta el
  mapeo de columnas del importador — es un cambio acotado, no una
  reapertura del ticket.

**AMB-11 resuelta no bloquea nada.** AMB-12 solo bloquea a T2.13
específicamente — el resto de T2.1–T2.12 nunca dependió de ella.

## 11. Tickets

### ⚠️ Hallazgo bloqueante: dependencias reales de T2.x no reflejadas en `ROADMAP.md`

La tabla de `ROADMAP.md` lista la dependencia de T2.1 como solo
"T1.3". Eso es correcto para T2.1 (listas de talles/colores no tocan
dinero), pero **T2.3 en adelante manejan `Decimal`**
(`precio_venta`, `costo_actual`) y necesitan los **helpers de
`Decimal` y redondeo comercial de T0.12** (BLUEPRINT §9.3, CLAUDE.md
regla 5 — "los importes se operan con Decimal, nunca con number").
**T0.12 sigue `PENDIENTE`** en `state/ROADMAP.md` — no está construido
todavía. Sin él, T2.9 (price_history) y sobre todo T2.10
(actualización masiva, que calcula `precio × (1 ± pct%)` y tiene que
redondear exactamente según §9.3) no tienen dónde apoyarse sin
duplicar reglas de redondeo a mano — exactamente lo que T0.12 existe
para evitar.

De la misma forma, **T0.11** (helpers de formato es-AR, §12.3) hace
falta para las pantallas de este módulo (T2.12) — precios, la vista
previa de actualización masiva — por CLAUDE.md regla 9 ("prohibido
formatear moneda o fecha a mano en un componente").

**No corresponde que yo decida esto por mi cuenta** (no es una
ambigüedad de negocio, es una dependencia técnica real que faltaba en
el roadmap) — lo dejo explícito acá y ajusto la tabla de `ROADMAP.md`
en consecuencia. **Recomiendo ejecutar T0.12 antes de T2.3, y T0.11
antes de T2.12**, en vez de reordenar toda la Etapa 2 detrás de
Etapa 0 — T2.1 y T2.2 (listas y productos, sin dinero) pueden arrancar
ya.

**T0.14 (interceptor de idempotencia) también sigue `PENDIENTE`.**
La nota original de `ROADMAP.md` que lo agregó no lista ningún ticket
de la Etapa 2 entre los que lo necesitan (menciona T3.3, T4.5, T5.1,
T6.2) — pero la recomendación de la sección 6 (doble ingreso de
mercadería por doble click) sugeriría que **T2.5 también debería
usarlo**. Lo marco como ambigüedad técnica menor, no de negocio: si se
aprueba, T2.5 pasa a depender de T0.14 también. Recomiendo aprobarlo
— el motivo de AD-10 ("doble click en el mostrador") aplica igual acá,
y es más barato agregar una dependencia a un ticket que todavía no
arrancó que descubrirlo después con datos reales duplicados.

### Ajustes a `state/ROADMAP.md`

- T2.3, T2.5, T2.9, T2.10, T2.11: agregar **T0.12** a "Depende de".
- T2.5: agregar **T0.14** a "Depende de" (pendiente de la aprobación
  de arriba).
- T2.12: agregar **T0.11** a "Depende de".
- **T2.13 (nuevo)** — Importación de catálogo por CSV: productos,
  variantes, stock inicial y costos, con validación y reporte de
  errores línea por línea (`DECISIONES_PENDIENTES.md` C2). Depende de
  T2.4 (usa `stock.service` para el stock inicial, igual que la
  grilla) y T2.9. Ver AMB-12.

El resto de T2.1–T2.12 se **confirma tal cual** están en
`state/ROADMAP.md` — ninguno necesitó ajuste de alcance, solo de
dependencias.

---

**Estado (actualizado 2026-08-23):** T2.1, T2.2, T2.3, T2.4, T2.6,
T2.7, T0.12 y T0.14 en VERDE. AMB-11 RESUELTA (`OWNER`-only). **T2.5
desbloqueado** — el PO decidió explícitamente no extender T0.14 acá
(hubiese exigido migrar `stock_movements`, fuera de lo que pide el
blueprint); ver sección 6, edge case de doble click, y `ROADMAP.md`.
Sigue pendiente: AMB-12 (solo bloquea a T2.13) y ejecutar T0.11 antes
de T2.12.
