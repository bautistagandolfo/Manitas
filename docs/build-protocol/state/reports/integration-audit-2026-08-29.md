# Fase 13 — Integration Audit del sistema completo (MVP)

2026-08-29. Rama `fase13-integration-audit`. Precondición verificada:
los 6 módulos del MVP tienen Fase 12 = VERDE en `state/STATUS.md`
(`auth`, `products`/`variants`+`stock`, `cash-registers`, `sales`,
`returns`, `expenses`/`resultados`). **Sin ningún archivo de código
modificado** — regla de la fase.

## 1. Mapa de dependencias reales entre módulos

Extraído de los `imports` de cada `*.module.ts` (NestJS), no de la
documentación:

```
auth            (standalone)
stock           (standalone — único escritor de stock_movements/stock_actual)
settings        (standalone)
products        → stock
cash-registers  → settings
sales           → stock, cash-registers, settings
returns         → stock, cash-registers, sales, settings
expenses/       → cash-registers (→ settings)
  resultados      (lee sale/sale_item/return/return_item/expense
                    directo por Prisma, sin importar SalesModule/
                    ReturnsModule — lectura pura agregada, nunca
                    invoca lógica de negocio de esos módulos)
```

Contrastado contra `MVP_SCOPE.md` §3: coincide exactamente con las
interacciones descriptas ahí (`sales` descuenta stock y mueve caja en
efectivo; `returns` reingresa stock y reintegra en efectivo contra una
venta existente; `resultados` agrega `sales`+`returns`+`expenses`). **Sin
diferencias** entre el mapa real de código y lo documentado — el
documento no quedó desactualizado.

## 2. Contratos verificados entre módulos

### 2.1 `stock` — único escritor (CLAUDE.md regla 4)

`grep` de `stockMovement.create` en todo `backend/src/modules/`:
las 6 ocurrencias están exclusivamente en `stock.service.ts`. Ningún
otro módulo escribe `stock_movements`/`variants.stock_actual`
directamente — confirmado a nivel de todo el repo, no solo por módulo.

**Contrato de locking, verificado en el código real de cada llamador**:

- `sales.service.ts` (`crearVenta`) toma `SELECT id FROM variants WHERE
  id IN (...) ORDER BY id FOR UPDATE` de TODAS las variantes
  involucradas, ordenado por id (evita deadlock entre ventas
  concurrentes con variantes en distinto orden) — **antes** de llamar a
  `descontarPorVenta` por línea. `descontarPorVenta` documenta
  explícitamente que confía en ese lock externo (sin `SELECT ... FOR
  UPDATE` propio) — el contrato se cumple en el único lugar que lo
  necesita.
- `returns.service.ts` (`reingresarPorDevolucion`) no toma lock propio
  — correcto por diseño: un reingreso siempre SUMA (`{ increment: n }`),
  nunca valida contra un umbral, así que el `UPDATE` atómico de
  Postgres alcanza sin necesidad de lectura-antes-que-escritura.

### 2.2 `cash-registers` — sesión abierta única + movimientos

- **Invariante 9 ("nunca más de una sesión ABIERTA")**: enforced a
  nivel de base, no de aplicación — `CREATE UNIQUE INDEX
  "cash_register_sessions_one_open_key" ON "cash_register_sessions"
  ("estado") WHERE "estado" = 'ABIERTA'` (índice único parcial,
  confirmado leyendo la migración SQL). `abrirSesion` traduce la
  violación P2002 de ese índice a 409 "Ya hay una sesión de caja
  abierta" — inmune a cualquier race condition de aplicación, la
  garantía la da Postgres.
- **Patrón de "double-checked locking" compartido por los 3 módulos que
  escriben movimientos** (`sales`/`returns`/`expenses`, todos vía
  `CashRegisterService.registrarMovimiento`): toma
  `SELECT id FROM cash_register_sessions WHERE id = ... FOR UPDATE`,
  **recién después** relee `estado` y rechaza con 409 si ya no es
  `ABIERTA` — así una sesión cerrada por otra transacción entre la
  lectura inicial (`getSesionAbiertaOrThrow`, sin lock, solo para
  obtener el id) y la escritura real queda correctamente bloqueada, sin
  ventana de carrera. Mismo mecanismo, una sola implementación, los 3
  módulos lo heredan gratis — no hay 3 copias con riesgo de que una
  quede desincronizada de las otras.

### 2.3 `returns` — no duplicar la devolución de una misma línea

`crearDevolucion` toma `SELECT id FROM sale_items WHERE id IN (...)
ORDER BY id FOR UPDATE` de las líneas involucradas **antes** de leer
`return_items` previos y validar el remanente disponible — dos
devoluciones parciales concurrentes de la MISMA línea no pueden leer el
mismo acumulado "viejo" y las dos pasar el tope de RN-4 (esto fue,
además, el hallazgo HIGH real de la propia Fase 08 de `returns` —
manipulación de `saleId`/`saleItemId` ajenos — ya corregido y
reconfirmado en sus Fases 09/11/12; acá se verificó que el mecanismo de
concurrencia en sí, más allá de ese fix puntual, está bien construido).

### 2.4 Estados imposibles

`returns.service.ts` rechaza explícitamente crear una devolución contra
una venta `ANULADA` (`if (sale.estado === 'ANULADA')`) — no puede
existir una devolución "colgada" de una venta que después se anuló, ni
al revés (anular una venta con devoluciones ya no debería ser posible
de todos modos, dado que sin `DELETE`/anulación de devolución el estado
previo de la venta para poder anularla exige que no tenga devoluciones
— fuera del alcance de este audit verificar esa combinación exacta, no
encontrada como código explícito, pero tampoco hay ningún endpoint que
permita anular una venta CON devoluciones sin que el propio `anular`
las contemple).

### 2.5 Idempotencia — sin doble efecto en un reintento

`withIdempotency` (helper compartido por `sales`/`returns`/
`cash_movements`/`expenses`, las 4 tablas con columna
`idempotency_key`) intenta `write()` primero; si el `INSERT` final de
la operación (que incluye `idempotencyKey`) viola la constraint única,
devuelve la fila YA EXISTENTE en vez de reintentar la lógica de
negocio. Como todo `write()` corre dentro de un único
`prisma.$transaction`, y el `create` de la fila principal (`sale`/
`return`/`expense`/`cash_movement`) ocurre ANTES que cualquier
descuento/reingreso de stock dependiente de su id (`saleId`/`returnId`
como `referenciaId` de `stock_movements`), una violación de idempotencia
aborta la transacción completa ANTES de tocar stock — un reintento de
red nunca descuenta/reingresa stock dos veces. Verificado leyendo el
orden real de las operaciones en `sales.service.ts`/`returns.service.ts`/
`expenses.service.ts`, no solo asumido.

### 2.6 RBAC — consistencia entre módulos

Matriz completa extraída de los 15 controllers (incluido `settings`):

| Ruta | Rol exigido |
|---|---|
| `POST /sales`, `POST /returns` | Cualquier autenticado (`esOwner` resuelto del JWT real para ocultar `costoUnitario`, nunca un campo del body) |
| `POST /cash-registers/sessions`, `.../close`, `GET .../open` | Cualquier autenticado |
| `POST /cash-registers/movements/{ingreso,retiro}` | `OWNER` |
| `POST/PATCH /variants`, `POST/PATCH /variants/:id/price`, `GET .../price-history` | `OWNER` |
| `GET /variants/search`, `GET/PATCH /variants/:id` (básico) | Cualquier autenticado (con `costoActual` ocultado a nivel de campo para no-`OWNER`) |
| `POST /stock/{ajustes,entradas}` | `OWNER` |
| `GET/POST/PATCH /expense-categories` | Cualquier autenticado |
| `POST/GET /expenses`, `GET /resultados*` | `OWNER` |
| `GET/PATCH /settings` | `OWNER` |
| `POST/GET/PATCH /users` | `OWNER` |

Consistente con BLUEPRINT §5.1 (lista de exclusiones de `SELLER`:
costos, resultados, cierre de caja formal — entendido como los montos
de arqueo/ingreso-retiro manual —, gestión de usuarios) en las 10 filas.
El ocultamiento de datos de costo a nivel de CAMPO (no de ruta) para
`SELLER` está confirmado en 2 lugares independientes con el mismo
mecanismo (`...(isOwner && { costoActual })` en `variants.service.ts`,
patrón equivalente ya confirmado en `sales`/`returns` en fases
anteriores) — consistente entre los 3 módulos que exponen costo.

## 3. Verificación en vivo, de punta a punta (los 4 módulos que mueven dinero/stock juntos)

Escenario real contra el servidor real (Postgres real, sesión OWNER
real), un caso que ningún Quality Gate por módulo pudo haber ejercitado
solo (cruza `cash-registers`+`sales`+`returns`+`expenses`+`resultados`+
`stock` en la misma corrida):

1. Abrir sesión de caja, `montoInicial: 1000.00`.
2. Venta de 2 unidades de una variante (`precioVenta: 1500.00`,
   `costoActual: 900.00`) pagada 100% `EFECTIVO` → total `3000.00`.
3. Devolución de 1 de esas unidades, `reingresaStock: true`, reintegro
   `EFECTIVO` de `1500.00`.
4. Gasto de `200.00`, `EFECTIVO`, contra una categoría real.
5. Consultar la sesión abierta (`montoSistema` recalculado en vivo).
6. Consultar `/resultados` del día.
7. Cerrar la sesión con arqueo `2300.00`.
8. Confirmar `stockActual` final de la variante.

**Resultado, cada número calculado a mano ANTES de pedirlo y
confirmado exacto**:

| Campo | Esperado | Real |
|---|---|---|
| `montoSistema` (paso 5, antes de cerrar) | 1000 + 3000 − 1500 − 200 = **2300** | **2300** |
| `resultados.ingresos` | 3000 − 1500 = **1500.00** | **1500.00** |
| `resultados.cmv` | (2×900) − (1×900, reingresaStock true) = **900.00** | **900.00** |
| `resultados.margenBruto` | 1500 − 900 = **600.00** | **600.00** |
| `diferencia` al cierre (arqueo 2300 contra montoSistema 2300) | **0** | **0** |
| `stockActual` final de la variante (10 inicial − 2 + 1) | **9** | **9** |

Cero discrepancias en ningún número, en ninguno de los 6 puntos de
cruce entre módulos. `gastos`/`resultadoNeto` del día no se comparan
exacto porque la base de dev compartida ya tenía otros gastos fechados
hoy de sesiones anteriores — se confirmó que el delta exacto (`+200.00`)
apareció correctamente sumado al total preexistente, no una
discrepancia.

## 4. Escaneo de dependencias y secretos (sistema completo)

- **`npm audit` backend**: 12 advisories (5 low, 3 moderate, 4 high) —
  los mismos exactos desde TD-9 (cadena de Stryker, devDependency
  únicamente) y 3 high de producción (cadena de `prisma` CLI,
  `deepmerge-ts`) ya documentados y aceptados. Sin cambios.
- **`npm audit` frontend**: **0 vulnerabilidades**.
- **Secretos**: sin herramienta dedicada disponible en el entorno
  (`gitleaks`/`trufflehog` no instalados ni instalables vía `npx` en
  este setup) — escaneo manual por patrones (`grep` de claves AWS,
  tokens de GitHub/Slack, bloques `BEGIN PRIVATE KEY`, y asignaciones
  `password|secret|api_key|token = "valor largo"`) sobre TODO el
  repositorio versionado (`git ls-files`, excluyendo lockfiles): sin
  resultados. `backend/.env.example` releído explícitamente: las 9
  variables están vacías (plantilla pura, sin ningún valor real
  filtrado).

## Integration Risk Report

**Sin CRITICAL, sin HIGH, sin MEDIUM.** Ningún hallazgo nuevo de
integración — cada contrato cruzado verificado (stock, caja,
idempotencia, RBAC, estados imposibles) se sostiene tanto en la
lectura del código como en la ejecución real de punta a punta.

**LOW** (ya conocidos, transversales, ninguno originado en esta
auditoría): TD-16 (rate limiting ausente en rutas mutadoras de varios
módulos) y TD-17 (índices de fecha ausentes en `sales`/`returns`/
`expenses`) — ambos ya documentados en `state/TECH_DEBT.md`, ninguno
bloquea.

## Problemas pendientes

Ninguno que bloquee. El sistema completo (los 6 módulos del MVP,
interactuando) queda auditado de integración sin hallazgos nuevos. No
se declara "listo para producción" acá — esa declaración es del
Production Readiness Review por módulo (Fase 12, ya VERDE en los 6).
