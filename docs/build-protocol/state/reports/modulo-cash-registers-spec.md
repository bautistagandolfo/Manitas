# Spec del módulo `cash-registers` (2026-08-24)

Fase 06 del protocolo, Etapa 3 de `state/ROADMAP.md` (T3.1–T3.7).
Dependencia declarada (T1.3, guards de `auth`) VERDE. Fuentes:
`BLUEPRINT.md` §3.6, §5.1 (exclusiones de `SELLER`), §5.5, invariantes
2/7/9/10, §7, §9.3, §9.4, §9.7, §9.8, §10, §12.6; `MVP_SCOPE.md` §3.4
(riesgo ALTO); `DECISIONES_PENDIENTES.md` A7, B5; `state/AMBIGUITIES.md`
AMB-5, AMB-10 (ya resueltas); `backend/prisma/schema.prisma` (modelos
`CashRegisterSession`/`CashMovement`, ya en la base desde la fase 01).

---

## 1. Responsabilidad

Este módulo es dueño de:

- El **turno de caja** (`cash_register_sessions`): apertura, cierre con
  arqueo, y la detección de una sesión olvidada abierta de un día
  anterior.
- El **libro de movimientos de efectivo** (`cash_movements`) — vía un
  único servicio (nombre propuesto: `cash-register.service.ts`), mismo
  principio que CLAUDE.md regla 4 aplica a `stock.service.ts`: es el
  único punto del sistema que escribe `cash_movements`. Ningún otro
  módulo inserta ahí directo con Prisma.
- Los dos movimientos que se originan **acá mismo**, sin venir de otro
  módulo: `INGRESO_MANUAL` y `RETIRO` (T3.3).
- Exponer la **API interna** (sección 4.2) que `sales`, `returns` y
  `expenses` —módulos futuros— van a usar para registrar sus propios
  movimientos de caja (`VENTA`, `DEVOLUCION`, `ANULACION`, `GASTO`) sin
  duplicar la lógica de signo ni la validación de sesión abierta.

**Qué NO hace este módulo:**

- No decide si un pago o un reintegro es en efectivo — esa es
  responsabilidad de quien llama (`sales`/`returns`, AD-8): el
  contrato interno de este módulo (sección 4.2) recibe ya filtrado
  "esto es efectivo, registralo", nunca inspecciona `payments.metodo`
  por su cuenta.
- No crea ventas, devoluciones ni gastos. Cuando esos módulos se
  construyan, cada uno abre su propia transacción y este módulo
  participa como un paso más dentro de ella (mismo patrón que
  `stock.service.ts`, ver sección 4.2 y 5).
- No calcula resultados ni márgenes — eso es `resultados` (Etapa 6).
  Este módulo expone `monto_sistema`/`diferencia` **por sesión**, no
  agregados por período.
- No factura ni emite comprobantes (AD-11, fuera de alcance de todo el
  sistema).

## 2. Reglas de negocio

Numeradas para referenciarlas desde tickets y tests.

**RN-1.** Apertura: monto inicial declarado por quien abre. **No puede
haber dos sesiones `ABIERTA` a la vez** — ya garantizado a nivel de
base desde la fase 01 (`cash_register_sessions_one_open_key`, índice
único parcial sobre `estado = 'ABIERTA'`). El servicio no necesita
reimplementar esta exclusión, solo traducir la violación de esa
constraint a un mensaje de negocio (409).

**RN-2.** Varios vendedores comparten la misma sesión de caja (§5.5:
"hay una sola caja física") — no existe un concepto de "mi sesión" vs
"la de otro". Cualquier usuario autenticado con permiso para una
acción dada (ver sección 8) puede operar sobre la sesión `ABIERTA`
actual, la haya abierto quien la haya abierto. Cada movimiento igual
registra `userId` (auditoría, no restricción de acceso).

**RN-3.** Convención de signo obligatoria (§3.6), ya reforzada con un
`CHECK` en la base desde la fase 01
(`cash_movements_monto_sign_check`): `VENTA` e `INGRESO_MANUAL` siempre
positivos; `DEVOLUCION`, `ANULACION`, `GASTO` y `RETIRO` siempre
negativos. **El servicio nunca debe confiar en que quien lo llama mande
el signo correcto** — recibe siempre un monto **positivo** (una
cantidad, no un signo) más el `tipo`, y es el propio servicio quien
aplica el signo según la tabla de arriba antes de insertar. Así ningún
caller puede violar el `CHECK` por error, y el `CHECK` queda como
defensa en profundidad, no como la única barrera.

**RN-4.** Cierre con arqueo: la persona declara `monto_declarado`
(lo que contó). El sistema calcula
`monto_sistema = monto_inicial + SUM(cash_movements.monto)` de esa
sesión, y `diferencia = monto_declarado - monto_sistema` (invariante
2). Este cálculo tiene que poder repetirse en cualquier momento,
también con la sesión todavía `ABIERTA` (invariante 2, literal) — no
es exclusivo del cierre.

**RN-5.** La diferencia **no bloquea el cierre** (AMB-5, RESUELTA). Si
`|diferencia| >= umbral_diferencia_caja` (AMB-10, RESUELTA: **$500**
fijos, no porcentaje) **y quien cierra es `OWNER`**, `nota_cierre` es
obligatoria (400 si falta). La comparación es sobre el valor absoluto:
tanto un sobrante de $500 como un faltante de $500 exigen nota.

**RN-6. Cierre a ciegas (§5.5, §5.1 literal — "SELLER no accede a...
cierre de caja con totales").** Un `SELLER` **puede** cerrar la sesión
(declarar el efectivo contado) pero:
- Nunca ve `monto_sistema` ni `diferencia`, ni en la respuesta de la
  API ni en ningún otro endpoint de este módulo, sea la sesión propia,
  ajena, abierta o cerrada.
- Nunca se le exige `nota_cierre` — exigirla revelaría que existe una
  diferencia, lo mismo que se le está ocultando (§5.5, literal). En su
  lugar, el formulario le ofrece un campo neutral y **opcional**
  ("¿algo para comentar del turno?") que se guarda en el mismo
  `nota_cierre` si lo completa.
- La nota real (si la diferencia la amerita) la completa **después**
  un `OWNER`, editando esa misma sesión ya cerrada — ver sección 6,
  edge case de sesión cerrada por `SELLER` con diferencia relevante.

**RN-7. Sesión olvidada abierta (§5.5, A7).** No hay una regla de
"detección" activa aparte: como solo puede existir una sesión
`ABIERTA` a la vez (RN-1), el mecanismo es simplemente que **nadie
puede abrir una sesión nueva mientras exista cualquier otra
`ABIERTA`** — sea de hoy o de un día anterior. Lo que cambia es la
interfaz: el frontend, al recibir la sesión abierta actual, compara su
`fecha_apertura` contra "hoy" en **hora argentina** (AD-13) y, si no
coinciden, la presenta como "sesión olvidada de [fecha]" con un aviso
y fuerza el flujo de cierre antes de dejar operar — nunca se cierra
sola.

**RN-8. Inmutabilidad tras el cierre (§5.5, literal: "se bloquea a
nivel de base de datos").** Ningún `cash_movements` puede insertarse
con `session_id` de una sesión `CERRADA` — ni desde este módulo
(`INGRESO_MANUAL`/`RETIRO`) ni desde la API interna que usarán
`sales`/`returns`/`expenses`. Ver sección 6 (gap real encontrado: hoy
solo está protegido a nivel de aplicación, falta el refuerzo de base) y
sección 11 (a qué ticket corresponde cerrarlo).

**RN-9.** Solo los pagos/reintegros de método `EFECTIVO` generan
`cash_movements` (AD-8, invariante 7) — tarjeta, transferencia y
`CREDITO_DEVOLUCION` no tocan el cajón. Esta regla la aplican
`sales`/`returns` al decidir SI llaman al contrato interno de este
módulo (sección 4.2); este módulo no la re-valida porque no tiene
visibilidad de `payments.metodo`.

**RN-10.** Ninguna venta ni devolución se registra sin sesión de caja
`ABIERTA` (invariante 10). Este módulo expone el mecanismo para que
`sales`/`returns` lo verifiquen (sección 4.2,
`getSesionAbiertaOrThrow`) — la decisión de a qué HTTP status traducir
"no hay sesión abierta" es de esos módulos, no de este.

**RN-11.** Un `expense` pagado en efectivo desde la caja **sí**
necesita sesión abierta; uno pagado por transferencia **no** la
necesita (invariante 10, literal — "la dueña puede pagar el alquiler
un domingo desde su casa"). Mismo razonamiento que RN-9: la decisión
la toma `expenses` al construirse (Etapa 6), este módulo solo expone
el mecanismo.

**RN-12.** Ingreso manual y retiro de efectivo son idempotentes (AD-10,
§9.7 — **es el ejemplo textual del blueprint**: "un doble click en un
retiro de $50.000 lo registra dos veces y el arqueo muestra un
faltante fantasma"). Usan el interceptor común de T0.14 (ya VERDE).

## 3. Invariantes

De la sección 6 del blueprint, los que este módulo garantiza
directamente:

- **Invariante 2** — `monto_sistema == monto_inicial + SUM(cash_movements.monto)`,
  recalculable en cualquier momento, sesión abierta o cerrada. Lo
  garantiza el propio cálculo (RN-4), no una columna que se vaya
  incrementando con cada movimiento — **no existe un "saldo corriente"
  almacenado**, se computa on-demand con un `SUM`. Esto evita que un
  bug de actualización incremental deje el contador desincronizado de
  la suma real (mismo espíritu que AD-4 para stock, pero acá se optó
  por *no* denormalizar en absoluto, a diferencia de `stock_actual`,
  porque no hay una lectura de alta frecuencia que lo justifique — el
  arqueo se calcula una vez por cierre, no en cada operación).
- **Invariante 9** — nunca hay más de una sesión `ABIERTA` (RN-1), ya
  reforzado con el índice único parcial de la fase 01.
- **Invariante 10** (la mitad que le toca) — expone el mecanismo para
  que `sales`/`returns` no puedan operar sin sesión abierta (RN-10).
  La otra mitad (gastos, condicional a medio de pago) es RN-11, para
  cuando exista `expenses`.

Los que **no** garantiza este módulo pero cuya correctitud depende
parcialmente de él:

- **Invariante 7** (solo `EFECTIVO` mueve caja) — depende de que
  `sales`/`returns` filtren bien antes de llamar (RN-9); este módulo
  no tiene forma de detectar un mal uso de su propio contrato desde
  adentro.

No numerada en la sección 6 pero con el mismo peso — el `CHECK` de
signo de `cash_movements` (§3.6) es lo que garantiza, a nivel de base,
que ningún movimiento pueda romper la aritmética que el invariante 2
da por sentada (RN-3).

## 4. Contratos de API

### 4.1 Endpoints REST

Prefijo `/cash-registers`. Todos requieren sesión (`AuthGuard`
global); el rol exigido se indica por endpoint (sección 8 tiene la
matriz completa). Los campos que se omiten según rol se marcan
explícitamente.

| Método | Ruta | Rol | Body | Notas |
|---|---|---|---|---|
| POST | `/cash-registers/sessions` | cualquiera autenticado (RN-2, §5.5: tiene que poder abrir sola una vendedora) | `{ montoInicial }` | 201 con la sesión creada. 409 si ya hay una `ABIERTA` (RN-1) — el mensaje debe alcanzar para que el frontend decida si mostrarla como "turno de hoy, ya abierto" o como sesión olvidada (RN-7, comparando `fechaApertura` contra hoy en hora AR) |
| GET | `/cash-registers/sessions/open` | cualquiera autenticado | — | la sesión `ABIERTA` actual con `montoSistema` recalculado al momento de la consulta (invariante 2), o 404 si no hay ninguna. **`SELLER`: `montoSistema`/`diferencia` omitidos** (RN-6) — `diferencia` no aplica igual a una sesión abierta (no hay `montoDeclarado` todavía), pero `montoSistema` sí, y también se omite |
| GET | `/cash-registers/sessions/:id` | cualquiera autenticado | — | detalle de una sesión (abierta o cerrada). Mismo ocultamiento de `montoSistema`/`diferencia` para `SELLER` que en `open` |
| GET | `/cash-registers/sessions/:id/movements` | cualquiera autenticado | — | paginado (RN-2: visibilidad operativa compartida, no hay noción de "movimientos propios"). Cada fila trae `tipo`/`monto`/`descripcion`/`fecha`/`userId` — nunca se agrega ahí un total corrido, eso sería reconstruir `montoSistema` a mano para `SELLER` |
| POST | `/cash-registers/sessions/:id/close` | cualquiera autenticado (RN-6, "cierre a ciegas") | `{ montoDeclarado, notaCierre? }` | 200 con la sesión cerrada. Para `OWNER`: incluye `montoSistema`/`diferencia`; **400 si `|diferencia| >= 500` y falta `notaCierre`** (RN-5). Para `SELLER`: `notaCierre` siempre opcional, respuesta sin `montoSistema`/`diferencia` (RN-6). 409 si la sesión ya está cerrada o no es la actual |
| POST | `/cash-registers/movements/ingreso` | **a definir (AMB-13)** | `{ monto, descripcion }` + header `Idempotency-Key` | RN-12. 409 si no hay sesión abierta. `monto > 0` (positivo — el servicio aplica el signo, RN-3) |
| POST | `/cash-registers/movements/retiro` | **a definir (AMB-13)** | `{ monto, descripcion }` + header `Idempotency-Key` | RN-12. Mismas validaciones que ingreso. **Sin tope contra el efectivo disponible** — ver sección 6, edge case explícito |

**Fuera de alcance de este módulo, a propósito:** un listado histórico
de sesiones pasadas (más allá de `GET /sessions/:id` puntual) no tiene
ningún ticket en T3.1–T3.7 — la consulta agregada por período es
trabajo de `resultados` (Etapa 6, §5.6, acceso solo `OWNER`). Si hace
falta antes, es una ampliación de alcance a decidir, no algo que esta
fase da por incluido.

### 4.2 API interna de `cash-register.service.ts` (no HTTP)

Para que `sales`, `returns` y `expenses` (módulos futuros) puedan
cumplir CLAUDE.md regla 4 (aplicada acá a movimientos de caja, no solo
de stock) sin duplicar lógica. Firma propuesta (ajustable en la propia
fase 06 de cada uno, pero el contrato básico queda fijado acá para no
romper esta fase cuando lleguen):

```ts
class CashRegisterService {
  // Usado por este módulo (T3.1, T3.2, T3.3, T3.4):
  abrirSesion(tx, { montoInicial, userId }): Promise<CashRegisterSession>
  cerrarSesion(tx, { sessionId, montoDeclarado, notaCierre, userId, esOwner }): Promise<CashRegisterSession>
  registrarMovimientoManual(tx, { sessionId, tipo: 'INGRESO_MANUAL' | 'RETIRO', monto, descripcion, userId, idempotencyKey }): Promise<CashMovement>

  // Expuesto para sales/returns/expenses (no se llama desde este módulo):
  getSesionAbiertaOrThrow(tx): Promise<CashRegisterSession>
  registrarMovimiento(tx, {
    sessionId, tipo: 'VENTA' | 'DEVOLUCION' | 'ANULACION' | 'GASTO' | 'INGRESO_MANUAL' | 'RETIRO',
    monto, referenciaTipo, referenciaId, descripcion, userId, idempotencyKey,
  }): Promise<CashMovement>
}
```

**Corrección post-spec (T3.3, implementación):** el diseño original de
esta sección no devolvía nada (`Promise<void>`) ni pedía
`idempotencyKey` en `registrarMovimientoManual` — quedó corregido acá
al descubrir, implementando T3.3, que `withIdempotency` (T0.14)
necesita comparar la fila recién insertada contra la encontrada por
clave duplicada, lo que exige devolver la fila real. `idempotencyKey`
quedó como campo **opcional** en `registrarMovimiento` (T3.4+ lo puede
usar o no según haga falta) y **obligatorio** en
`registrarMovimientoManual` (T3.3 siempre lo necesita, es la única
vía de idempotencia de esos dos tipos). `registrarMovimientoManual` no
duplica lógica: llama internamente a `registrarMovimiento` con
`tipo` acotado a `'INGRESO_MANUAL' | 'RETIRO'`.

Todos los métodos **exigen recibir el `tx` de una transacción ya
abierta** por quien llama (no abren la suya propia) — porque en
`sales`, el movimiento de caja es el **último paso** dentro de la
transacción completa de la venta (§5.3: validar caja abierta → validar
stock → crear venta → pagos → descontar stock → **caja**), no una
operación aislada. Mismo contrato que `stock.service.ts` ya estableció
para `products`/`variants` (`modulo-products-variants-spec.md`,
sección 4.2).

`monto` siempre viaja **positivo** hacia el servicio (RN-3) —
`registrarMovimiento`/`registrarMovimientoManual` aplican el signo
según `tipo` antes de insertar. Esto es deliberado: si el contrato
exigiera que el caller ya mandara el signo, cualquier bug en `sales`
(mandar `-total` en vez de `total` para una `VENTA`) rompería el
`CHECK` de la base de una forma menos obvia de diagnosticar que un
error de validación explícito en este servicio.

`getSesionAbiertaOrThrow` lanza si no hay sesión `ABIERTA` — la
traducción a 409/422 HTTP es responsabilidad de quien la llama (RN-10),
este servicio no conoce el contexto HTTP de quien lo invoca.

## 5. Transacciones y concurrencia

- **Apertura:** no necesita `SELECT ... FOR UPDATE` — el índice único
  parcial (`estado = 'ABIERTA'`) actúa como la exclusión mutua real a
  nivel de base. Dos aperturas concurrentes: una inserta, la otra
  choca contra el índice único (violación de constraint, se traduce a
  409). No hay una fila existente que bloquear porque es una
  inserción, no una actualización.
- **Movimientos individuales (`registrarMovimiento`/
  `registrarMovimientoManual`):** a diferencia de `stock.service`, acá
  **no hay un contador denormalizado que incrementar** (invariante 2
  se recalcula con `SUM`, nunca se guarda) — insertar un
  `cash_movements` no valida contra ningún saldo previo (no existe una
  regla "no dejar el saldo en negativo" para caja, ver sección 6). Eso
  significa que insertar movimientos en sí **no tiene una condición de
  carrera clásica de lectura-modificación-escritura** entre sí: dos
  `INGRESO_MANUAL` simultáneos no compiten, cada uno inserta su propia
  fila sin necesidad de bloquear nada.
- **Pero sí hay una carrera real entre "insertar un movimiento" y
  "cerrar la sesión" simultáneamente**, y es el punto más delicado de
  este módulo: sin coordinación, un `INGRESO_MANUAL` y un cierre
  concurrentes pueden intercalarse de forma que (a) el cierre calcule
  `monto_sistema` sin ver ese movimiento (porque el `SUM` corrió antes
  de que el `INSERT` hiciera commit), pero el movimiento igual quede
  insertado después contra una sesión que ya pasó a `CERRADA`
  (violando RN-8), o (b) el movimiento se rechace correctamente pero
  el cierre haya usado un `SUM` parcial de todos modos. **Patrón
  obligatorio (mismo principio que BLUEPRINT §9.4 para stock, aplicado
  acá a una fila de sesión en vez de una de variante):**
  `cerrarSesion` toma `SELECT id FROM cash_register_sessions WHERE id
  = $1 FOR UPDATE` **antes** de calcular el `SUM`, y
  `registrarMovimiento`/`registrarMovimientoManual` toman el **mismo
  lock** sobre esa fila de sesión antes de insertar y de verificar que
  siga `ABIERTA`. Así, quien llegue primero bloquea al otro hasta
  terminar: o el movimiento se inserta y el cierre (que espera el
  lock) lo ve reflejado en su `SUM`, o el cierre gana primero y el
  movimiento que llega después ve `estado = CERRADA` y se rechaza —
  nunca el estado intermedio inconsistente.
- **Los números de sesión** no existen como tales (a diferencia de
  `sales.numero`/`returns.numero`) — el `id` autoincremental alcanza,
  no hay un "número de arqueo" visible al público que deba generarse
  con una secuencia separada.
- **Constraint única de sesión abierta y `CHECK` de signo:** las
  defensas reales contra corrupción de datos a nivel de base, mismo
  patrón que `auth`/`products` (capturar la violación y traducirla a
  un mensaje de negocio, nunca dejar pasar el error crudo de Prisma).

## 6. Edge cases

- **Cierre con `montoDeclarado == montoSistema` exacto:** `diferencia
  = 0`, no exige nota, cierra limpio — camino feliz.
- **Diferencia exactamente igual al umbral ($500 exactos, a favor o en
  contra):** exige nota (RN-5: `>=`, no `>`) — mismo criterio de "caso
  límite" que el invariante 5 de stock (`stock_actual >= 0`, no `> 0`).
- **`montoInicial = 0`:** válido — un turno puede arrancar sin cambio
  en caja. El DTO valida `>= 0`, nunca negativo (no tiene sentido
  físico "empezar el día con -$500 en el cajón").
- **Intentar abrir una sesión habiendo una `ABIERTA`** (de hoy o de un
  día anterior): 409 — es el mecanismo real detrás de RN-7 (sesión
  olvidada), no una detección separada.
- **Retiro por un monto mayor al efectivo que debería haber en
  caja** (dejaría `monto_sistema` calculado en negativo si se
  recalculara ahora): **se permite, sin ningún tope.** A diferencia de
  stock (invariante 5, `stock_actual >= 0` salvo excepción explícita),
  el blueprint **no** define ningún invariante análogo para caja — la
  filosofía del módulo es "registrar la realidad y dejar que el arqueo
  la explique después" (mismo espíritu que AMB-5: la diferencia no
  bloquea, se registra). Confirmado explícitamente acá para que
  nadie lo interprete como un olvido y agregue una validación que el
  blueprint no pide.
- **`SELLER` cierra una sesión con diferencia real por encima del
  umbral:** cierra igual (RN-6), sin nota obligatoria. La sesión queda
  `CERRADA` con `diferencia` calculada y guardada (el dato existe,
  simplemente no se le muestra a quien cerró) pero **sin
  `nota_cierre`** — un `OWNER` que revise después ve la diferencia sin
  explicación y **puede completar la nota accediendo a esa sesión ya
  cerrada** (necesita, entonces, una vía de edición de `nota_cierre`
  *después* del cierre, exclusiva de `OWNER` — no está en ningún
  ticket de T3.1–T3.7 tal como están hoy; ver sección 11, posible gap
  de alcance a confirmar, no algo que yo agregue por mi cuenta).
- **`descripcion` vacía en un ingreso/retiro manual:** rechazada en el
  DTO (400) — la columna es `NOT NULL` sin default en el schema, y un
  movimiento sin explicación es tan inútil para el arqueo como un
  ajuste de stock sin motivo (mismo principio que RN-5 de
  `products`/`variants`).
- **Doble click en un retiro** (el ejemplo textual del blueprint,
  §9.7): protegido por `Idempotency-Key` + T0.14 (RN-12) — la segunda
  request con la misma clave devuelve la operación original con 200,
  nunca inserta un segundo movimiento.
- **Un movimiento de `sales`/`returns`/`expenses` llega cuando la
  sesión que tenían al validar ya se cerró** (carrera real: alguien
  cerró caja mientras una venta estaba a mitad de su propia
  transacción): `registrarMovimiento` lo rechaza (RN-8, sección 5) — la
  venta completa debe fallar y revertirse (todo dentro de una sola
  transacción, la de `sales`), no quedar "a medias" con stock
  descontado pero sin su movimiento de caja. Este comportamiento lo
  define este módulo; la Fase 06 de `sales` decide qué le muestra al
  usuario cuando eso pasa.

## 7. Errores

| Situación | Status | Mensaje al usuario |
|---|---|---|
| Ya hay una sesión de caja abierta (al intentar abrir otra) | 409 | "Ya hay una sesión de caja abierta" |
| Sesión inexistente | 404 | "Sesión de caja no encontrada" |
| Cerrar/operar sobre una sesión que ya está cerrada | 409 | "Esta sesión de caja ya está cerrada" |
| `montoInicial` negativo | 400 | "El monto inicial no puede ser negativo" |
| Falta `notaCierre` con diferencia ≥ $500 (solo cuando cierra `OWNER`) | 400 | "La diferencia es de $N: agregá una nota explicando qué pasó" |
| Ingreso/retiro sin sesión abierta | 409 | "No hay una sesión de caja abierta" |
| Ingreso/retiro con `monto <= 0` | 400 | "El monto tiene que ser mayor a 0" |
| Ingreso/retiro sin `descripcion` | 400 | "Ingresá una descripción para el movimiento" |
| Rol insuficiente (según resuelva AMB-13 / intento de ver totales siendo `SELLER`) | 403 / campo omitido | mensaje genérico de `RolesGuard`, o simplemente el campo no viaja en la respuesta (RN-6, no es un error, es una omisión) |

Todos pasan por el `GlobalExceptionFilter` ya construido en `auth` —
nada nuevo que construir ahí.

## 8. Permisos

| Acción | `OWNER` | `SELLER` |
|---|---|---|
| Abrir sesión | ✅ | ✅ (§5.5: tiene que poder operar sola) |
| Ver la sesión abierta actual / su detalle | ✅ | ✅ — sin `montoSistema`/`diferencia` (RN-6) |
| Ver el listado de movimientos de una sesión | ✅ | ✅ (RN-2, visibilidad operativa compartida) |
| Ver `montoSistema` / `diferencia` (abierta o cerrada) | ✅ | ❌ (§5.1, literal: "cierre de caja con totales") |
| Cerrar sesión (declarar efectivo contado) | ✅ | ✅ (§5.5, "cierre a ciegas") |
| Nota de cierre | ✅ (obligatoria si `\|diferencia\| >= 500`) | ✅ (opcional, campo neutral, nunca obligatoria) |
| Ingreso manual de efectivo | **a definir (AMB-13, recomendado `OWNER`-only)** | **a definir** |
| Retiro de efectivo | **a definir (AMB-13, recomendado `OWNER`-only)** | **a definir** |
| Completar `notaCierre` de una sesión ya cerrada por un `SELLER` con diferencia sin explicar | ✅ (ver sección 6, posible gap de alcance) | ❌ |

## 9. Tests necesarios

- **`cash-register.service.ts` — tests primero (§9.8, excepción plata/
  stock/caja, textual: "en los tickets de sales, returns,
  cash-registers y el servicio de stock, los tests se escriben
  primero").** Escritos y en rojo antes de implementar, derivados de
  RN-1 a RN-12 e invariante 2. Incluye el caso de concurrencia
  movimiento-vs-cierre de la sección 5 (mismo patrón de prueba que la
  fase 08 de `auth` para el último `OWNER` activo, y que T2.4 de
  `stock` para el ajuste negativo concurrente).
- **Unitarios:** cálculo de `montoSistema`/`diferencia`, decisión de
  exigir nota (umbral + rol), aplicación del signo según `tipo`,
  ocultamiento de campos para `SELLER` (mismo patrón que `costoActual`
  en `variants`).
- **Integración (Postgres real):**
  - Dos aperturas concurrentes → una 201, la otra 409 (constraint
    única, ya en la base desde la fase 01).
  - Insertar un movimiento con signo contrario al que exige su `tipo`
    directamente contra Prisma (sorteando el servicio) → el `CHECK` de
    la base lo rechaza — confirma que la defensa de base funciona
    independientemente del servicio.
  - Cierre calcula `montoSistema` correctamente con una sesión con
    varios movimientos de distintos tipos.
  - Cierre con diferencia `>= 500` sin `notaCierre`, cerrando un
    `OWNER` → 400. Mismo caso cerrando un `SELLER` → 201, sin exigir
    nada.
  - `GET /cash-registers/sessions/:id` con sesión `SELLER` → respuesta
    sin `montoSistema`/`diferencia`.
  - Intento de insertar un movimiento contra una sesión `CERRADA`
    (tanto vía `INGRESO_MANUAL`/`RETIRO` como simulando la API interna)
    → rechazado.
  - **Test de concurrencia explícito:** un `INGRESO_MANUAL` y un
    cierre disparados simultáneamente sobre la misma sesión, repetido
    varias iteraciones — verificar que nunca queda un movimiento
    insertado con `session_id` de una sesión que terminó `CERRADA` sin
    contarlo en su `montoSistema` (mismo patrón que el test de
    concurrencia de `stock.service` en T2.4, adaptado al lock de
    sesión de la sección 5).
  - Doble click en un retiro (misma `Idempotency-Key`) → un solo
    `cash_movements`, la segunda request devuelve 200 con el resultado
    original.
- **Test del invariante 2 dedicado (T3.6):** recorre varias sesiones
  cerradas de una base de prueba con movimientos variados y verifica
  `monto_sistema == monto_inicial + SUM(cash_movements.monto)` para
  cada una — no alcanza con probarlo sesión por sesión en los tests de
  arriba, tiene que correr como chequeo agregado (mismo patrón que
  T2.8 para el invariante 1 de stock).
- **Mutación (Stryker):** obligatorio sobre
  `cash-register.service.ts` — nombre literal en la lista de
  BLUEPRINT §9.8 ("`sales`, `stock`, `cash-registers`, `returns`,
  `results`"). Se corre en la fase de QA adversarial (08), no acá.
- **E2E (Playwright):** abrir caja con monto inicial, hacer un ingreso
  manual, cerrar con arqueo — flujo #3 de `MVP_SCOPE.md` §7 ("vender,
  cobrar y cerrar caja"). Se construye en la Fase 14, no en este
  módulo (y depende de que `sales` también exista para el flujo
  completo).

## 10. Ambigüedades

Una pregunta nueva para el PO, agregada a `state/AMBIGUITIES.md` como
AMB-13 (detalle completo ahí, resumen acá):

- **AMB-13 (⚠️ ALTO RIESGO, PENDIENTE).** ¿Un `SELLER` puede hacer un
  ingreso manual o un retiro de efectivo, o son exclusivos de `OWNER`?
  El blueprint no dice nada al respecto — a diferencia de la apertura/
  cierre de sesión (que sí tienen que estar abiertos a cualquiera por
  necesidad operativa explícita, §5.5), mover efectivo sin un
  comprobante automático detrás es la operación de mayor riesgo de mal
  uso de todo el módulo. **Recomendación: `OWNER`-only para las dos**,
  consistente con el resto de las acciones "con plata de por medio y
  sin comprobante automático" del sistema (ajuste de stock,
  ingreso de mercadería, edición de precio/costo — todas `OWNER`-only
  por AMB-11 o por el blueprint mismo). **Bloquea a T3.3.**

Las dos ambigüedades que ya tocaban a este módulo desde la fase 03
(AMB-5, diferencia no bloquea el cierre; AMB-10, umbral en $500 fijos)
llegan **RESUELTAS** — no generan trabajo pendiente acá, ya están
incorporadas en las reglas de negocio de la sección 2 (RN-5).

## 11. Tickets

### Hallazgo técnico bloqueante: `T4.4`, `T4.7` y `T5.3` no listaban `T3.2` como dependencia

BLUEPRINT §5.3 (paso 7: "si algún pago es `EFECTIVO`, crear un
`cash_movements`") y la regla de anulación de esa misma sección, más
§5.4 (reintegro en efectivo → `cash_movements` negativo), dejan claro
que `sales` y `returns` necesitan llamar a la API interna de este
módulo (sección 4.2) para cumplir CLAUDE.md regla 4 aplicada a caja.
`ROADMAP.md` listaba esa dependencia correctamente para `T6.3`
(gastos: `T6.2, T3.2`) pero **no** para `T4.4` (pagos de venta),
`T4.7` (anulación) ni `T5.3` (reintegro de devolución) — las tres
solo listaban su dependencia dentro de la propia Etapa 4/5. **No
corresponde que yo lo decida por mi cuenta** (es una dependencia
técnica real, no una ambigüedad de negocio) — corregido directamente
en `ROADMAP.md`, agregando `T3.2` a las tres.

### Ticket nuevo: no se agrega ninguno

A diferencia de la fase 06 de `products`/`variants` (que agregó T2.13),
acá los siete tickets ya listados en `ROADMAP.md` (T3.1–T3.7) cubren
el módulo completo tal como lo describe BLUEPRINT §3.6/§5.5 — no se
identificó ninguna funcionalidad exigida por el blueprint que no
tuviera ticket. El único faltante posible (edición de `nota_cierre`
después del cierre por un `SELLER`, sección 6) es una **extensión de
alcance a confirmar con el PO**, no algo que el blueprint pida
explícitamente — lo dejo señalado, no lo agrego como ticket por mi
cuenta.

### Estado de las dependencias, confirmado contra `state/STATUS.md`

- **T1.3** (guards de `auth`): VERDE. T3.1 puede arrancar ya.
- **T0.14** (interceptor de idempotencia): VERDE. No bloquea a T3.3
  más allá de AMB-13.
- **T0.13** (`settings` + seed): sigue **PENDIENTE**. Bloquea a T3.4
  (necesita `umbral_diferencia_caja` sembrado) pero no a T3.1–T3.3. AMB-10
  ya está resuelta ($500), así que T0.13 puede ejecutarse sin esperar
  nada más de este módulo.
- **AMB-13** (nueva, esta fase): **PENDIENTE**. Bloquea a T3.3
  únicamente — T3.1, T3.2 y T3.4–T3.7 no dependen de su respuesta.

**Orden recomendado, sin reordenar toda la etapa:** T3.1 → T3.2 pueden
arrancar de inmediato. T3.3 espera la resolución de AMB-13. T3.4 espera
T0.13 (recomiendo ejecutarlo en paralelo, no depende de nada de este
módulo). T3.5–T3.7 siguen su orden declarado en `ROADMAP.md`.

**Gap de invariante encontrado (RN-8, sección 6):** la migración de la
fase 01 ya tiene el `CHECK` de signo y el índice único de sesión
abierta, pero **no** un trigger (ni ningún otro mecanismo de base) que
impida escribir `cash_movements` con `session_id` de una sesión
`CERRADA` — hoy esa protección solo existiría a nivel de aplicación
(dentro de `registrarMovimiento`, verificando `estado` bajo el lock de
la sección 5). BLUEPRINT §5.5 pide explícitamente que se bloquee "a
nivel de base de datos". **Corresponde a T3.2**: agregar el trigger (o
constraint equivalente) como parte de esa migración, junto con el
servicio que ya necesita el mismo chequeo a nivel de aplicación de
todos modos (defensa en profundidad, mismo criterio que el resto del
sistema — la constraint de base nunca es la única barrera, pero
tampoco falta).

---

**Módulo bloqueado hasta resolver AMB-13** (solo afecta a T3.3) y
hasta ejecutar T0.13 (solo afecta a T3.4). **T3.1 y T3.2 pueden
arrancar ya.**
