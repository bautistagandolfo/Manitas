# Especificación del módulo `auth`

Fase 06 del protocolo. Fuentes: `BLUEPRINT.md` §3.1 (modelo `users`), §5.1
(reglas de negocio), §6 (invariantes), §9.6 (autenticación), §9.9
(config/secretos), §12.6 (reglas generales de interfaz); `state/ROADMAP.md`
Etapa 1; `state/AMBIGUITIES.md` (sin ambigüedades pendientes que bloqueen
este módulo).

---

## 1. Responsabilidad

**Hace:**
- Login con email + contraseña, emite una sesión (JWT en cookie httpOnly).
- Logout (invalida la cookie del lado del cliente).
- Expone quién es el usuario autenticado actual (`GET /auth/me`).
- Alta, edición y baja lógica de usuarios — **solo `OWNER`**.
- Los dos guards que todo el resto del sistema usa: autenticación
  (¿hay sesión válida?) y autorización por rol (`RolesGuard`).

**No hace:**
- No decide **qué** puede ver o hacer cada rol dentro de otros módulos —
  eso lo decide cada módulo aplicando `@Roles(...)` sobre el guard que
  este módulo expone. `auth` es la infraestructura, no la política de cada
  pantalla.
- No tiene "olvidé mi contraseña" por email: no hay infraestructura de
  envío de mail en ningún lugar del blueprint (AD-12: nube, sin más
  integraciones de las descritas), y con un local y pocos usuarios
  (AD-1/AD-2) alcanza con que `OWNER` resetee la contraseña de un `SELLER`
  a mano. Si esto cambia, es una decisión de infraestructura nueva, no un
  ajuste de este módulo.
- No maneja cuentas de clientes (`customers` está fuera del MVP — AD-17).
- No implementa 2FA ni SSO: no está en el blueprint ni lo pide
  `MVP_SCOPE.md`.

---

## 2. Reglas de negocio (BLUEPRINT §5.1)

1. Login con email y contraseña. Hash con **argon2** (nunca reversible,
   nunca en texto plano en ningún log).
2. Dos roles: `OWNER` y `SELLER`.
3. `SELLER` no accede a: módulo de resultados, gestión de usuarios, costos
   de productos, ni cierre de caja con totales. **Este módulo no puede
   verificarlo por sí solo** — solo expone el rol; cada módulo consumidor
   aplica la restricción concreta. Lo que sí impone acá: los endpoints de
   gestión de usuarios (`/users/*`) son `OWNER`-only.
4. Toda ruta protegida verifica el rol **en el servidor**, siempre. Ocultar
   un botón en el frontend no es autorización — es UX, no seguridad.
5. Baja lógica de usuarios (`activo = false`), nunca borrado físico.
6. **Regla que agrego acá, no está explícita en el blueprint:** no se
   puede desactivar (ni bajar de rol) al **último `OWNER` activo**. Sin
   esto, un `OWNER` puede dejar el sistema sin nadie que pueda
   administrarlo — nadie podría revertirlo. Lo marco como regla de este
   módulo porque es una consecuencia directa de la regla 5 (baja lógica)
   combinada con "solo `OWNER` gestiona usuarios": sin este resguardo, la
   regla 5 puede dejar el sistema en un estado sin salida.

---

## 3. Invariantes (BLUEPRINT §6)

Ninguno de los 15 invariantes numerados de la sección 6 aplica directo a
`auth` — son todos de dinero y stock. El invariante propio de este módulo,
no numerado en el blueprint pero exigido por la regla 4 de arriba:

> **Toda ruta que no sea `POST /auth/login` exige un JWT válido, y toda
> ruta marcada `@Roles('OWNER')` exige además `rol = OWNER` en ese JWT —
> verificado en cada request, nunca cacheado ni confiado del cliente.**

Se garantiza con dos guards globales (`AuthGuard` + `RolesGuard`)
registrados a nivel de aplicación, no ruta por ruta — así ningún endpoint
nuevo puede "olvidarse" de protegerse. Rutas explícitamente públicas
(`POST /auth/login`, `GET /health`) se marcan con un decorator `@Public()`.

---

## 4. Contratos de API

Todas las respuestas de error usan el formato uniforme del
`GlobalExceptionFilter` (fase 00).

### `POST /auth/login` — público

**Body:** `{ email: string, password: string }`

**200 OK** — setea la cookie `access_token` (httpOnly) y devuelve:
```json
{ "id": 1, "email": "owner@tienda.com", "nombre": "...", "rol": "OWNER" }
```

**401 Unauthorized** — credenciales inválidas. **Mismo mensaje genérico**
sin importar si el email no existe, la contraseña es incorrecta, o el
usuario existe pero `activo = false`. Distinguir esos casos en la
respuesta permite enumerar usuarios válidos por fuerza bruta.

### `POST /auth/logout` — requiere sesión

Limpia la cookie. **200 OK** siempre, incluso si la cookie ya había
expirado o no existía (idempotente — un logout nunca debería poder
fallar de forma que la persona quede sin saber si cerró sesión).

### `GET /auth/me` — requiere sesión

**200 OK:** mismo shape que el login. Lo usa el frontend al cargar la SPA
para saber si hay sesión y quién es, sin tener que loguear de nuevo.

**401 Unauthorized** si no hay sesión válida.

### `POST /users` — `OWNER`

**Body:** `{ email: string, password: string, nombre: string, rol: 'OWNER' | 'SELLER' }`

**201 Created:** el usuario, sin `passwordHash`.

**409 Conflict** si el email ya existe.

### `GET /users` — `OWNER`

Lista de usuarios (incluye inactivos, con el estado visible — `OWNER`
necesita poder reactivar a alguien). Sin costos ni datos de otros módulos.

### `PATCH /users/:id` — `OWNER`

**Body (todos opcionales):** `{ nombre?, rol?, activo? }`

**200 OK:** el usuario actualizado.

**409 Conflict** si el cambio deja al sistema sin ningún `OWNER` activo
(desactivar al último `OWNER`, o bajarle el rol a `SELLER`).

**404 Not Found** si el `id` no existe.

### `PATCH /users/:id/password` — `OWNER`

**Body:** `{ password: string }` — resetea la contraseña de cualquier
usuario (incluida la propia). No devuelve la contraseña ni el hash.

**200 OK.**

---

## 5. Transacciones y concurrencia

`auth` es el primer módulo del sistema que **no** necesita bloqueo de
filas ni transacciones multi-tabla — no toca stock, dinero ni caja
(BLUEPRINT §7 solo exige eso para operaciones de ese tipo).

Lo único a cuidar:

- **Alta de usuario:** confiar en el índice único de `users.email` (ya
  existe desde la fase 01) para la atomicidad — no hacer
  "buscar-si-existe-y-crear" en dos pasos separados, porque dos altas
  simultáneas con el mismo email pasarían la validación previa a la vez.
  Insertar directo y capturar el error de unicidad (Prisma `P2002`) para
  devolver el 409.
- **"Último `OWNER` activo" al editar:** entre leer cuántos `OWNER`
  activos hay y aplicar el cambio, otra request podría desactivar a otro
  `OWNER` en simultáneo. Como esto no es dinero ni stock, no amerita
  `SELECT ... FOR UPDATE` — alcanza con recalcular la condición dentro de
  una transacción corta (`prisma.$transaction`) que cuente los `OWNER`
  activos y aplique el cambio atómicamente, para que dos ediciones
  concurrentes no dejen el sistema en 0 `OWNER` activos por una carrera.

---

## 6. Edge cases

- Login con email que no existe → 401 genérico.
- Login con contraseña incorrecta → 401 genérico (mismo mensaje).
- Login de un usuario con `activo = false` → 401 genérico (no revela que
  la cuenta existe).
- Cookie expirada en medio de una venta → el frontend recibe 401 en
  cualquier request y redirige a login. El margen de 12 h (§9.6) está
  pensado para que esto casi nunca pase en una jornada real; no hay
  refresh token en el blueprint y no corresponde inventarlo acá.
- Intentar desactivar o bajar de rol al **único** `OWNER` activo → 409,
  rechazado (regla 6 de la sección 2).
- Alta de usuario con email duplicado (incluida una carrera de dos altas
  simultáneas con el mismo email) → 409.
- `PATCH /users/:id` sobre un `id` inexistente → 404.
- Un `SELLER` autenticado pega contra cualquier ruta `/users/*` → 403
  (`RolesGuard`), no 401 — la autenticación es válida, lo que falta es
  autorización.
- Token con firma inválida, corrupto, o de un `JWT_SECRET` viejo
  (rotación de secreto) → 401, igual que "no hay sesión".
- **No está en el blueprint, lo agrego como recomendación de seguridad
  estándar:** limitar los intentos de `POST /auth/login` (por IP y/o por
  email) para frenar fuerza bruta — por ejemplo con `@nestjs/throttler`.
  Costo de implementación bajo, y es exactamente el tipo de cosa que un
  QA adversarial (fase 08) va a probar sobre un módulo `ALTO` riesgo como
  este.

---

## 7. Errores

| Situación | Código | Qué ve la persona |
|---|---|---|
| Credenciales inválidas (cualquier motivo) | 401 | "Email o contraseña incorrectos" |
| Sin sesión / sesión expirada en ruta protegida | 401 | Redirige a login, sin mensaje de error visible (es esperable) |
| Rol insuficiente | 403 | "No tenés permiso para hacer esto" |
| Email duplicado al crear usuario | 409 | "Ya existe un usuario con ese email" |
| Desactivar/bajar de rol al último OWNER | 409 | "No podés dejar el sistema sin ningún dueño activo" |
| Usuario inexistente en `PATCH /users/:id` | 404 | "Usuario no encontrado" |

Ninguno de estos expone detalles internos (stack traces, nombres de
columnas) — los captura el `GlobalExceptionFilter` común.

---

## 8. Permisos

| Endpoint | Público | `SELLER` | `OWNER` |
|---|:---:|:---:|:---:|
| `POST /auth/login` | ✅ | ✅ | ✅ |
| `POST /auth/logout` | ❌ | ✅ | ✅ |
| `GET /auth/me` | ❌ | ✅ | ✅ |
| `POST /users` | ❌ | ❌ | ✅ |
| `GET /users` | ❌ | ❌ | ✅ |
| `PATCH /users/:id` | ❌ | ❌ | ✅ |
| `PATCH /users/:id/password` | ❌ | ❌ | ✅ |

---

## 9. Tests necesarios

**Unitarios (`AuthService`, `UsersService`, guards con mocks):**
- Hash y verificación de contraseña (argon2) — un hash nunca es igual al
  texto plano, y `verify(hash, password)` da `true`/`false` correcto.
- Emisión de JWT: contiene `sub` (userId) y `rol`, expira en 12 h.
- `AuthGuard` rechaza sin cookie, con cookie corrupta, y con JWT expirado;
  acepta con JWT válido y adjunta el usuario al request.
- `RolesGuard` rechaza rol insuficiente, acepta rol correcto, y **no
  bloquea** rutas sin `@Roles(...)` (autenticación sí, autorización por
  rol solo donde se pide explícitamente).
- Lógica de "no queda ningún OWNER activo" con distintos escenarios de
  usuarios existentes.

**Integración (Supertest + Postgres real, contra la app completa):**
- Login exitoso → cookie seteada, `GET /auth/me` la usa y devuelve el
  usuario correcto.
- Login con contraseña incorrecta, con email inexistente, y con usuario
  `activo=false` → los tres dan 401 con el mismo mensaje (verificar que
  el mensaje es idéntico, no solo el código).
- `GET /users` sin sesión → 401. Con sesión de `SELLER` → 403. Con sesión
  de `OWNER` → 200.
- Alta de usuario duplicado (email) → 409, y probar la carrera real: dos
  altas simultáneas con el mismo email, una gana y la otra recibe 409 (no
  las dos 201).
- Desactivar al único `OWNER` activo → 409. Desactivar un `OWNER` cuando
  hay otro `OWNER` activo → 200.
- Logout → cookie limpia, siguiente `GET /auth/me` da 401.
- `PATCH /users/:id/password` cambia el hash y el login con la contraseña
  vieja deja de funcionar.

**E2E:** no le corresponde un flujo propio en la fase 14 (que cubre los
flujos de negocio de `MVP_SCOPE.md` §7) — el login es un **paso previo**
de todos esos flujos, no un flujo en sí mismo. Se prueba como parte de
cada E2E de otro módulo.

---

## 10. Ambigüedades

Ninguna ambigüedad de negocio nueva bloquea este módulo. Un solo hallazgo,
que no es una ambigüedad de negocio sino una **inconsistencia entre
documentos** — la corrijo directo en vez de escalarla:

`BLUEPRINT.md` §9.6 dice expiración de **12 horas**; `state/ROADMAP.md`
T1.2 decía "(8 h)". El blueprint es la fuente de verdad — corregido el
ticket a continuación (sección 11).

**Hallazgo fuera de alcance de este módulo, para reportar aparte:**
`DECISIONES_PENDIENTES.md` (Bloque C2) dice explícitamente que la
importación CSV para la carga inicial "es un ticket nuevo de la Etapa 2,
no un extra" — y `ROADMAP.md` Etapa 2 no tiene ese ticket. No lo agrego
acá porque no es parte del módulo `auth`; lo dejo anotado para cuando se
especifique `products`/`variants` (o se revise `ROADMAP.md` de nuevo).

---

## 11. Tickets — confirmación/ajuste sobre `state/ROADMAP.md`

Los tickets T1.1–T1.4 ya definidos cubren bien el módulo. Un ajuste:

- **T1.2:** corregido el texto — decía "(8 h)", el blueprint (§9.6) dice
  **12 h**. Ver diff en `ROADMAP.md`.
- **T1.1:** se amplía la descripción para dejar explícito que incluye
  `GET /users` y `PATCH /users/:id` (no solo alta), y la regla del último
  `OWNER` activo (sección 2, regla 6 de este documento).

No se agregan tickets nuevos: el alcance de T1.1–T1.4 ya cubre todo lo
especificado acá.
