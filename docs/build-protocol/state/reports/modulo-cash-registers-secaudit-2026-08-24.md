# Security Audit — módulo `cash-registers` (2026-08-24)

Fase 09 del protocolo. **Sin código modificado** (regla explícita de
esta fase). Alcance: backend (`cash-register.service.ts`,
`cash-registers.controller.ts`, DTOs, `cash-registers.module.ts`) y
frontend (`CashRegisterPage.tsx` y sus 3 componentes,
`features/cash-registers/api.ts`/`types.ts`, `lib/idempotency.ts`),
T3.1–T3.7, ya en VERDE desde la fase 08
(`fase08-qa-cash-registers`).

Verificación empírica contra el servidor de desarrollo real donde fue
posible, no solo lectura de código — "no asumas que las protecciones
existentes son correctas" es literal en esta fase.

Sin CRITICAL ni HIGH. Sin hallazgos nuevos que bloqueen el Quality
Gate.

---

## 1. Authentication

Sin hallazgos. Las tres rutas mutantes y la de lectura probadas en
vivo sin cookie de sesión: `GET /sessions/open`, `POST /sessions`,
`POST /movements/ingreso` → **401** las tres. Una cookie con un JWT
inválido (`access_token=invalidtoken`) contra `GET /sessions/open` →
**401**, sin 500 ni traza cruda. `AuthGuard` corre global
(`APP_GUARD` en `AppModule`) — este módulo no define ningún guard
propio ni tiene forma de saltearlo.

## 2. Authorization

Sin hallazgos. Matriz de permisos contrastada contra la sección 8 de
`modulo-cash-registers-spec.md`: abrir sesión y cerrar sesión — sin
`@Roles()`, abierto a cualquier autenticado (RN-2/RN-6, correcto por
diseño); `POST /movements/ingreso` y `/retiro` — `@Roles(UserRole.OWNER)`
explícito (AMB-13, RESUELTA). `RolesGuard` corre global, después de
`AuthGuard` (orden correcto: puebla `request.user` antes de
evaluarlo).

## 3. Access control

Sin hallazgos. No hay concepto de "recurso propio" en este módulo
(RN-2, spec: "no existe un concepto de 'mi sesión' vs 'la de otro'")
— cualquier usuario con el rol correcto opera sobre LA sesión abierta
actual, la haya abierto quien la haya abierto. No hay controles de
acceso por-fila que auditar más allá del rol.

## 4. Privilege escalation

Sin hallazgos. `esOwner` (que decide si se exige `notaCierre` y si la
respuesta incluye `montoSistema`/`diferencia`) se deriva siempre de
`user.rol`, poblado por `AuthGuard` desde el JWT verificado — nunca de
un campo del body. `CloseSessionDto`/`ManualMovementDto` no exponen
ningún campo que permita a un SELLER declararse `OWNER`; de mandarlo
igual, el `ValidationPipe` global (`forbidNonWhitelisted: true`) lo
rechaza con 400 antes de que el controller lo vea.

## 5. IDOR

No aplica en el sentido clásico — mismo motivo que la sección 3
(RN-2, sesión compartida, sin ownership). `sessionId` en la URL de
`POST /sessions/:id/close` no es un identificador de "mi sesión": es
la sesión operativa única del negocio. Manipularlo a un id
inexistente → 404 ("Sesión de caja no encontrada"); a un id ya
`CERRADA` → 409, nunca reabre ni pisa datos.

## 6. Input validation

**Reforzado en la fase 08** (magnitud/signo de montos) — reconfirmado
sin regresiones. Todos los DTOs usan `@IsDecimal` (formato) +
validación de negocio en el servicio (signo, magnitud, positividad).
`ValidationPipe` global con `whitelist`/`forbidNonWhitelisted`/
`transform` cubre mass assignment. `descripcion`/`notaCierre` tienen
`@MaxLength` (500/1000).

**Observación LOW, no específica de este módulo:** el header
`Idempotency-Key` (interceptor común de T0.14, `common/idempotency/`)
no tiene cota de longitud — cualquier string no vacío se acepta y se
persiste en una columna `TEXT` sin límite. El único techo real hoy es
el tamaño máximo de cabecera HTTP de Node (16KB por defecto). Riesgo
bajo (nunca se ejecuta código a partir de ese valor, solo se guarda y
compara por igualdad) y es infraestructura compartida fuera de este
módulo (`common/idempotency/`, ya usada por `sales`/`returns`/
`expenses` cuando existan) — no corresponde corregirlo desde acá.

## 7. SQL injection

Sin hallazgos. Los dos únicos `$queryRaw` del módulo
(`registrarMovimiento`, `cerrarSesion`, el lock `SELECT ... FOR
UPDATE`) usan template tags parametrizados de Prisma
(`${input.sessionId}`) — nunca concatenación de strings, y
`sessionId` ya pasó por `ParseIntPipe` antes de llegar ahí (garantizado
`number`, no un string arbitrario).

## 8. XSS

Sin hallazgos. `grep` de `dangerouslySetInnerHTML` en todo
`frontend/src`: cero resultados. `descripcion`/`notaCierre` (los dos
únicos campos de texto libre que un usuario controla en este módulo)
se renderizan siempre como texto de React (auto-escapado), nunca
inyectados como HTML.

## 9. CSRF

Sin hallazgos. Verificado EN VIVO contra una ruta de este módulo
específicamente (no solo confiado en que la protección global de
`auth` alcanza): `POST /cash-registers/sessions` con
`Content-Type: application/x-www-form-urlencoded` → **415**
(`jsonOnlyMiddleware`, `forRoutes('*')` en `AppModule.configure()`).
Un `<form>` HTML nativo malicioso no puede disparar ninguna mutación
de este módulo.

## 10. SSRF

No aplica — el módulo no hace ninguna llamada HTTP saliente ni recibe
URLs de usuario.

## 11. Path traversal

No aplica — sin operaciones de filesystem en el módulo.

## 12. Sensitive information exposure

**El punto central de seguridad de este módulo (RN-6, "cierre a
ciegas").** `hideOwnerOnlyFields()` borra (`delete`, no `undefined`
por omisión de tipo) `montoSistema`/`diferencia` del objeto antes de
serializarlo cuando quien pregunta no es `OWNER` — confirmado que la
propiedad está genuinamente AUSENTE del JSON de respuesta (no en
`null` ni `0`), tanto por los tests de integración de T3.4/T3.5
(contra Postgres real) como por un test unitario agregado en la fase
08 que verifica explícitamente `'montoSistema' in result === false`.
Sin ninguna otra ruta de este módulo que exponga esos dos campos a
SELLER (los únicos dos endpoints que los calculan —`close` y
`sessions/open`— aplican el mismo ocultamiento). El mensaje de error
de RN-5 (que incluye la `diferencia` en texto) solo se construye
dentro de `if (input.esOwner)` — un SELLER nunca puede llegar a ese
branch, así que tampoco hay fuga por ese lado.

## 13. Secrets

Sin hallazgos. El módulo no maneja ni referencia ningún secreto
(`JWT_SECRET`, credenciales, API keys) — esas viven en `auth`/
`config/env.schema.ts`, ya auditadas en fases anteriores.

## 14. Logs

Sin hallazgos. `pinoHttp` no tiene ningún serializer de `req.body`
configurado (confirmado leyendo `app.module.ts`) — los montos,
descripciones y notas de cierre de este módulo nunca llegan a un log,
sensibles o no. La redacción de cookies/JWT (`LOG_REDACT_PATHS`, fase
10 de `auth`) sigue activa globalmente y cubre las rutas de este
módulo igual que cualquier otra.

## 15. Error handling

Sin hallazgos nuevos. Los dos hallazgos de la fase 08 (500 crudo por
overflow de precisión) eran justamente de esta categoría y ya están
corregidos — reconfirmado que ningún endpoint del módulo devuelve un
mensaje de error con stack trace o detalle interno: todo pasa por
`GlobalExceptionFilter`, que normaliza a `{statusCode, timestamp,
path, message}`.

## 16. Rate limiting

**Observación LOW, consistente con una decisión ya tomada a nivel de
sistema, no un olvido de este módulo.** El único endpoint con
`@nestjs/throttler` en todo el backend es `/auth/login` (fase 08 de
`auth`) — `POST /movements/ingreso`/`retiro` (mutación de dinero,
`OWNER`-only) no tiene límite de frecuencia propio. El impacto real es
bajo: ya requieren una sesión `OWNER` autenticada (no es un vector de
fuerza bruta ni de enumeración), y `products`/`stock` (que también
mutan dinero/stock, `OWNER`-only) tampoco lo tienen — no es una
inconsistencia introducida por este módulo. Documentado para que quede
registrado, no para bloquear: si se decide agregar rate limiting a
rutas mutantes de dinero más allá de login, es una decisión
transversal a varios módulos, no específica de `cash-registers`.

## 17. Dependencies

Sin hallazgos nuevos. `git log` confirma que ningún commit de
T3.1–T3.7 ni de las fases 07/08 tocó `package.json`/`package-lock.json`
— el módulo no agregó ninguna dependencia nueva. `npm audit
--omit=dev` sigue en **3 high**, exactamente la misma cadena de
siempre (`prisma` CLI → `@prisma/config` → `deepmerge-ts`), ya
documentada y aceptada como **TD-9** desde la fase 08 de `products`
— reconfirmado sin cambios, no es un hallazgo nuevo de este módulo.

## 18. Sensitive data storage

Sin hallazgos. Los montos se guardan como `Decimal` en Postgres, sin
necesidad de cifrado (no son datos personales ni credenciales — son
cifras de caja de un único local, protegidas por autenticación/
autorización, no por cifrado en reposo). `notaCierre`/`descripcion`
son texto libre operativo, mismo criterio.

## 19. Incorrect permissions

Sin hallazgos — ver sección 2. Las 5 rutas existentes verificadas una
por una contra la matriz de la spec, sin ninguna discrepancia.

## 20. Unauthorized endpoints

Sin hallazgos. Los 5 endpoints reales del controller coinciden
exactamente con los documentados en la spec (menos los dos gaps de
alcance ya señalados en la fase 07 — `GET /sessions/:id` y
`GET /sessions/:id/movements`, que simplemente no existen, no es que
existan sin protección). Ningún endpoint "fantasma" ni ruta de debug
dejada expuesta.

---

## Resumen

Sin CRITICAL, sin HIGH. Dos observaciones LOW (longitud de
`Idempotency-Key` sin cota — infraestructura compartida fuera de este
módulo; ausencia de rate limiting en rutas de dinero `OWNER`-only —
decisión de sistema ya existente, no específica de acá), ninguna
bloqueante. Una reconfirmación de deuda técnica ya documentada
(TD-9, `npm audit` de la cadena de `prisma` CLI).

**No se declara el módulo seguro de forma permanente** — coherente con
que no hubo ningún hallazgo que remediar, la fase 10 (remediación) no
tiene nada que hacer; la fase 11 (re-auditoría) igual corresponde
antes de dar por cerrada la seguridad del módulo (mismo criterio que
`products`: la Fase 11 exige riesgo BAJO en `MVP_SCOPE.md`, y
`cash-registers` está clasificado **ALTO** ahí — no se puede saltar).
