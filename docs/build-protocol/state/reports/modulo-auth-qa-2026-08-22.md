# QA adversarial — módulo `auth` (2026-08-22)

Fase 08 del protocolo. Objetivo: romper el módulo, no confirmar que
funciona. Alcance: T1.1–T1.4 (`UsersService`, `AuthService`, `AuthGuard`,
`RolesGuard`, pantalla de login del frontend), ya en VERDE en la fase 07.

Todos los hallazgos con severidad ALTA o media que se encontraron abajo
**ya están corregidos y probados** en este mismo pase — no quedó ninguno
pendiente de arreglo. Ver "Problemas pendientes" al final para lo que
queda como decisión consciente, no como bug.

---

## Hallazgo 1 — Race condition real en "no desactivar al último OWNER"

```
SEVERITY: CRITICAL
REPRODUCTION: Con exactamente dos OWNER activos, disparar dos PATCH
  /users/:id { activo: false } simultáneos, uno contra cada uno.
EXPECTED: Una de las dos operaciones tiene éxito (200) y la otra se
  rechaza (409) — el sistema nunca se queda con 0 OWNER activos.
ACTUAL: Las dos tenían éxito. Confirmado 29/30 veces en un script aislado
  contra Prisma directo (sin overhead de HTTP/Nest, que alcanzaba a
  enmascarar la ventana de la carrera en las primeras pruebas — un test a
  nivel HTTP de un solo intento dio un falso negativo 5/5 veces antes de
  bajar al nivel de Prisma para confirmarlo).
ROOT CAUSE: `UsersService.update()` contaba los OWNER activos con
  `tx.user.count(...)` dentro de una transacción, sin bloquear filas. Bajo
  READ COMMITTED (el nivel de aislamiento por defecto de Postgres), dos
  transacciones concurrentes pueden leer el mismo conteo "queda 1 más"
  antes de que ninguna de las dos haga commit, y las dos pasan la
  validación.
FIX: Reemplazado el `count()` por
  `SELECT id FROM users WHERE rol = 'OWNER' AND activo = true ORDER BY id
  FOR UPDATE` dentro de la misma transacción — el mismo patrón que
  BLUEPRINT §9.4 exige para el descuento de stock. La segunda transacción
  queda bloqueada hasta que la primera termine, y al desbloquearse relee
  el estado ya actualizado. Verificado 0/30 carreras después del fix, con
  el mismo script aislado. Ver `users.service.ts`, método `update`.
```

## Hallazgo 2 — Contraseña sin límite de longitud amplifica el costo de argon2

```
SEVERITY: MEDIUM
REPRODUCTION: Mandar un `password` de cientos de miles de caracteres a
  POST /auth/login (ruta pública, sin sesión).
EXPECTED: Se rechaza por tamaño antes de gastar CPU hasheando.
ACTUAL: Sin límite de longitud en el DTO, el body pasaba entero a
  `argon2.verify()`. `AuthService.validateUser()` corre argon2 **siempre**,
  exista o no el email (a propósito, para no filtrar por temporización
  qué emails están registrados) — eso significa que la ruta pública sin
  sesión de todo el sistema tenía un costo de CPU por request sin techo,
  controlable por quien manda el request.
ROOT CAUSE: Ningún DTO (`LoginDto`, `CreateUserDto`, `UpdatePasswordDto`)
  tenía `@MaxLength` en `password`.
FIX: `@MaxLength(128)` en los tres DTOs de contraseña. También se agregó
  `@MaxLength(254)` en email y `@MaxLength(200)` + trim en nombre
  (`CreateUserDto`, `UpdateUserDto`) — mismo principio de no confiar en
  inputs sin techo.
```

## Hallazgo 3 — Sin límite de intentos en `/auth/login`

```
SEVERITY: HIGH
REPRODUCTION: Mandar N requests a POST /auth/login seguidos.
EXPECTED: A partir de cierto número de intentos por minuto desde el mismo
  origen, se rechaza con 429.
ACTUAL: Sin límite — ya señalado como riesgo conocido en
  modulo-auth-spec.md sección 6, explícitamente diferido para esta fase.
  Combinado con el Hallazgo 2, es una ruta pública con costo de CPU
  garantizado por request y sin freno de intentos: fuerza bruta de
  contraseñas y agotamiento de CPU quedaban abiertos a cualquiera.
ROOT CAUSE: No había rate limiting implementado.
FIX: `@nestjs/throttler`, 20 intentos por minuto por IP, aplicado **solo**
  a `POST /auth/login` (no global: el resto de las rutas ya exige sesión
  o rol, una barrera más fuerte que un límite por IP). El número se eligió
  para no bloquear a alguien reintentando su propia contraseña un par de
  veces, mientras sigue haciendo la fuerza bruta real order-de-magnitud
  más lenta. Verificado con 21 intentos seguidos en una app aislada: los
  primeros 20 pasan, el 21° da 429.
```

## Hallazgo 4 — `X-Powered-By: Express` expuesto en cada respuesta

```
SEVERITY: LOW
REPRODUCTION: Cualquier request a la API.
EXPECTED: No revela gratis qué framework corre atrás.
ACTUAL: Header presente en todas las respuestas (confirmado en los logs
  de los tests de integración de fases anteriores).
ROOT CAUSE: Comportamiento por defecto de Express, nunca desactivado.
FIX: Middleware chico en `AppModule.configure()` que lo remueve en cada
  response. Verificado con un test que confirma su ausencia.
```

## Hallazgo 5 — Sin test de que mass-assignment esté realmente bloqueado

```
SEVERITY: MEDIUM (de cobertura, no de código — el `ValidationPipe` global
  ya estaba bien configurado desde la fase 00: `whitelist: true,
  forbidNonWhitelisted: true`)
REPRODUCTION: Mandar `passwordHash`, `activo` o `id` de más en el body de
  POST /users o PATCH /users/:id.
EXPECTED: 400, el body entero se rechaza — nadie puede saltarse el
  hasheo mandando `passwordHash` directo, ni forzar un `id` o `activo`
  arbitrario.
ACTUAL: El comportamiento ya era correcto (el pipe global lo cubre), pero
  no había ningún test que lo confirmara — un cambio futuro a la config
  del pipe podría reabrir el agujero sin que ningún test lo note.
FIX: No hizo falta cambiar código. Se agregaron tests que mandan
  `passwordHash`/`activo`/`id` de más y confirman 400, tanto en alta como
  en edición.
```

---

## Otras pruebas adversariales sin hallazgos (comportamiento ya correcto)

- **IDOR / recursos ajenos**: `/users/*` es enteramente OWNER-only (no hay
  modelo de "cada quien ve lo suyo" que romper); `GET /auth/me` siempre
  devuelve al usuario del propio JWT, nunca uno pedido por parámetro — no
  hay forma de pedir la identidad de otro.
- **Manipulación de IDs**: `/users/abc` (no numérico) da 400 (`ParseIntPipe`),
  no 500. `/users/999999` (inexistente) da 404 en vez de un error genérico.
- **Rol fuera del enum** (`"SUPERADMIN"`, etc.): 400, no se guarda tal cual.
- **Nombre de largo extremo**: ahora 400 (ver Hallazgo 2, mismo fix de
  `@MaxLength`).
- **SQL injection**: los DTOs y Prisma parametrizan todo; `@IsEmail()`
  además rechaza antes de que un string malicioso llegue a la consulta.
- **Errores no filtran información interna**: confirmado que
  `GlobalExceptionFilter` nunca expone stack traces ni nombres de columna.
- **Password nunca en logs**: revisado — `nestjs-pino` no serializa el
  body del request por defecto, y no hay ningún `console.log` en todo el
  módulo (ver fase 07).

## Problema pendiente, no bloqueante (decisión consciente, no bug)

```
SEVERITY: MEDIUM (aceptado, documentado)
DESCRIPCIÓN: El JWT es stateless a propósito (BLUEPRINT §9.6). Si un
  OWNER desactiva a otro usuario o le baja el rol, la sesión de esa
  persona sigue siendo válida hasta que expire (máximo 12h) o haga
  logout — no hay blacklist de tokens ni consulta a la base en cada
  request.
POR QUÉ NO SE ARREGLA ACÁ: el blueprint no describe ninguna
  infraestructura de revocación (ni Redis, ni tabla de sesiones), y
  agregar una contradice el diseño stateless explícito de §9.6. Dado el
  tamaño real del sistema (AD-1/AD-2: un local, pocos usuarios), el riesgo
  es bajo y está acotado en el tiempo (12h como mucho).
RECOMENDACIÓN: aceptar como está. Si en algún momento se necesita
  revocación inmediata, es un cambio de arquitectura (sesiones con
  estado), no un ajuste de este módulo — anotarlo en
  `state/TECH_DEBT.md` si se decide aceptar formalmente.
```

## Testing de mutación

**No corrido.** BLUEPRINT §9.8 lo pide "solo sobre los servicios
críticos: `sales`, `stock`, `cash-registers`, `returns`, `results`" — es
decir, plata y stock. `auth` no maneja ninguno de los dos (verifica
identidad, no mueve dinero ni descuenta inventario), así que corresponde
saltarlo acá, tal como el propio BLUEPRINT lo restringe explícitamente.

## Resultado final

- Tests unitarios: **25/25** en verde (agregados: verificación de
  expiración del JWT, del `SELECT ... FOR UPDATE`).
- Tests de integración: **39/39** en verde (agregados: carrera real del
  último OWNER activo con 8 iteraciones, rate limit, mass-assignment en
  alta y edición, rol inválido, nombre extremo, id no numérico,
  `X-Powered-By` ausente).
- Lint y build: verde, backend y frontend.
- Sin datos residuales en la base después de cada corrida.

**No se declara el módulo `auth` terminado** — eso es la fase 12
(production readiness), después de la auditoría de seguridad (fase 09).
Con los hallazgos de esta fase corregidos, no queda ningún problema que
debería bloquear el Quality Gate.
