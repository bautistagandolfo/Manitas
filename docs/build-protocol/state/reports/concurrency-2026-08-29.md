# Fase 15 — Prueba de concurrencia y carga

2026-08-29. Rama `fase15-concurrency-load-test`. Precondición
verificada: Fase 14 VERDE. **Sin código modificado** — regla de la
fase. Los 4 escenarios pedidos por el protocolo se probaron con
requests HTTP **genuinamente concurrentes** (disparadas en paralelo
vía `curl ... & ... wait`, nunca secuenciales — un solo navegador no
alcanza para esto) contra el servidor real, Postgres real. Cada
escenario se verificó contra el **estado persistido real** (releyendo
la base vía la API después de la carrera), nunca solo contra el código
de respuesta HTTP.

## Test A — Múltiples ventas simultáneas del mismo producto, stock limitado

**Setup**: variante con `stockActual = 5` exacto. **8 `POST /sales`
concurrentes**, cada una pidiendo 1 unidad, **8 `Idempotency-Key`
distintas** (operaciones genuinamente separadas, no reintentos de la
misma).

**Resultado**: `5× 201 Created, 3× 409 Conflict`. Los 3 rechazos, el
mismo mensaje exacto: `"Stock insuficiente: quedan 0 unidades"` — cada
rechazo vio el stock YA actualizado por las ventas que llegaron antes
en la serialización del lock, no una lectura obsoleta. Verificado:

- `stockActual` final: **0** (nunca negativo, nunca por debajo de cero).
- Las 5 ventas exitosas: **5 `id` distintos** (`13684`–`13688`) — sin
  ninguna duplicada.

**Sin race condition.**

## Test B — Cierre de caja mientras hay una venta en curso

**Setup**: sesión de caja abierta, variante con stock de sobra (5
unidades). **`POST /sales` (EFECTIVO) y `POST
/cash-registers/sessions/:id/close` disparados concurrentes.**

**Resultado**: el cierre ganó la carrera (`200 OK`,
`montoSistema`/`diferencia` exactos, sin incluir la venta perdedora). La
venta perdió con `409 "No hay una sesión de caja abierta"` — mensaje
coherente con el estado real en el momento en que su transacción llegó
al paso de registrar el movimiento de caja.

**Verificado, sin estado intermedio/huérfano**:

- `stockActual`: **sin cambio** (la venta rechazada no descontó ni
  parcial ni completo — la transacción completa de `sales.service.ts`
  se revirtió, no solo el paso de caja).
- Ninguna fila `sale` sin su `cash_movement` correspondiente, ni
  viceversa — la venta perdedora simplemente no dejó ningún rastro.

**Sin race condition.**

## Test C — Doble submit de la misma operación (otro endpoint, además de `sales` ya probado en la Fase 14)

**Setup**: **3 `POST /cash-registers/movements/ingreso` concurrentes**,
**la misma `Idempotency-Key`** para los 3.

**Resultado**: `3× 201 Created`, los 3 cuerpos de respuesta **byte a
byte idénticos** (mismo `id: 17871`, mismo `createdAt`) — una sola fila
real. `montoSistema` de la sesión: **300** (no 900) — confirmado que el
monto no se contó tres veces.

**Sin race condition.** (El mismo mecanismo ya se había confirmado
para `sales` en la Fase 14, sección 2.5 — acá se reconfirma que
`registrarMovimientoManual`, que reusa el mismo lock + unicidad de
`idempotency_key`, se comporta igual.)

## Test D — Dos operaciones abriendo la misma caja al mismo tiempo

**Setup**: sesión previa cerrada. **5 `POST /cash-registers/sessions`
concurrentes**, 5 `Idempotency-Key` distintas (5 intentos de apertura
genuinamente separados, simulando 5 "usuarios" —o el mismo usuario con
5 pestañas— tratando de abrir la caja a la vez).

**Resultado**: `1× 201 Created, 4× 409 Conflict "Ya hay una sesión de
caja abierta"`. Confirmado, releyendo la base: **exactamente una**
sesión `ABIERTA` (`id: 19191`) — el índice único parcial de Postgres
(`cash_register_sessions_one_open_key`, ya identificado en la Fase 13)
sostiene la garantía bajo concurrencia real, no solo en la lectura del
código.

**Sin race condition.**

## Test E — Dos usuarios devolviendo la misma línea de venta al mismo tiempo

**Setup**: venta real de 3 unidades de una misma línea. **2
`POST /returns` concurrentes**, cada uno pidiendo devolver 2 unidades
de la MISMA línea (`saleItemId`) — la suma (4) supera lo vendido (3),
el escenario exacto que el lock de `sale_items` (Fase 13, hallazgo HIGH
original de `returns` en su propia Fase 08) tiene que prevenir.

**Resultado**: `1× 201 Created (2 unidades), 1× 400 Bad Request`. El
mensaje del rechazo: `"La línea 12771 supera lo disponible para
devolver: quedan 1 unidades"` — exacto, calculado DESPUÉS de que la
primera devolución ya se había contabilizado (no una lectura
concurrente obsoleta que hubiera dejado pasar las dos). Confirmado
releyendo `GET /returns/sales/:numero`: `cantidadDisponible: 1` para
esa línea — coincide exacto con `3 vendidas − 2 devueltas = 1`, nunca
se permitió devolver más de lo vendido ni bajo concurrencia real.

**Sin race condition.**

## Resumen

| Test | Escenario | Resultado |
|---|---|---|
| A | Ventas concurrentes, stock limitado | 5/8 exitosas exacto, stock final 0, sin duplicados |
| B | Cierre de caja + venta concurrente | Rollback completo y limpio de la venta perdedora, sin estado huérfano |
| C | Doble submit (`ingreso` manual) | 1 sola fila real bajo 3 requests concurrentes idénticas |
| D | Apertura de caja concurrente | 1/5 exitosa exacto, índice único parcial confirmado en vivo |
| E | Devolución concurrente de la misma línea | Sin sobre-devolución, remanente exacto tras la carrera |

**Sin CRITICAL, sin HIGH, sin MEDIUM, sin LOW nuevos.** Ninguna race
condition encontrada en los 5 escenarios probados — todas las
garantías ya identificadas a nivel de código en la Fase 13 (locks
ordenados por id, índice único parcial, idempotencia, atomicidad
transaccional) se sostienen bajo concurrencia HTTP real, no solo en la
lectura del código fuente.

## Verificación

- Servidor real levantado, Postgres real, todos los tests disparados
  con requests HTTP genuinamente paralelas (`curl ... & wait`).
- Estado persistido releído después de cada carrera — nunca se dio por
  válido un resultado solo por el código HTTP de una respuesta.
- Datos de prueba (producto/variante `Fase15 Concurrencia Test`) sin
  residuo funcional relevante — sesión de caja cerrada con arqueo
  exacto al terminar.
- Sin código modificado.

## Problemas pendientes

Ninguno. Sigue la Fase 16 (Release Candidate) cuando corresponda.
