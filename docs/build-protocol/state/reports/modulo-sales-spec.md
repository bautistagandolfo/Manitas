# Spec del módulo `sales` (2026-08-24)

Fase 06 del protocolo, Etapa 4 de `state/ROADMAP.md` (T4.1–T4.11). **El
módulo más crítico del sistema** (ROADMAP.md, literal). Dependencias
declaradas — `stock` (T2.4), `cash-registers` (T3.2), `settings`
(T0.13) — las tres VERDE. Fuentes: `BLUEPRINT.md` AD-3/5/6/8/9/10/14/18/19,
§3.4, §5.1, §5.3, invariantes 3/4/5/6/7/9/10/12/13/15, §7, §9.3, §9.4,
§9.6, §9.7, §9.8, §12.1, §12.4, §12.6; `MVP_SCOPE.md` §3.3 (riesgo
ALTO); `state/AMBIGUITIES.md` AMB-3/AMB-4/AMB-9 (ya resueltas);
`backend/prisma/schema.prisma` (modelos `Sale`/`SaleItem`/
`SaleDiscount`/`Payment`, ya en la base desde la fase 01);
`docs/build-protocol/state/reports/modulo-products-variants-spec.md`
y `modulo-cash-registers-spec.md` (los dos módulos con los que `sales`
integra).

---

## 1. Responsabilidad

Este módulo es dueño de:

- La **venta** (`sales`): N ítems, N descuentos, N pagos (AD-3), en
  una única operación transaccional (§5.3).
- El **congelado** de precio y costo en cada línea al momento de
  vender (AD-5) — `sale_items` nunca referencia el precio/costo
  *actual* de la variante.
- El **prorrateo** de descuento y ajuste de redondeo a las líneas
  (AD-18) — `neto_linea` es el valor autoritativo de cuánto se cobró
  de verdad por esa línea.
- El **límite de descuento del vendedor** y su autorización por
  `OWNER` (AMB-3, `max_descuento_vendedor_pct`).
- La **anulación** de una venta completa (revierte stock y caja con
  movimientos nuevos, nunca borra ni edita los originales).
- Idempotencia de la creación de venta (AD-10, §9.7).

**Qué NO hace este módulo:**

- No descuenta `stock_actual` directamente — llama a la API interna
  de `stock.service.ts` (sección 4.2 de
  `modulo-products-variants-spec.md`, y el hallazgo de la sección 4.2
  de acá abajo). CLAUDE.md regla 4: solo `stock.service.ts` escribe
  movimientos de stock.
- No inserta `cash_movements` directamente — llama a la API interna
  de `cash-register.service.ts` (`registrarMovimiento`, ya expuesta y
  VERDE desde T3.2/T3.4).
- No hace devoluciones ni cambios — eso es `returns` (Etapa 5), que
  referencia `sales`/`sale_items` pero vive en su propio módulo. La
  única superficie que `sales` expone hacia `returns` es de solo
  lectura (existencia de la venta, sus líneas, si está `ANULADA`) — no
  hay una API interna de escritura que `returns` necesite de acá.
- No calcula resultados, márgenes ni CMV agregado por período — eso es
  `resultados` (Etapa 6). Este módulo solo congela el costo por línea;
  agregarlo es responsabilidad de otro módulo.
- No emite comprobantes fiscales (AD-11, fuera de alcance de todo el
  sistema) ni imprime tickets (AMB-9, diferida).
- No decide si `permitir_venta_sin_stock` está activo — lo *lee* de
  `SettingsService` (T0.13) y lo aplica, la decisión de negocio ya
  está tomada (AMB-4, RESUELTA).

## 2. Reglas de negocio

Numeradas para referenciarlas desde tickets y tests.

**RN-1. Flujo transaccional (§5.3), en este orden, todo dentro de una
sola transacción Prisma:**

1. Validar sesión de caja `ABIERTA` (early-exit no autoritativo — ver
   sección 5 para el detalle de por qué no alcanza sola).
2. Validar stock suficiente de cada variante (agregado por variante,
   no por línea — ver sección 5, RN-7 de acá abajo).
3. Crear `sales` + `sale_items`, copiando `precio_unitario`/
   `costo_unitario` actuales de cada variante (AD-5).
4. Registrar `sale_discounts` si corresponde (RN-4).
5. Registrar `payments` — `SUM(payments.monto) == sales.total`
   (invariante 3), validado antes de escribir, no después.
6. Descontar stock: `stock.service.descontarPorVenta` por línea
   (`tipo = VENTA`, `referenciaTipo = SALE`, `referenciaId = sale.id`).
7. Si algún `payment.metodo == EFECTIVO`, `cash-register.service.
   registrarMovimiento` por la **suma de esos pagos en efectivo**
   (puede haber varios pagos en efectivo — se suman en un solo
   movimiento, no uno por pago; el blueprint dice "un cash_movements
   por ese importe", singular).

**RN-2. No se vende sin catalogar (AD-8/A8).** Toda línea referencia
una `variant_id` existente. No existe "venta libre" con precio a mano.

**RN-3. Stock insuficiente bloquea, salvo configuración (AMB-4,
RESUELTA).** `permitir_venta_sin_stock` (default `false`, T0.13) leído
de `SettingsService` al validar el paso 2. Si está en `true`, la venta
se permite igual y el stock puede quedar negativo (mismo criterio que
`stock.service.registrarAjuste` — RN-5 de esa spec — pero acá la
excepción SÍ aplica, a diferencia de un ajuste manual).

**RN-4. Descuentos (AD-3, AD-18, AMB-3 RESUELTA).**

- El tope del `SELLER` se evalúa sobre el **total**
  (`descuento_total / subtotal`), nunca sumando cada `sale_discounts`
  por separado — dos descuentos del 8% no deben poder pasar un tope
  del 10%.
- `max_descuento_vendedor_pct` (default 10, `SettingsService`).
- Por encima del tope, requiere autorización de un `OWNER`, registrada
  en `sale_discounts.autorizado_por_user_id`. **El mecanismo exacto de
  esa autorización en el momento de la venta (una vendedora en el
  mostrador, sin sesión de `OWNER` activa) no está definido por el
  blueprint — ver AMB-14 en la sección 10, no lo resuelvo acá.**
- Tope duro: `0 ≤ descuento_total ≤ subtotal` (invariante 4). Sin
  `CHECK` de base todavía — ver hallazgo de la sección 3.

**RN-5. Prorrateo a las líneas (AD-18), algoritmo exacto (§9.3 regla
5, ya implementado en `common/money/money.util.ts::prorate` desde
T0.12 — este módulo lo reusa, no lo reimplementa):**

`neto_linea = round(subtotal_linea × total / subtotal)`, residuo a la
línea de mayor `neto_linea` (empate → menor `id`). `neto_unitario =
neto_linea / cantidad`, informativo, puede no ser exacto.

**RN-6. Ajuste de redondeo (AD-14).** Lo ingresa quien cobra, nunca lo
calcula el sistema solo. `|ajuste_redondeo| < 1`. `total = subtotal −
descuento_total + ajuste_redondeo`.

**RN-7. Validación y bloqueo de stock por variante, no por línea.**
Una venta puede tener dos líneas de la misma `variant_id` (dos
escaneos separados que el vendedor no fusionó, o dos líneas
intencionales). La cantidad a validar/descontar por variante es la
**suma de todas las líneas de esa variante en la venta**, no cada
línea evaluada de forma independiente — dos líneas de 3 unidades cada
una sobre una variante con 5 en stock deben rechazarse juntas (piden
6), aunque cada una por separado "pasaría" un chequeo de `3 ≤ 5`. Ver
sección 5 para el detalle de locking.

**RN-8. Anulación (§5.3, AD-19).**

- Solo `OWNER`.
- Solo dentro de la **misma sesión de caja** en la que se hizo la
  venta (`sale.cashRegisterSessionId === sesión ABIERTA actual`).
  Después de cerrada esa caja, se resuelve por devolución (`returns`,
  fuera de este módulo).
- Solo si la venta **no tiene ninguna devolución** (AD-19, invariante
  13) — chequeo de existencia contra la tabla `returns` (ver sección
  4.2, no requiere que el módulo `returns` esté construido).
- No borra ni edita `sale_items`/`payments`/`stock_movements`/
  `cash_movements` originales — crea movimientos nuevos de tipo
  `ANULACION` en stock y en caja, y cambia `sales.estado` a `ANULADA`.
- El movimiento de caja de la anulación es **solo por lo que se cobró
  en `EFECTIVO`** — anular una venta 100% tarjeta no saca nada del
  cajón, porque nunca entró.
- No se anula una venta con algún `payment.metodo ==
  CREDITO_DEVOLUCION` (invariante 15) — ese caso se corrige con una
  devolución de la venta nueva, en `returns`.

**RN-9. Idempotencia obligatoria (AD-10, §9.7).** Mismo mecanismo que
T3.3 de `cash-registers`: header `Idempotency-Key`, interceptor común
de T0.14, `withIdempotency` envolviendo la transacción completa. Dos
envíos con la misma clave devuelven la venta original, nunca duplican.

**RN-10. Ocultamiento de costo para `SELLER` (§5.1, "SELLER no accede
a... costos de productos").** `sale_items.costo_unitario` se omite por
completo (no `null`) en cualquier respuesta que vea un `SELLER` — GET
de listado, GET de detalle, y la respuesta del propio `POST /sales`
que acaba de crear. Mismo patrón que `costoActual` en `variants`
(`VariantForRole`/`hideOwnerOnlyFields`) y `montoSistema`/`diferencia`
en `cash-registers`.

## 3. Invariantes

De la sección 6 del blueprint, los que este módulo garantiza
directamente:

- **Invariante 3** — `SUM(payments.monto) == sales.total`. Se valida
  ANTES de escribir (paso 5 de RN-1), no se confía en un `CHECK` de
  base porque es una suma entre dos tablas distintas (Postgres no
  puede expresar eso en un `CHECK` de una sola tabla sin un trigger).
- **Invariante 4** — `total == subtotal − descuento_total +
  ajuste_redondeo`, con `|ajuste_redondeo| < 1`, `0 ≤ descuento_total
  ≤ subtotal` y `total ≥ 0`. **Hallazgo real: la última cláusula
  (`total ≥ 0`) no se sigue automáticamente de las otras tres.**
  Ejemplo: `subtotal = $0.50`, `descuento_total = $0.50` (cumple `0 ≤
  descuento_total ≤ subtotal`), `ajuste_redondeo = -$0.90` (cumple
  `|ajuste_redondeo| < 1`) → `total = -$0.90`. El servicio tiene que
  validar `total ≥ 0` de forma explícita, independiente de las otras
  tres validaciones — no alcanza con validar cada regla por separado y
  asumir que la combinación es segura. Sin `CHECK` de base para esto
  todavía (recomendado agregar `sales_total_check CHECK (total >= 0)`
  y `sales_descuento_total_check CHECK (descuento_total >= 0 AND
  descuento_total <= subtotal)` como defensa en profundidad, mismo
  criterio que el `CHECK` de signo de `cash_movements` — asignado a
  T4.6, que es donde `total` queda definitivo).
- **Invariante 5** (la mitad que le toca) — `stock_actual >= 0` salvo
  `permitir_venta_sin_stock`. Lo garantiza `stock.service.ts`
  (ya VERDE), este módulo solo decide si pasa la bandera.
- **Invariante 6** (la mitad que le toca) — todo `stock_movements` de
  `tipo = VENTA` o `ANULACION` tiene `referencia` (no `motivo`). Lo
  garantiza `stock.service.ts` si expone el método correcto — ver el
  hallazgo de la sección 4.2, hoy no lo hace.
- **Invariante 7** — de los `payments` de una venta, solo los
  `EFECTIVO` generan `cash_movements`. Este módulo decide qué pagos
  filtra antes de llamar a `cash-register.service.registrarMovimiento`
  — ese servicio no tiene visibilidad de `payments.metodo` (RN-9 de su
  propia spec).
- **Invariante 9** (indirecta) — depende de que `cash-register.service`
  siga garantizando una sola sesión `ABIERTA` (ya VERDE).
- **Invariante 10** (la mitad que le toca) — ninguna venta se registra
  sin sesión de caja abierta. **Hallazgo real de concurrencia: ver
  sección 5** — el chequeo autoritativo (con lock) solo ocurre hoy si
  hay algún pago en efectivo (porque es `registrarMovimiento` quien
  toma el lock de la sesión). Una venta 100% tarjeta no pasa por ese
  lock. Diseño recomendado en la sección 5.
- **Invariante 12** — `subtotal == SUM(sale_items.subtotal)`,
  `descuento_total == SUM(sale_discounts.monto)`,
  `SUM(sale_items.neto_linea) == total`. Se garantiza por construcción
  (el servicio arma esas sumas él mismo, nunca las recibe del
  cliente) — igual necesita un test explícito por ser un invariante
  numerado.
- **Invariante 13** — ninguna venta `ANULADA` tiene devoluciones por
  `sale_id` (AD-19). Este módulo lo garantiza del lado de la
  anulación (RN-8); el lado de `returns` (rechazar una devolución
  contra una venta `ANULADA`) es responsabilidad de ese módulo.
- **Invariante 15** — ninguna venta con un pago `CREDITO_DEVOLUCION`
  puede quedar `ANULADA`. Este módulo lo garantiza en `anular()`
  (RN-8), consultando `payments.metodo` de la propia venta — no
  depende de `returns`.

Los que **no** garantiza este módulo pero interactúan con él:

- **Invariante 1** (stock) — lo garantiza `stock.service.ts`.
- **Invariante 2** (arqueo) — lo garantiza `cash-register.service.ts`.
- **Invariante 14** (tope de `CREDITO_DEVOLUCION`) — es de `returns`;
  `sales` solo acepta el `payment` que `returns` le manda al crear la
  venta del cambio (§5.4, secuencia del `CAMBIO`), sin volver a
  validar el tope — confiando en que `returns` ya lo hizo, mismo
  principio que en otros contratos internos de este sistema (quien
  escribe primero valida, quien recibe confía en la forma).

## 4. Contratos de API

### 4.1 Endpoints REST

Prefijo `/sales`. Todos requieren sesión (`AuthGuard` global); rol
exigido por endpoint en la sección 8.

| Método | Ruta | Rol | Body | Notas |
|---|---|---|---|---|
| POST | `/sales` | cualquiera autenticado (es el trabajo del vendedor) | `{ items: [{variantId, cantidad}], discounts?: [{descripcion, porcentaje?, monto, autorizacionOwner?}], payments: [{metodo, monto, referencia?}], ajusteRedondeo?: string }` + header `Idempotency-Key` | 201 con la venta creada. `autorizacionOwner` — forma exacta sin definir, ver AMB-14. 409 sin sesión abierta; 409 stock insuficiente (mensaje con cuánto hay); 400 si `SUM(payments) != total` o descuento fuera de tope sin autorización |
| GET | `/sales` | cualquiera autenticado | — | paginado (§12.4), orden por fecha descendente, filtros `numero`/`fecha`/`estado`. `SELLER`: `costo_unitario` omitido en cada línea |
| GET | `/sales/:id` | cualquiera autenticado | — | detalle completo. Mismo ocultamiento de costo para `SELLER` |
| POST | `/sales/:id/anular` | `OWNER` | `{}` | 200 con la venta `ANULADA`. 403 si no es la sesión de caja actual (RN-8); 409 si ya está `ANULADA` o tiene devoluciones; 404 si no existe |

**Fuera de alcance de este módulo, a propósito:** un buscador
unificado de ventas por texto (nombre de cliente, etc.) no aplica —
AD-17 confirma que no hay clientes en el MVP. La búsqueda de productos
para armar el carrito es de `products`/`variants` (`GET
/variants/search`, ya VERDE desde T2.7) — `sales` no reimplementa ese
buscador, la pantalla de venta (T4.10) lo consume directo.

### 4.2 Hallazgo técnico bloqueante: `stock.service.ts` no expone lo que `sales` necesita

**La propia spec de `products`/`variants` (fase 06, sección 4.2)
propuso tres métodos reservados exactamente para este momento:**

```ts
descontarPorVenta(tx, { variantId, cantidad, saleId, userId }): Promise<void>
revertirPorDevolucion(tx, { variantId, cantidad, returnId, userId }): Promise<void>
revertirPorAnulacion(tx, { variantId, cantidad, saleId, userId }): Promise<void>
```

**Ninguno de los tres existe en el `StockService` real** (confirmado
leyendo `backend/src/modules/stock/stock.service.ts` completo: solo
`registrarEntrada` y `registrarAjuste`). Ni `registrarEntrada` (tipo
equivocado, sin validación de stock) ni `registrarAjuste` (tipo
`AJUSTE` con `motivo` obligatorio, no `referencia`; sin la excepción
de `permitir_venta_sin_stock`, que es explícitamente de `sales`, no de
un ajuste manual — su propia spec lo dice) sirven para esto. Es un gap
real de construcción — la fase 07 de `products`/`stock` no lo
detectó (sí detectó el `GET /variants/:id/stock-movements` faltante,
pero no este).

**No es una ambigüedad de negocio — es una dependencia técnica real,
igual que el trigger de RN-8 que la spec de `cash-registers` asignó
directamente a T3.2.** Corresponde agregar a `stock.service.ts`
(archivo del módulo `products`/`stock`, ya cerrado, pero extenderlo
con métodos que su propia spec ya reservó no es un cambio de alcance
nuevo):

```ts
descontarPorVenta(tx, {
  variantId, cantidad, saleId, userId, permitirStockNegativo,
}): Promise<void>
```

- `tipo = VENTA`, `referenciaTipo = SALE`, `referenciaId = saleId`
  (nunca `motivo`).
- **No toma su propio lock.** El lock de todas las variantes
  involucradas en la venta (ordenadas por `id`, BLUEPRINT §9.4) lo
  toma **`sales.service.ts`**, una sola vez, con todas las variantes
  de la venta juntas, ANTES de llamar a este método por cada línea —
  ver sección 5. Si `descontarPorVenta` tomara su propio lock por
  variante, no se podría garantizar el orden global que evita
  deadlocks entre dos ventas concurrentes con variantes en común.
- `permitirStockNegativo: boolean` — lo decide `sales.service`
  (leyendo `permitir_venta_sin_stock` de `SettingsService`), este
  método solo lo aplica mecánicamente: si es `false` y el resultado
  quedaría negativo, lanza `ConflictException` con cuánto hay
  disponible; si es `true`, escribe igual.

```ts
revertirPorAnulacion(tx, { variantId, cantidad, saleId, userId }): Promise<void>
```

- `tipo = ANULACION`, `delta` positivo (revierte el descuento
  original), `referenciaTipo = SALE`, `referenciaId = saleId`.
- Incremento atómico, mismo criterio que `registrarEntrada` — revertir
  siempre suma, nunca necesita validar contra un umbral.

`revertirPorDevolucion` **no lo construye este ticket** — es de
`returns` (Etapa 5), queda reservado en la spec de `products` para
cuando le toque a ese módulo, sin tocarlo acá.

**Asignación:** `descontarPorVenta` es requisito de **T4.1** (sin él,
el paso 6 de RN-1 es imposible). `revertirPorAnulacion` es requisito
de **T4.7**. Ambos tickets agregan una migración/código a
`stock.service.ts`, fuera de la carpeta `sales/` — está bien, es
exactamente lo que la propia spec de `products` anticipó ("Firma
propuesta... el contrato básico queda fijado acá para no romper esta
fase cuando lleguen").

### 4.3 API interna que este módulo consume (ya lista, sin hallazgos)

- `cash-register.service.getSesionAbiertaOrThrow(tx)` — VERDE desde
  T3.2. Devuelve la sesión o lanza 409.
- `cash-register.service.registrarMovimiento(tx, { sessionId, tipo:
  'VENTA' | 'ANULACION', monto, referenciaTipo: 'SALE', referenciaId,
  descripcion, userId })` — VERDE desde T3.2/T3.4. `CashMovementTipo`
  y `CashMovementReferenciaTipo.SALE` ya existen en el schema desde la
  fase 01 — confirmado, sin gap acá (a diferencia de `stock.service`).

## 5. Transacciones y concurrencia

El punto más delicado del sistema (BLUEPRINT §7, literal).

- **Lock de variantes, patrón exacto de §9.4:** `sales.service.ts`
  arma el `Set` de `variantId` únicos de todas las líneas de la venta,
  ordenado por `id`, y toma **un solo** `SELECT ... FOR UPDATE ORDER
  BY id` sobre esas filas al principio de la transacción — antes de
  leer stock, antes de crear nada. Recién con el lock tomado, valida
  cantidad-necesaria-por-variante (RN-7: sumando todas las líneas de
  esa variante) contra el stock real, y solo entonces llama a
  `stock.service.descontarPorVenta` una vez por línea (esas llamadas
  ya no necesitan re-lockear, la fila sigue bloqueada dentro de la
  misma transacción).
- **Hallazgo real: el lock de la sesión de caja no cubre todas las
  ventas.** El chequeo de "hay sesión abierta" del paso 1 de RN-1
  (`getSesionAbiertaOrThrow`) **no toma lock** — es una lectura
  simple, pensada como fail-fast. El único punto que SÍ toma el lock
  de la fila de sesión es `cash-register.service.registrarMovimiento`
  (paso 7), y ese paso **no se ejecuta si ningún pago es efectivo**.
  Para una venta 100% tarjeta, eso deja una ventana real (aunque
  angosta) entre el paso 1 y el commit final donde la sesión podría
  cerrarse sin que la venta lo note — la venta terminaría
  registrándose contra una sesión que, al momento del commit, ya no
  está `ABIERTA`. **Recomendación, no ambigüedad (decisión técnica):**
  `sales.service` toma el mismo `SELECT id FROM cash_register_sessions
  WHERE id = $1 FOR UPDATE` que usa `cash-register.service`
  internamente, **siempre**, en el paso 1 — independientemente de si
  el paso 7 vuelve a tomarlo más tarde (tomar el mismo lock dos veces
  dentro de la misma transacción de Postgres no es un problema, es
  redundante pero inofensivo). Esto cierra la ventana para toda venta,
  tenga o no pago en efectivo.
- **Números de venta:** `sales.numero` ya es `@unique
  @default(autoincrement())` en el schema (fase 01) — es una secuencia
  real de Postgres, no `MAX(numero) + 1`. Sin trabajo pendiente acá.
- **Idempotencia:** índice único sobre `idempotency_key` ya en el
  schema (fase 01). Mismo patrón `withIdempotency` que T3.3.
- **Orden de locks entre módulos:** dentro de la transacción de una
  venta, el orden es variantes (stock) → ... → sesión de caja (caja),
  igual que lo describe §5.3 (validar caja → validar stock → crear
  venta → pagos → descontar stock → caja) salvo por el lock temprano
  de caja recién señalado, que se toma al principio pero no se
  **usa** (más allá de confirmar `ABIERTA`) hasta el final. No hay
  inversión de orden entre dos ventas concurrentes: las dos toman
  variantes primero, caja después, siempre en ese sentido — sin riesgo
  de deadlock cruzado con ellas mismas. Sí existe el riesgo ya
  documentado en la spec de `cash-registers` (sección 5) entre una
  venta y un cierre de caja concurrente — sigue vigente y ya está
  resuelto del lado de `cash-register.service`.

## 6. Edge cases

- **Cantidad en cero o negativa:** rechazada — `sale_items_cantidad_check
  CHECK (cantidad > 0)` ya en la base (fase 01) más validación de DTO
  para un 400 limpio en vez del `CHECK` crudo (mismo criterio que el
  resto del sistema).
- **Stock justo (exactamente lo pedido):** la venta pasa, el stock
  queda en 0. Camino feliz, no una excepción.
- **Dos líneas de la misma variante en una venta:** ver RN-7 — se
  agregan antes de validar/descontar, nunca se validan por separado.
- **`permitir_venta_sin_stock = true` con stock ya negativo:**
  permitido, sin tope adicional — mismo criterio que "sin tope" ya
  aceptado para retiros de caja (spec de `cash-registers`, sección 6):
  el blueprint no define ningún piso más allá de la bandera misma.
- **Descuento igual al 100% del subtotal:** válido (`0 ≤
  descuento_total ≤ subtotal` con igualdad permitida) — `total` queda
  en `ajuste_redondeo`, que puede ser 0. Si el vendedor no tiene
  autorización para ese porcentaje, se rechaza por RN-4 antes de
  llegar acá.
- **`ajuste_redondeo` que deja `total` negativo:** rechazado
  explícitamente — ver el hallazgo de la sección 3 (invariante 4).
- **Refresco de página a mitad de una venta:** resuelto del lado de
  T4.10 (frontend) — el borrador y su `Idempotency-Key` sobreviven en
  `sessionStorage` (§12.1, mismo patrón que
  `lib/idempotency.ts` de T3.7, ya construido y reusable tal cual).
- **Doble click en confirmar venta:** idempotencia (RN-9) + botón
  deshabilitado al apretarlo (§12.1, defensa en dos capas, mismo
  patrón que el resto del sistema).
- **Código escaneado sin coincidencia:** no es un caso de este módulo
  — es de la pantalla (T4.10) contra `GET /variants/search` (ya
  VERDE). `sales` ve recién el `variantId` que el frontend ya
  resolvió.
- **Anular una venta con una devolución ya registrada:** rechazada
  (RN-8, AD-19) — chequeo de existencia contra `returns` por
  `sale_id`, sin necesitar que el módulo `returns` esté construido
  (la tabla ya existe desde la fase 01, es una lectura, no una regla
  de negocio de ese módulo).
- **Anular una venta pagada con `CREDITO_DEVOLUCION`:** rechazada
  (invariante 15) — no aplica todavía en la práctica (nada genera ese
  método de pago hasta que `returns`/`CAMBIO` exista), pero el
  chequeo se construye igual desde el principio, no se agrega después
  como parche.
- **Anular una venta después de cerrada su sesión de caja:**
  rechazada (RN-8) — mensaje claro de que corresponde una devolución
  en cambio.
- **`SELLER` intentando anular:** 403, `RolesGuard`.

## 7. Errores

| Situación | Status | Mensaje al usuario |
|---|---|---|
| Sin sesión de caja abierta | 409 | "No hay una sesión de caja abierta" (mismo texto que `cash-registers`) |
| Stock insuficiente (una o más variantes) | 409 | Identifica la variante y cuánto hay disponible |
| `SUM(payments) != total` | 400 | "Los pagos no cubren el total de la venta" (o la exceden — mismo mensaje, la suma tiene que ser exacta) |
| Descuento fuera del tope del vendedor, sin autorización | 400 | Indica el tope vigente y que necesita autorización de un `OWNER` |
| `descuento_total > subtotal` | 400 | "El descuento no puede superar el subtotal" |
| `total` resultante negativo | 400 | "El ajuste de redondeo deja el total en negativo" |
| `variantId` inexistente o inactivo | 400 | Identifica la línea/SKU |
| Anular venta inexistente | 404 | "Venta no encontrada" |
| Anular venta ya `ANULADA` | 409 | "Esta venta ya está anulada" |
| Anular venta con devoluciones | 409 | "Esta venta tiene devoluciones registradas, no se puede anular" |
| Anular venta pagada con crédito de devolución | 409 | Mensaje específico, RN-8 |
| Anular fuera de la sesión de caja actual | 409 | "Solo se puede anular dentro del mismo turno de caja" |
| Rol insuficiente (anular siendo `SELLER`) | 403 | Genérico de `RolesGuard` |

Todos pasan por el `GlobalExceptionFilter` ya construido — nada nuevo
que agregar ahí.

## 8. Permisos

| Acción | `OWNER` | `SELLER` |
|---|---|---|
| Crear venta | ✅ | ✅ (es su trabajo) |
| Ver listado/detalle de ventas | ✅ | ✅ — sin `costo_unitario` (RN-10) |
| Aplicar descuento dentro del tope | ✅ | ✅ |
| Aplicar descuento por encima del tope | ✅ (se autoriza a sí mismo, trivialmente) | Necesita autorización (mecanismo sin definir, AMB-14) |
| Anular venta | ✅ | ❌ |
| Ver ventas hechas por otro vendedor | ✅ | ✅ — sin restricción de "mis ventas" (el blueprint no define ese límite en ningún lado, mismo criterio que RN-2 de `cash-registers`: visibilidad operativa compartida) |

## 9. Tests necesarios

- **`sales.service.ts` — tests primero (§9.8, excepción plata/stock/
  caja).** Escritos y en rojo antes de implementar, derivados de RN-1
  a RN-10 e invariantes 3/4/5/6/7/9/10/12/13/15. Incluye el caso de
  concurrencia de la sección 5 (dos ventas simultáneas de la última
  unidad — es también T4.9 explícito en el roadmap) y el caso del
  lock temprano de sesión de caja para ventas sin efectivo.
- **Unitarios:** `applyPercentage`/`prorate` aplicados al flujo
  completo de una venta (reusa `common/money/money.util.ts`, T0.12);
  decisión de exigir autorización según tope; agregación de cantidad
  por variante (RN-7) antes de validar stock; filtrado de pagos
  `EFECTIVO` antes de llamar a `cash-register.service`; ocultamiento
  de `costo_unitario` para `SELLER`.
- **Los dos tests obligatorios de §9.3, literales:** 15% de descuento
  sobre $2.999 con cobro de $2.549 (verificando además que
  `SUM(neto_linea) == total`); una venta de tres líneas con descuento
  donde el prorrateo deje residuo.
- **Integración (Postgres real):**
  - Venta completa camino feliz: items + descuento + pago mixto
    (efectivo + tarjeta) → verifica `sale_items`, `sale_discounts`,
    `payments`, `stock_movements` (tipo `VENTA`, referencia correcta),
    `cash_movements` (solo por la parte en efectivo) — los cinco en
    una sola corrida.
  - Venta 100% tarjeta → sin `cash_movements` generado (invariante 7).
  - Stock insuficiente → 409, nada escrito (ninguna de las 5 tablas).
  - `SUM(payments) != total` → 400, nada escrito.
  - Descuento sobre el tope sin autorización → 400.
  - Doble click (`Idempotency-Key` repetida) → una sola venta.
  - Sin sesión de caja abierta → 409.
  - Anulación: camino feliz (venta con efectivo, revierte stock y
    caja); anulación de venta 100% tarjeta (revierte stock, sin
    movimiento de caja); anulación rechazada con devolución existente
    (insertada directo por Prisma contra la tabla `returns`, sin
    necesitar el módulo `returns`); anulación fuera de la sesión
    actual; `SELLER`→403.
  - **Concurrencia explícita (T4.9):** dos ventas simultáneas
    pidiendo la última unidad de la misma variante — una gana, la
    otra recibe 409 de stock insuficiente, nunca las dos pasan.
  - **Concurrencia del lock temprano de caja:** una venta sin pagos en
    efectivo y un cierre de caja disparados a la vez — la venta debe
    ver la sesión bloqueada por el cierre (o viceversa), nunca
    completarse contra una sesión que ya terminó `CERRADA`.
- **Test de invariantes dedicado (T4.8):** invariantes 3, 4, 5 y 7
  explícitos en el roadmap — agregar acá también un test dedicado de
  12 (sumas) y 13/15 (exclusión con anulación), aunque no estén en la
  lista original de T4.8, porque son invariantes que este módulo sí
  garantiza (ver sección 3).
- **Mutación (Stryker):** obligatorio sobre `sales.service.ts` —
  nombre literal en BLUEPRINT §9.8. Se corre en la fase de QA
  adversarial (08), no acá.
- **E2E (Playwright):** el flujo #3 completo de `MVP_SCOPE.md` §7
  ("vender, cobrar y cerrar caja"). Fase 14, no este módulo.

## 10. Ambigüedades

Una pregunta nueva para el PO, agregada a `state/AMBIGUITIES.md` como
AMB-14 (detalle completo ahí, resumen acá):

- **AMB-14 (⚠️ ALTO RIESGO, PENDIENTE).** El blueprint confirma el
  **número** del tope de descuento del vendedor (10%, AMB-3) pero no
  el **mecanismo** por el cual un `OWNER` autoriza, en el momento de
  la venta, un descuento que lo supera — la vendedora que está
  cobrando no tiene una sesión de `OWNER` activa. **Recomendación:**
  un campo de contraseña del `OWNER` en el propio formulario de
  descuento (patrón "autorización de supervisor" estándar de POS
  retail), verificado por el backend contra las credenciales reales
  de un usuario `OWNER` sin cambiar la sesión activa de quien está
  logueada — nunca aceptar un `autorizadoPorUserId` crudo del body sin
  verificar nada, porque cualquier `SELLER` podría mandar el id de un
  `OWNER` real y auto-autorizarse. **Bloquea a T4.3.**

Las tres ambigüedades que ya tocaban a este módulo desde la fase 03
(AMB-3, tope de descuento; AMB-4, venta sin stock; AMB-9, ticket
impreso) llegan **RESUELTAS** — no generan trabajo pendiente acá, ya
incorporadas en las reglas de negocio de la sección 2.

## 11. Tickets

### Hallazgo técnico bloqueante: `stock.service.ts` incompleto

Ver sección 4.2 completa. `descontarPorVenta` es requisito de **T4.1**
antes de que ese ticket pueda cerrar; `revertirPorAnulacion` es
requisito de **T4.7**. Ninguno de los dos es una ambigüedad de
negocio — son extensiones de un contrato que la propia spec de
`products`/`stock` ya había reservado y nunca construyó.

### Hallazgo técnico: dos `CHECK` de base recomendados, sin bloquear nada

`sales_total_check CHECK (total >= 0)` (asignado a **T4.6**, donde
`total` queda definitivo) y `sales_descuento_total_check CHECK
(descuento_total >= 0 AND descuento_total <= subtotal)` (asignado a
**T4.3**, donde se escribe `descuento_total` por primera vez) — ver
sección 3. Defensa en profundidad, mismo criterio que el `CHECK` de
signo de `cash_movements`; el servicio ya valida esto en aplicación,
el `CHECK` es la segunda barrera, no la única.

### Hallazgo técnico: lock temprano de sesión de caja

Ver sección 5. Recomendado que `sales.service` tome el lock de la
fila de sesión en el paso 1 de RN-1, siempre — no solo cuando hay pago
en efectivo. Asignado a **T4.1** (es donde se valida la sesión abierta
por primera vez).

### Ticket nuevo: no se agrega ninguno

Los 11 tickets ya listados en `ROADMAP.md` (T4.1–T4.11) cubren el
módulo completo tal como lo describe BLUEPRINT §3.4/§5.3 — los tres
hallazgos de arriba son ajustes de alcance **dentro** de tickets ya
existentes (T4.1, T4.3, T4.6, T4.7), no funcionalidad nueva sin
ticket.

### Estado de las dependencias, confirmado contra `state/STATUS.md`

- **T2.4** (`stock.service`): VERDE, pero incompleto para lo que
  `sales` necesita — ver hallazgo de la sección 4.2. No bloquea el
  arranque de T4.1 (el propio T4.1 cierra el gap), pero sí es trabajo
  real dentro de ese ticket que el título del ticket en `ROADMAP.md`
  no menciona.
- **T3.2** (`cash-registers`, movimientos base): VERDE y completo —
  sin gaps para lo que `sales` necesita.
- **T0.13** (`settings`): VERDE — `permitir_venta_sin_stock` y
  `max_descuento_vendedor_pct` ya sembrados.
- **T0.12** (`common/money`): VERDE — `prorate`/`applyPercentage`/
  `roundCurrency` reusables tal cual.
- **T0.14** (idempotencia): VERDE.
- **AMB-14** (nueva, esta fase): **PENDIENTE**. Bloquea únicamente a
  **T4.3** (autorización de descuento) — T4.1, T4.2, T4.4–T4.11 no
  dependen de su respuesta.

**Orden recomendado, sin reordenar toda la etapa:** T4.1 (con el
trabajo agregado de `stock.service.descontarPorVenta` y el lock
temprano de caja) → T4.2 → T4.4 → T4.5 → T4.6 (con el `CHECK` de
`total`) → T4.7 (con `revertirPorAnulacion`) → T4.8 → T4.9 → T4.10 →
T4.11. **T4.3 espera la resolución de AMB-14**; puede construirse en
paralelo hasta el punto de la autorización (el resto de T4.3 —
registrar el descuento, calcular el tope — no depende de la
respuesta).

---

**Módulo bloqueado hasta resolver AMB-14** (solo afecta a T4.3).
**T4.1, T4.2, T4.4–T4.11 pueden arrancar ya**, con el trabajo adicional
de las secciones 4.2, 3 y 5 incorporado a sus tickets correspondientes.
