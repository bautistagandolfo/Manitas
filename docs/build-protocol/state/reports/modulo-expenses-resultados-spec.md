# Spec del módulo `expenses` + `resultados` (2026-08-28)

Fase 06 del protocolo, Etapa 6 de `state/ROADMAP.md` (T6.1–T6.9).
Dependencias declaradas — `auth` (T1.3), `cash-registers` (T3.2),
`sales` (T4.4), `returns` (T5.4), `settings`/idempotencia (T0.13/T0.14)
— las cinco VERDE. **T6.5 depende además de T0.7** (helper de zona
horaria, AD-13), hoy `PENDIENTE` — decisión ya tomada con el usuario:
T6.1–T6.4 avanzan sin bloquearse, T0.7 se resuelve recién cuando el
ticket que lo necesita (T6.5) esté al frente.

Riesgo: `MVP_SCOPE.md` §5 clasifica **`resultados` como MEDIO** ("es
solo lectura y solo lo ve la dueña: su riesgo real son los cálculos
equivocados, no la seguridad" — Fase 08 reforzada, Fases 09/11
aligeradas). Ver sección 11 para cómo se traduce esto en las dos
mitades del módulo (`expenses` sí mueve plata real; `resultados` es
puro cálculo de lectura).

Fuentes: `BLUEPRINT.md` AD-7/AD-8/AD-13, §3.7/§3.8/§3.9, §5.6,
invariantes 7/9/10, §9.3/§9.4/§9.7/§9.8, §12.4/§12.6; `MVP_SCOPE.md`
§3.6, §5, §7 (puntos 5 y 7 del criterio de MVP entregable);
`backend/prisma/schema.prisma` (modelos `Expense`/`ExpenseCategory`,
enums `ExpenseMedioPago`/`CashMovementTipo.GASTO`/
`CashMovementReferenciaTipo.EXPENSE`, ya en la base desde la Fase 01 —
sin migración nueva); `backend/prisma/seed.ts` (las 6 categorías
seedeadas con `bloqueada: true`, nunca "Mercadería"); `state/reports/
modulo-sales-spec.md`/`modulo-returns-spec.md`/
`modulo-cash-registers-spec.md` (los tres módulos con los que este
integra); `backend/src/modules/cash-registers/cash-register.service.ts`
y `backend/src/modules/products/brands.controller.ts` (leídos
completos — este módulo reusa el primero y sigue el patrón de
permisos del segundo, ver secciones 5 y 8).

---

## 1. Responsabilidad

Este módulo tiene DOS mitades con objetivos distintos:

**`expenses`** es dueño de:

- Las **categorías de gasto** (`expense_categories`): ABM, con la
  regla de `bloqueada` (AD-7 — nunca se puede crear/renombrar una
  categoría que aluda a compra de mercadería).
- El **registro de gastos** (`expenses`): un gasto por vez, con
  categoría, descripción, monto, medio de pago y quién lo cargó.
- El **movimiento de caja condicional** — delega la escritura real a
  `cash-register.service.ts` (mismo criterio que `sales`/`returns`),
  solo cuando `medio_pago = EFECTIVO` (invariante 10: un gasto por
  transferencia NO necesita sesión de caja abierta).

**`resultados`** es dueño de:

- La **consulta agregada** de ingresos, CMV, margen, gastos y
  resultado neto por rango de fechas (§5.6) — sin tabla propia, una
  consulta sobre `sales`/`returns`/`sale_items`/`return_items`/
  `expenses` ya existentes.
- Los **rankings** (productos más vendidos/con más margen, gastos por
  categoría).
- La **agrupación temporal en hora argentina** (AD-13) de todo lo
  anterior.

Ninguna de las dos mitades es dueña de, y nunca escribe directamente
en:

- `sales`/`sale_items`/`payments`/`returns`/`return_items`/
  `return_payments` — `resultados` solo **lee** esas tablas (mismo
  criterio que `returns` lee `sales`/`payments` directamente sin que
  `sales` tenga que exponer nada nuevo).
- `cash_movements`/sesión de caja (delega a `cash-register.service.ts`).
- `stock_movements`/`variants.stock_actual` — este módulo nunca toca
  stock (comprar mercadería no es un gasto, AD-7; vender/devolver ya
  lo maneja `stock`).
- `settings` — `resultados` no agrega ningún parámetro configurable
  nuevo (BLUEPRINT §10 ya tiene los 4 que hacen falta: `settings`
  existe desde T0.13, T6.9 solo construye la PANTALLA de edición, no
  ningún parámetro nuevo).

## 2. Reglas de negocio

**RN-1. Categorías de gasto: ABM abierto, con `bloqueada` como única
restricción real (AD-7).** Sin rol restringido para crear/listar/
renombrar/desactivar — mismo criterio que marcas/categorías de
`products` (`brands.controller.ts`: "sin `@Roles`, gestionar marcas no
está en la lista de exclusiones de `SELLER`" — BLUEPRINT §5.1 nunca
menciona "categorías de gasto" entre lo que un `SELLER` no puede
tocar). Al **crear o renombrar**, se rechaza cualquier nombre que
contenga "mercadería", "compra de ropa" o "proveedores" (case-
insensitive, coincidencia de substring — mismo criterio textual que
BLUEPRINT §3.7 da como ejemplos, sin pretender ser una lista
exhaustiva de sinónimos: es una defensa contra el error más común, no
un filtro perfecto). Una categoría con `bloqueada = true` (las 6
seedeadas) **no admite** `PATCH` de `nombre` ni de `activo` — sí puede
usarse normalmente en `POST /expenses`. Categorías nuevas (creadas
después del seed) nacen con `bloqueada = false`: sí se pueden renombrar
o desactivar más adelante.

**RN-2. Registrar un gasto: solo `OWNER` (decisión de esta sesión,
ver sección 11).** A diferencia de `sales`/`returns` ("es el trabajo
del vendedor"), `ROADMAP.md` ya marca T6.8 ("Pantallas de gastos y de
resultados") explícitamente **"(solo OWNER)"** — una sola anotación
que cubre ambas pantallas. Dado que un gasto revela montos reales
contra categorías sensibles ("Sueldos", "Alquiler") y BLUEPRINT §5.1
exige que toda restricción de rol se verifique en el servidor (no solo
ocultando el botón), la lectura más consistente es que el módulo
entero de gastos —crear, listar, ver— es tan `OWNER`-only como
`resultados`. El ABM de categorías (RN-1) queda afuera de esta
restricción: gestionar NOMBRES de categoría no revela ningún monto.

**RN-3. Monto siempre positivo (mismo criterio que `sales`/`returns`/
`cash-registers`).** `assertPositive`/`assertDentroDePrecision`
(`common/money/money.util.ts`, ya existentes) — sin inventar una
validación nueva.

**RN-4. Medio de pago libre, sin combinación (a diferencia de
`sales`/`returns`).** Un gasto tiene **un solo** `medio_pago`
(`EFECTIVO` | `TRANSFERENCIA` | `OTRO`) — no hay lista de pagos
parciales como en una venta. BLUEPRINT §3.7 lo modela como un único
campo enum en `expenses`, no una tabla de líneas.

**RN-5. Movimiento de caja solo si `EFECTIVO` (invariante 7, AD-8).**
`medio_pago = EFECTIVO` → un `cash_movement` tipo `GASTO`, **negativo**
(mismo criterio que `DEVOLUCION` en `returns` — sale del cajón).
`TRANSFERENCIA`/`OTRO` no tocan la caja — el gasto se registra igual
en `expenses`, sin ningún movimiento asociado.

**RN-6. Sesión de caja: solo obligatoria si el gasto es en efectivo
(invariante 10, literal — la excepción explícita del blueprint).** A
diferencia de `sales`/`returns` (sesión SIEMPRE obligatoria, sin
importar el medio), acá:

- `medio_pago = EFECTIVO` → exige sesión de caja abierta, mismo
  fail-fast que `sales`/`returns` (`getSesionAbiertaOrThrow`, lock de
  la fila de sesión antes de cualquier otra escritura).
- `medio_pago = TRANSFERENCIA` u `OTRO` → **no** requiere sesión — "la
  dueña puede pagar el alquiler un domingo desde su casa" (BLUEPRINT,
  invariante 10, cita literal).

**RN-7. Registrar un gasto es idempotente (BLUEPRINT §9.7, `expenses`
está en la lista literal de las 4 tablas con `idempotency_key`).**
Mismo patrón `IdempotencyInterceptor`/`withIdempotency` que
`sales`/`returns`/`cash-registers`.

**RN-8. `resultados`: fórmula exacta de §5.6, sin aproximaciones.**

```
Ingresos       = SUM(sales.total)            WHERE sales.estado = 'COMPLETADA'
               − SUM(returns.total_devuelto)

CMV            = SUM(sale_items.cantidad × sale_items.costo_unitario)
                   JOIN sales, WHERE sales.estado = 'COMPLETADA'
               − SUM(return_items.cantidad × return_items.costo_unitario)
                   WHERE return_items.reingresa_stock = true

Margen bruto   = Ingresos − CMV

Gastos         = SUM(expenses.monto)         WHERE expenses.fecha en el período

Resultado neto = Margen bruto − Gastos
```

**Los tres filtros que BLUEPRINT marca como "parecen detalles y no lo
son" (§5.6), verbatim, sin margen de interpretación:**

1. El CMV filtra por `sales.estado = 'COMPLETADA'` **igual que los
   ingresos** — nunca por separado.
2. La reversión del costo (la resta del CMV por devoluciones) **solo**
   aplica a `return_items.reingresa_stock = true` — una devolución de
   mercadería fallada resta el ingreso pero el costo queda (la ropa se
   perdió, ya congelado por T5.4).
3. El período se filtra **siempre** por `sales.fecha`/`returns.fecha`/
   `expenses.fecha` (nunca por `created_at` de las tablas de ítems,
   que no tienen fecha propia — hay que hacer `JOIN` hacia la
   cabecera), las tres convertidas a hora argentina (AD-13, T0.7).

**RN-9. Resultados "al día de hoy", no fotos inmutables.** Una
anulación de venta posterior a la consulta puede cambiar un período ya
mostrado — la respuesta incluye siempre `calculadoEn` (timestamp del
cálculo), para que dos números distintos de días distintos se puedan
explicar (BLUEPRINT §5.6, literal).

**RN-10. Ranking de productos: por unidades vendidas y por margen,
gastos por categoría.** Mismo rango de fechas y mismos filtros de RN-8
(solo ventas `COMPLETADA`, descontando devoluciones con
`reingresa_stock = true`).

**RN-11. `resultados` es exclusivo de `OWNER` (BLUEPRINT §5.1,
literal: "`SELLER` no accede a: módulo de resultados... ni costos de
productos").** Sin excepción — ni siquiera un resumen parcial.

## 3. Invariantes

De la sección 6 del blueprint:

- **7** — de los movimientos de caja que este módulo genera, solo
  `medio_pago = EFECTIVO` produce `cash_movement` (RN-5). Los de tipo
  `GASTO` no dependen de ningún otro invariante de reintegro/cobro —
  son su propio origen (BLUEPRINT invariante 7, última frase, literal).
- **9** — no hay lógica propia acá; `registrarMovimiento` (ya
  construido en `cash-registers`) sigue garantizándolo.
- **10** — la mitad que le toca a este módulo: un gasto en efectivo
  nunca se registra sin sesión de caja abierta; uno por transferencia/
  otro NO la necesita (RN-6, la única excepción literal a la regla que
  `sales`/`returns` aplican sin condición).

Ningún invariante de `sales`/`returns`/`stock` (1 a 6, 8, 11 a 15) se
toca desde este módulo — `resultados` solo **lee**, nunca escribe
sobre esas tablas.

## 4. Contratos de API

| Método | Ruta | Rol | Body/Query | Notas |
|---|---|---|---|---|
| `GET` | `/expense-categories` | cualquiera autenticado | — | Lista todas (activas e inactivas — el front decide qué mostrar, mismo criterio que `brands`/`categories`). Devuelve `{ id, nombre, activo, bloqueada }`. |
| `POST` | `/expense-categories` | cualquiera autenticado (RN-1) | `{ nombre: string }` | Rechaza nombres que aludan a mercadería (400, mensaje explicando por qué — AD-7). `bloqueada` nace siempre `false` — nadie crea una categoría bloqueada a mano. |
| `PATCH` | `/expense-categories/:id` | cualquiera autenticado (RN-1) | `{ nombre?: string, activo?: boolean }` | Si `bloqueada = true`, rechaza CUALQUIER cambio de `nombre` o `activo` con 409 (mensaje: "Esta categoría no se puede modificar"). Mismo chequeo de nombre-mercadería que `POST` si viene `nombre`. |
| `POST` | `/expenses` | **`OWNER`** (RN-2) | `{ expenseCategoryId: number, descripcion: string, monto: string, medioPago: 'EFECTIVO' \| 'TRANSFERENCIA' \| 'OTRO' }`, header `Idempotency-Key` | Idempotente (RN-7). Si `medioPago = EFECTIVO`, exige sesión de caja abierta (409 si no hay) y genera el `cash_movement`. Categoría inexistente → 404. `userId` resuelto siempre del JWT. |
| `GET` | `/expenses` | **`OWNER`** (RN-2) | `?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` (opcional, sin filtro trae todo) | Paginado (BLUEPRINT §12.4, "todo listado... paginado en el servidor") — mismo patrón de `page`/`pageSize` que `GET /variants/search`. Ordena por `fecha` descendente (§12.4, "lo último siempre arriba"). |
| `GET` | `/resultados` | **`OWNER`** (RN-11) | `?desde=YYYY-MM-DD&hasta=YYYY-MM-DD` (obligatorios) | Devuelve `{ ingresos, cmv, margenBruto, margenBrutoPct, gastos, resultadoNeto, calculadoEn, periodo: { desde, hasta } }` — todos los importes como string (`Decimal`, BLUEPRINT §9.3). |
| `GET` | `/resultados/ranking-productos` | **`OWNER`** (RN-11) | `?desde=...&hasta=...&orden=unidades\|margen` | `[{ variantId, descripcionSnapshot, unidadesVendidas, margenTotal }]`, mismo rango/filtros que `/resultados`. |
| `GET` | `/resultados/gastos-por-categoria` | **`OWNER`** (RN-11) | `?desde=...&hasta=...` | `[{ expenseCategoryId, nombre, total }]`. |

**Explícitamente fuera de esta fase** (mismo criterio que los gaps ya
aceptados de `sales`/`returns`): `DELETE`/baja física de gastos o
categorías — "las categorías se desactivan, los gastos, una vez
cargados, quedan" (mismo espíritu que "las devoluciones no se anulan",
§5.4 — si hace falta corregir un gasto mal cargado, es un ajuste
manual fuera de este módulo, no hay ticket que lo reserve).

## 5. Transacciones y concurrencia

**`ExpensesService.registrarGasto(tx, input)`** — mismo contrato que
`crearVenta`/`crearDevolucion`: recibe siempre el `tx` de una
transacción ya abierta por el controller.

1. Leer la categoría (`expenseCategoryId`); si no existe o
   `activo = false` → 404/400 (mismo criterio que `sales` con
   variantes inactivas, T4.1 fase 07).
2. **Si `medioPago = EFECTIVO`**: `cashRegisterService.
   getSesionAbiertaOrThrow(tx)` (fail-fast) + lock de la fila de
   sesión (`SELECT ... FOR UPDATE`) — mismo patrón exacto que
   `sales`/`returns`. **Si `medioPago` es `TRANSFERENCIA`/`OTRO`**: se
   salta este paso enteramente — es la única rama de todo el sistema
   donde una operación de dinero NO abre ningún lock de sesión.
3. `tx.expense.create` (con `idempotencyKey`, `userId` del JWT).
4. **Si `medioPago = EFECTIVO`**: `cashRegisterService.
   registrarMovimiento(tx, { sessionId, tipo: GASTO, monto,
   referenciaTipo: EXPENSE, referenciaId: expense.id, descripcion:
   <la del gasto>, userId })` — reusa el método ya construido en
   `cash-registers`, mismo patrón que `returns` con `DEVOLUCION`.

Sin lock de `expense_categories` — no hay condición de carrera real
(crear un gasto no compite por un recurso escaso, a diferencia de
stock/último-ítem).

**`ResultadosService.consultar(desde, hasta)`** — **lectura pura**, sin
`tx` (no compite con ninguna escritura, mismo criterio que
`reconciliar()` de `sales`/`cash-registers`/`stock` y
`buscarVentaParaDevolucion`/`consultarCredito` de `returns`). Abre su
propia transacción `RepeatableRead` para que ingresos/CMV/gastos se
lean de un mismo snapshot consistente (mismo patrón ya usado tres
veces en `returns`).

Conversión a hora argentina (AD-13, T0.7): el rango `desde`/`hasta`
que llega como fecha (sin hora) se interpreta como "medianoche a
medianoche en hora argentina", convertido a UTC recién al armar el
filtro SQL — nunca comparando strings de fecha ni usando
`DATE(created_at)` en UTC directo (el error silencioso que AD-13
describe).

## 6. Edge cases

- **Gasto en efectivo sin sesión de caja abierta**: 409, ANTES de
  crear nada (RN-6).
- **Gasto por transferencia sin ninguna sesión de caja, ni abierta ni
  cerrada en el sistema**: se acepta igual — invariante 10 no exige
  ninguna sesión para este camino.
- **Categoría con nombre "compra de mercadería para reventa"**:
  rechazada (contiene "mercadería" — RN-1).
- **Renombrar "Otros" a "Compra a proveedores"**: rechazada dos veces
  — primero porque `bloqueada = true` (409), y aunque no lo estuviera,
  también por el chequeo de nombre (400) — cualquiera de los dos
  alcanza, el orden de validación (bloqueada primero) evita hacer el
  chequeo de texto en una categoría que ya iba a rechazarse igual.
- **Categoría inactiva usada en `POST /expenses`**: rechazada — mismo
  criterio que una variante `activo: false` en `sales` (T4.1, RN-2 de
  `products`).
- **Doble click al registrar un gasto**: mismo mecanismo de
  idempotencia que `sales`/`returns` — la segunda request devuelve el
  gasto ya creado, sin duplicar el movimiento de caja.
- **Consulta de resultados con `desde > hasta`**: 400.
- **Consulta de resultados de un período sin ninguna venta/gasto**:
  200 con todos los valores en `0.00`, no un error.
- **Venta de las 23:59 hora argentina (02:59 UTC del día siguiente)**:
  cae en el día correcto según AD-13 — el test obligatorio que
  BLUEPRINT exige literal (§5.6, "un test debe verificar que una venta
  de las 23:30 pertenece al día correcto").
- **Anulación de una venta después de haber consultado resultados de
  ese período**: el próximo cálculo del mismo rango da un número
  distinto — comportamiento esperado (RN-9, "al día de hoy").
- **Devolución con `reingresaStock: false` dentro del período**: resta
  el ingreso (vía `returns.total_devuelto`) pero el CMV **no** se
  ajusta por esa línea — el costo de la mercadería perdida queda
  adentro (RN-8, filtro 2).

## 7. Errores

| Situación | Status | Mensaje al usuario |
|---|---|---|
| Categoría inexistente (`POST /expenses`) | 404 | "Categoría de gasto no encontrada" |
| Categoría inactiva (`POST /expenses`) | 400 | "Esta categoría de gasto está desactivada" |
| Nombre de categoría alude a mercadería (`POST`/`PATCH`) | 400 | "Comprar mercadería no es un gasto — se registra como ingreso de stock" |
| Categoría bloqueada, se intenta renombrar/desactivar | 409 | "Esta categoría no se puede modificar" |
| Sin sesión de caja abierta, gasto en efectivo | 409 | "No hay una sesión de caja abierta" (mismo texto que `sales`/`returns`) |
| `desde > hasta` en `/resultados` | 400 | "El rango de fechas no es válido" |
| Rol insuficiente (`SELLER` en cualquier ruta de gastos/resultados) | 403 | Mensaje genérico del `RolesGuard` ya existente |

## 8. Permisos

| Acción | `OWNER` | `SELLER` |
|---|---|---|
| ABM de categorías de gasto | ✅ | ✅ (RN-1, mismo criterio que marcas/categorías) |
| Registrar un gasto | ✅ | ❌ (RN-2 — ver sección 11, decisión de esta sesión) |
| Ver el listado de gastos | ✅ | ❌ (RN-2) |
| Consultar resultados (cualquier endpoint) | ✅ | ❌ (RN-11, BLUEPRINT §5.1 literal) |

## 9. Tests necesarios

- **Unitarios (Jest, servicio mockeado)** — cada RN de la sección 2,
  mismo criterio de exhaustividad que `sales`/`returns`.
- **`resultados`, casos armados a mano (T6.7 del roadmap, literal)**:
  un escenario completo con ventas, devoluciones (con y sin
  `reingresaStock`), anulaciones y gastos (efectivo y transferencia),
  con el resultado esperado calculado A MANO fuera del sistema y
  comparado contra lo que devuelve el servicio — no alcanza con
  probar que "la fórmula del código coincide con la fórmula del
  código" (eso no detecta un error conceptual compartido).
- **Los tres filtros de RN-8 verificados por separado**: una venta
  `ANULADA` con `sale_items` reales no debe aportar ni ingreso ni CMV;
  una devolución con `reingresaStock: false` resta ingreso sin tocar
  CMV; un `sale_item`/`expense` fuera del rango de fechas (por un
  minuto) no debe aparecer en el cálculo.
- **AD-13 (obligatorio, literal)**: una venta a las 23:30 hora
  argentina (que cruza la medianoche en UTC) aparece en el día
  argentino correcto, no el de UTC.
- **Integración (Postgres real)**: registrar gasto en efectivo con
  sesión abierta (genera `cash_movement`); en efectivo sin sesión
  (rechaza, rollback completo); por transferencia sin ninguna sesión
  en el sistema (se acepta); categoría bloqueada (rechaza cambios);
  idempotencia (doble click, una sola fila y un solo movimiento).
- **Testing de mutación (Stryker, obligatorio para `resultados` —
  BLUEPRINT §9.8 lo lista literal junto a `sales`/`stock`/
  `cash-registers`/`returns`)**: umbral 80%. **No exigido para
  `expenses`** (no está en esa lista — igual se corre si el tiempo lo
  permite, dado que sí mueve plata real, mismo criterio voluntario ya
  aplicado a otros tickets de esta etapa, pero no es requisito
  bloqueante de la Fase 08 de este módulo).

## 10. Ambigüedades

Sin ambigüedades PENDIENTES al cierre de esta fase. La única decisión
no 100% literal del blueprint (RN-2/RN-11, quién puede registrar un
gasto) se resolvió con una fuente ya escrita y confirmada
—`ROADMAP.md`, la anotación "(solo OWNER)" de T6.8— no inventada en
esta sesión; ver el razonamiento completo en la sección 11.

## 11. Tickets

Los 9 tickets de `state/ROADMAP.md` (T6.1–T6.9) siguen siendo
correctos en su objetivo y dependencias. Ninguno nuevo.

**Nota de riesgo (MVP_SCOPE.md §5) aplicada ticket por ticket:**
`resultados` está clasificado MEDIO ("cálculos equivocados, no
seguridad" — Fase 08 reforzada, Fases 09/11 aligeradas). Pero
`expenses` (T6.1–T6.3) **sí mueve plata real** (genera
`cash_movements`, igual que `sales`/`returns`) — la clasificación MEDIO
del `MVP_SCOPE.md` es sobre el módulo `resultados` específicamente
(la tabla de riesgo solo nombra esa fila, no "expenses" aparte, porque
`ROADMAP.md` agrupa ambos en una sola Etapa con un solo cierre de
Fases 07→12). Para no perder rigor donde sí hay dinero de por medio:
**la Fase 08 (QA adversarial) del cierre de Etapa 6 se hace completa
para las dos mitades**; las Fases 09/11 (seguridad) se pueden
aligerar específicamente para los endpoints de solo lectura de
`resultados` (mismo criterio textual que el `MVP_SCOPE.md` ya
autoriza), pero no para `POST /expenses`/`POST /expense-categories`
(escritura, dinero) — se auditan con el mismo criterio que
`sales`/`returns`.

**Fase 04a (tests primero, sesión aislada)**: `04a-tests-first.md`
la declara "Obligatoria para `sales`, `returns`, `cash-registers` y
el servicio de stock. Opcional en el resto" — `expenses`/`resultados`
no están en esa lista, así que NO es obligatoria por el protocolo
base. **Decisión de esta sesión, por el mismo criterio de rigor ya
aplicado voluntariamente en toda la Etapa 5** (confirmado con el
usuario — preferencia registrada de mantener el rigor completo en
tickets de plata): se aplica igual a **T6.2/T6.3** (registrar gasto +
su movimiento de caja, plata real) y a **T6.4–T6.7** (`resultados`,
el cálculo que la clienta usa para decidir sobre su negocio — un
error ahí no se nota hasta que los números no cierran). **T6.1**
(ABM de categorías, sin plata de por medio, mismo patrón ya construido
sin Fase04a para marcas/categorías/talles/colores) y **T6.8/T6.9**
(pantallas, frontend) siguen el criterio ya establecido: Fase04a no
aplica.

**Sin bloqueos pendientes** para T6.1–T6.4 y T6.6/T6.8/T6.9 — pueden
construirse siguiendo el orden de dependencias ya declarado
(`ROADMAP.md`). **T6.5 y, por dependencia directa, T6.7** quedan
esperando la resolución de T0.7 — decisión ya tomada con el usuario de
resolverlo cuando el ticket llegue, no antes.
