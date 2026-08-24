# QA adversarial — módulo `cash-registers` (2026-08-24)

Fase 08 del protocolo. Objetivo: romper el módulo, no confirmar que
funciona. Alcance: T3.1–T3.7 (`CashRegisterService`,
`CashRegistersController`, `CashRegisterPage.tsx` y sus componentes),
ya en VERDE desde la fase 07 (`fase07-cierre-cash-registers`).

Los dos hallazgos de severidad real que se encontraron abajo **ya están
corregidos y probados** en este mismo pase, confirmados empíricamente
contra el servidor de desarrollo real antes de escribir cualquier test
(no se asumió el bug leyendo código — se reprodujo primero).

---

## Hallazgo 1 — `montoDeclarado` negativo se aceptaba sin validar

```
SEVERITY: HIGH
REPRODUCTION: POST /cash-registers/sessions/:id/close con
  { "montoDeclarado": "-50.00" } sobre una sesión ABIERTA real.
EXPECTED: 400 — "contar" efectivo negativo no tiene sentido físico,
  mismo criterio que ya aplicaba a `montoInicial` (sección 6 de la
  spec del módulo).
ACTUAL: 200. La sesión cerraba igual, con `montoDeclarado: "-50"` y
  una `diferencia` calculada sin ningún significado real (confirmado
  contra el servidor real antes del fix: diferencia de -150 sobre una
  sesión con montoSistema=100).
ROOT CAUSE: `cerrarSesion()` nunca validaba el signo de
  `montoDeclarado` — a diferencia de `abrirSesion()`, que sí rechaza
  `montoInicial` negativo desde T3.1. `CloseSessionDto` solo tiene
  `@IsDecimal(...)` (valida formato, no signo). La UI real
  (`CloseSessionModal.tsx`) tiene `min={0}` en el `NumberInput`, así
  que este bug NO era alcanzable desde la pantalla construida en
  T3.7 — solo desde un cliente HTTP directo (curl, Postman, un script)
  que ignore esa restricción del lado del cliente. Por eso igual
  bloquea: BLUEPRINT §9 exige que la autorización (y, por el mismo
  principio, la validación de datos) se verifique siempre en el
  servidor, nunca solo en el cliente.
FIX: `cerrarSesion()` rechaza `montoDeclarado` negativo antes de tomar
  el lock de la sesión (es un error del input, no depende de su
  estado) — mismo mensaje/patrón que `abrirSesion()`. Ver
  `cash-register.service.ts`, líneas 315-319.
VERIFICADO: reproducido primero contra Postgres real (200 con
  diferencia sin sentido); después del fix, 400 real vía HTTP, la
  sesión queda intacta (`estado: ABIERTA`, `montoDeclarado: null`).
  1 test unitario + 1 de integración nuevos, específicos de este
  hallazgo (esta fase agregó más tests además de estos dos, pero por
  cobertura de mutación — ver esa sección abajo).
```

## Hallazgo 2 — un monto que excede la precisión de la columna tiraba 500 crudo

```
SEVERITY: MEDIUM
REPRODUCTION: POST /cash-registers/sessions con
  { "montoInicial": "99999999999999.00" } (o el mismo valor en
  montoDeclarado/monto de un ingreso-retiro).
EXPECTED: 400 — un input inválido nunca debería producir un 500.
ACTUAL: 500 "Error interno del servidor", confirmado contra el
  servidor real. El error de Postgres subyacente: "numeric field
  overflow" (código 22003, "A field with precision 12, scale 2 must
  round to an absolute value less than 10^10"), envuelto por Prisma
  como `PrismaClientUnknownRequestError` — SIN `.code` traducible
  como P2002/P2003, así que el patrón ya establecido en el resto del
  sistema (capturar el código conocido y traducirlo a un mensaje de
  negocio) no alcanza acá: no hay ningún código que capturar.
ROOT CAUSE: `montoInicial`/`montoDeclarado`/`monto` son
  `Decimal(12, 2)` en la base (máximo absoluto representable
  9999999999.99). Ningún DTO valida magnitud (`@IsDecimal` valida
  formato, no rango) y ningún servicio la validaba tampoco — el valor
  llegaba crudo a Postgres. A diferencia del Hallazgo 1, este SÍ era
  alcanzable desde la UI real: ninguno de los tres `NumberInput` de
  dinero de este módulo (`OpenSessionForm`, `CloseSessionModal`,
  `ManualMovementModal`) tiene un `max` — confirmado en el navegador
  real, tipeando "99999999999999" en "Monto inicial".
FIX: nueva función local `assertDentroDePrecision()` en
  `cash-register.service.ts` (no se tocó `common/money/money.util.ts`
  — mismo alcance que el resto de esta fase, dentro del módulo) que
  rechaza cualquier valor cuyo valor absoluto supere 9999999999.99,
  aplicada a los tres puntos de entrada (`abrirSesion`,
  `registrarMovimiento`, `cerrarSesion`) antes de tocar Prisma —
  mismo principio que `assertPositive`/`isNegative()` ya usan para
  evitar que un `CHECK` crudo de la base llegue sin traducir.
VERIFICADO: reproducido primero contra el servidor real (500 en los
  tres endpoints); después del fix, 400 real, sin fila creada.
  Confirmado además en el navegador real (Browser pane): el
  `OpenSessionForm` muestra "El monto inicial es demasiado grande" en
  un `Alert`, sin romper la pantalla ni perder el estado del
  formulario. 3 tests unitarios (uno por punto de entrada) + 2 de
  integración nuevos, específicos de este hallazgo.

NOTA FUERA DE ALCANCE (no corregida acá): `precioVenta`/`costoActual`/
  `costoUnitario` de `products`/`stock` usan la misma columna
  `Decimal(12, 2)` y con toda probabilidad tienen el mismo problema —
  no se tocó ese módulo (ya cerró su propia fase 08) ni se agregó un
  helper compartido en `common/money/` para esto; queda señalado para
  una decisión aparte (posible ticket de infraestructura transversal,
  no de un módulo puntual).
```

---

## Testing de mutación (obligatorio — BLUEPRINT §9.8 lista `cash-registers` literal)

Corrido con Stryker sobre `src/modules/cash-registers/**/*.service.ts`.

- **Antes** (con los tests de T3.1–T3.7, antes de cualquier cambio de
  esta fase): **62.32%** (86 matados, 31 sobrevivientes, 21 sin
  cobertura), por debajo del umbral del 80%.
  - 21 mutantes sin cobertura: 8 en el catch de `abrirSesion` que
    traduce P2002 a 409 (solo probado por integración, nunca a nivel
    unitario) y 13 en `getSesionAbiertaConTotales` — **este método no
    tenía NINGÚN test unitario**, solo integración (`GET
    /cash-registers/sessions/open`), pese a contener la lógica de
    ocultamiento de campos (RN-6) y el cálculo en vivo del invariante 2.
  - 31 sobrevivientes: mutaciones de la FORMA de los argumentos
    pasados a Prisma (`where`, `select`, `_sum`, `by`) sin aserción
    exacta (mismo patrón ya visto en la fase 08 de `stock`, T2.8);
    mutaciones del texto de los mensajes de error (nombre del campo);
    un `.trim()` removido sin que ningún test usara una descripcion
    solo-espacios; el spread `{...session}` de `hideOwnerOnlyFields`
    mutado a `{}` sin que ningún test verificara que el resto de los
    campos sobrevive; `notaCierre?.trim() || null` sin ningún test que
    verifique el recorte ni el default a `null`.
- **Después**: **98.55%** (136 matados, 2 sobrevivientes, 0 sin
  cobertura). Se agregaron:
  - Un `describe` completo nuevo para `getSesionAbiertaConTotales`
    (cálculo con/sin movimientos, ocultamiento SELLER, 404 sin sesión,
    forma exacta de las queries).
  - Tests del catch de `abrirSesion`: P2002 → 409; otro código Prisma
    → se propaga tal cual; un error con `.code === 'P2002'` que NO es
    `instanceof PrismaClientKnownRequestError` → se propaga tal cual
    (distingue el `&&` real de un `||` que traduciría por casualidad
    de forma).
  - `descripcion` solo-espacios → rechazada (prueba que hace falta
    `.trim()`, no alcanza con chequear no-vacío).
  - `notaCierre` con espacios → se guarda recortada; sin `notaCierre`
    → se guarda `null`, no `undefined` ni string vacío.
  - Aserciones `toHaveBeenCalledWith(...)` exactas (no
    `objectContaining`) sobre `where`/`select`/`_sum`/`by` de
    `registrarMovimiento`, `cerrarSesion`, `getSesionAbiertaOrThrow`,
    `getSesionAbiertaConTotales` y `reconciliar`.
  - Mensajes de error de los dos hallazgos de esta fase, con el
    nombre del campo incluido en la aserción (no solo "es demasiado
    grande" suelto).
- **2 sobrevivientes documentados, no forzados** (mismo criterio que
  BLUEPRINT/protocolo: "si la mutación es irrelevante, documentalo, no
  fuerces el número"): el texto literal del `$queryRaw` FOR UPDATE en
  `registrarMovimiento`/`cerrarSesion` (líneas 190 y 322). El mock de
  `tx.$queryRaw` en el archivo unitario resuelve el mismo valor sin
  importar el contenido de la query — mutar el SQL a un string vacío
  no cambia el comportamiento observable a nivel de mock. El
  comportamiento REAL que ese `$queryRaw` protege (el lock de fila que
  serializa un movimiento contra un cierre concurrente) sí está
  probado, pero contra Postgres real: el test de concurrencia agregado
  en la fase 07 (`cash-registers.integration.spec.ts`, 10 iteraciones)
  es la prueba empírica de que el lock funciona — a nivel de mock
  unitario, ese comportamiento es estructuralmente imposible de
  verificar sin un motor de base real detrás.
- Ningún mutante quedó sin clasificar por "código inalcanzable" —
  todos los sobrevivientes/sin-cobertura originales fueron matados o
  quedaron documentados arriba con su motivo.

## Otras pruebas adversariales sin hallazgos (comportamiento ya correcto)

- **Fallos a mitad de operación / rollback**: el rechazo de RN-5 (nota
  faltante con diferencia ≥ umbral) ocurre ANTES del
  `tx.cashRegisterSession.update(...)` — sin escritura parcial, la
  transacción completa de Nest (`prisma.$transaction` en el
  controller) revierte sin dejar la sesión en un estado intermedio.
  Confirmado leyendo el flujo completo de `cerrarSesion`, no solo
  asumido.
- **Datos huérfanos**: la corrupción provocada a propósito para
  probar el overflow (candidato inicial de este pase) no dejó ninguna
  fila creada — confirmado consultando la base después de cada intento
  fallido, antes de implementar el fix.
- **Requests duplicados (doble click real)**: ya cubierto por T3.3
  (`Idempotency-Key`) — reconfirmado sin cambios, sin necesidad de
  repetir la prueba (no se tocó esa lógica en esta fase).
- **IDOR / recursos ajenos**: no aplica — RN-2 (spec, sección 2):
  "no existe un concepto de 'mi sesión' vs 'la de otro'". Cualquier
  usuario autenticado con el rol correcto opera sobre LA sesión
  abierta actual, la haya abierto quien la haya abierto. Mismo criterio
  que la fase 08 de `products`.
- **Manipulación de IDs**: `/cash-registers/sessions/999999/close` →
  404 ("Sesión de caja no encontrada"), no 500 ni un error genérico
  (ya cubierto por tests de T3.4, reconfirmado leyendo el código: el
  `NotFoundException` se lanza explícitamente cuando `findUnique`
  devuelve `null`).
- **Reclausura / reapertura de una sesión ya CERRADA**: rechazada con
  409 en ambos casos (ya cubierto por T3.1/T3.4 — la constraint única
  parcial bloquea la apertura, el chequeo de `estado` bloquea el
  cierre).
- **Autorización server-side**: `esOwner` se deriva siempre de
  `user.rol` (JWT verificado por el `AuthGuard` global), nunca de un
  campo que mande el cliente — confirmado que `CloseSessionDto` no
  tiene ningún campo `esOwner`/`rol` que un body malicioso pudiera
  inyectar (el `ValidationPipe` global con `forbidNonWhitelisted`
  lo rechazaría de todos modos).
- **Mass assignment**: `ManualMovementDto`/`CloseSessionDto` no
  exponen `referenciaTipo`/`referenciaId`/`montoSistema`/`diferencia`
  — un body con esos campos de más da 400 (`ValidationPipe` global,
  mismo mecanismo ya probado en `auth`/`products`).
- **SQL injection**: los dos únicos `$queryRaw` del módulo
  (`registrarMovimiento`, `cerrarSesion`) usan template tags
  parametrizados de Prisma (`${input.sessionId}`, un `number` que ya
  pasó por `ParseIntPipe`), nunca concatenación de strings.
- **UI — doble click / doble submit**: los tres formularios
  (`OpenSessionForm`, `CloseSessionModal`, `ManualMovementModal`)
  deshabilitan su botón mientras `submitting` es `true` — confirmado
  en código, sin cambios desde T3.7.
- **UI — error de servidor no rompe la pantalla**: confirmado en vivo
  (Browser pane) para el Hallazgo 2 — el mensaje del backend aparece
  en un `Alert`, el formulario conserva el valor tipeado, no hay
  pantalla en blanco ni error de React sin capturar.
