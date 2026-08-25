# Security Audit — módulo `sales` (2026-08-25)

Fase 09 del protocolo. **Sin código modificado** (regla explícita de
esta fase). Alcance: backend (`sales.service.ts`, `sales.controller.ts`,
`create-sale.dto.ts`, `sales.module.ts`) y frontend (`SalePage.tsx`,
`CobroPage.tsx`, `DiscountModal.tsx`, `features/sales/{api,cart,
payments,draft-storage,types}.ts`), T4.1–T4.11, ya en VERDE desde la
fase 08 (`fase08-qa-sales`).

Verificación empírica contra el servidor de desarrollo real donde fue
posible (incluida una reproducción en vivo contra `POST /sales`
específicamente, no solo confiado en que la protección global alcanza),
no solo lectura de código — "no asumas que las protecciones existentes
son correctas" es literal en esta fase.

Sin CRITICAL. Un hallazgo HIGH (ver sección 9, CSRF — matizado: la
protección global existe y se reconfirmó en vivo, pero depende de una
condición no verificada por ningún test automatizado, ver detalle). Sin
otros hallazgos que bloqueen el Quality Gate más allá de eso.

---

## 1. Authentication

Sin hallazgos nuevos. Verificado EN VIVO contra `POST /sales`
específicamente: sin cookie → **401** ("No hay sesión activa"); cookie
`access_token=invalidtoken` (JWT inválido) → **401** ("Sesión inválida o
expirada"), sin 500 ni traza cruda. `AuthGuard` corre global (`APP_GUARD`
en `AppModule`) — `SalesController` no define ningún guard propio ni
tiene forma de saltearlo (sin `@Public()` en ningún método).

## 2. Authorization

Sin hallazgos. `POST /sales` no tiene `@Roles()` a propósito (RN-1 de la
spec: "cualquiera autenticado, es el trabajo del vendedor") — confirmado
que `RolesGuard` sin `@Roles()` en la ruta exige solo estar autenticado,
no un rol específico (mismo comportamiento ya auditado en
`cash-registers`/`products` para sus rutas sin rol). `anularVenta`
exige `esOwner` internamente (RN-8, "Solo OWNER") pero **no tiene ruta
HTTP todavía** (gap de alcance ya documentado en la Fase 07, T4.11) —
no hay ninguna forma de invocarlo desde afuera del proceso Node, así
que no hay superficie de autorización que auditar ahí hasta que exista
el endpoint.

## 3. Access control

Sin hallazgos. No hay concepto de "venta propia" vs "venta ajena" en
este módulo (spec sección 8: "sin restricción de 'mis ventas'") —
cualquier usuario autenticado con el rol correcto puede vender contra
cualquier variante del catálogo único de la tienda. No hay controles de
acceso por-fila que auditar más allá del rol.

## 4. Privilege escalation

Sin hallazgos. `esOwner` (que decide el tope de descuento sin
autorización, RN-4) se deriva siempre de `user.rol === UserRole.OWNER`,
poblado por `AuthGuard` desde el JWT verificado — nunca de un campo del
body. `CreateSaleDto` no expone ningún campo `esOwner`/`rol`; de
mandarlo igual, el `ValidationPipe` global (`forbidNonWhitelisted:
true`) lo rechaza con 400 antes de que el controller lo vea (mismo
mecanismo ya confirmado en otros módulos, no repetido en vivo acá por
no requerir una sesión válida para reproducirlo — la cobertura de test
de `forbidNonWhitelisted` ya existe a nivel de infraestructura común).

## 5. IDOR

No aplica en el sentido clásico — mismo motivo que la sección 3. Los
únicos ids que el cliente controla en el body (`variantId`) no son
"recursos propios": son ids del catálogo compartido de la tienda, y
`crearVenta` ya valida su existencia/actividad (Fase 07, RN-2) antes de
usarlos. No hay `saleId`/`sessionId` en la URL de la única ruta real
(`POST /sales`, sin parámetros) que manipular.

## 6. Input validation

**Un gap real, severidad LOW-MEDIUM, no bloqueante.** `CreateSaleDto`
no tiene `@ArrayMaxSize` en `items`, `payments` ni `discounts` — un
body con, por ejemplo, 50.000 líneas de `items` pasa la validación de
forma (cada `SaleItemDto` individual es válido) y llega íntegro a
`crearVenta`, que arma un `Prisma.join(variantIds)` de esa longitud
para el lock `SELECT ... FOR UPDATE` y un `tx.sale.create` nested con
esa misma cantidad de `sale_items`. Impacto: consumo de memoria/tiempo
de un único request y una transacción larga (más superficie para
contención de locks), no una corrupción de datos — igual requiere una
sesión autenticada válida, no es explotable anónimamente. Mismo patrón
de gap ya señalado como LOW en la Fase 09 de `cash-registers` para la
longitud del header `Idempotency-Key` (sin cota, columna `TEXT`) — acá
el header también aplica sin cambios.

Fuera de eso: `@IsDecimal`+validación de negocio en el servicio (signo,
magnitud — reforzado en la Fase 08 de este módulo) cubre montos;
`descripcion`/`referencia` tienen `@MaxLength` (500); `cantidad` tiene
`@IsInt()`+`@Min(1)` (sin `@Max`, pero el desborde que eso permitiría ya
está cubierto por `assertDentroDePrecision` de la Fase 08, que rechaza
con 400 antes de tocar Prisma).

## 7. SQL injection

Sin hallazgos. Los dos `$queryRaw` del módulo (lock de sesión de caja,
lock de variantes por id) usan template tags parametrizados de Prisma
(`${sesion.id}`, `Prisma.join(variantIds)`) — nunca concatenación de
strings, y los ids que entran ahí ya pasaron por `@IsInt()` +
`transform: true` del DTO (garantizado `number`, no un string
arbitrario).

## 8. XSS

Sin hallazgos. `grep` de `dangerouslySetInnerHTML`/`innerHTML` en todo
`frontend/src`: cero resultados. Los campos de texto libre que un
usuario controla en este módulo (`descripcionSnapshot` — en realidad
armado por el servidor, no por el cliente —, la `descripcion` de un
descuento, `referencia` de un pago) se renderizan siempre como texto de
React (auto-escapado), nunca inyectados como HTML.

## 9. CSRF

**HIGH, matizado — protección real existente, pero no verificada por
ningún test automatizado ni documentada como defensa de este endpoint
específico.**

```
SEVERITY: HIGH (mitigado en la práctica, no bloqueante por sí solo)
REPRODUCTION / VERIFICACIÓN EN VIVO contra POST /sales específicamente:
  - Content-Type: application/x-www-form-urlencoded (simula un <form>
    HTML nativo malicioso) → 415 "Content-Type no soportado" —
    jsonOnlyMiddleware (forRoutes('*') en AppModule.configure(), fase
    10 de auth) corre ANTES que AuthGuard, bloquea el vector sin
    siquiera llegar a chequear la sesión.
  - Content-Type: multipart/form-data → 415, mismo mecanismo.
  - Sin ningún Content-Type (body presente): pasa jsonOnlyMiddleware
    (el chequeo es `contentType && !startsWith('application/json')` —
    un Content-Type AUSENTE no dispara el 415), pero cae en 401 igual
    porque no hay cookie de sesión válida en ese escenario. Con una
    cookie real de un usuario logueado (el escenario CSRF de verdad),
    el body sin `Content-Type: application/json` tampoco lo parsea el
    body-parser de Express como JSON — `req.body` queda vacío/
    indefinido, y `CreateSaleDto` rechaza por `items`/`payments`
    faltantes (400) antes de llegar a `crearVenta`. No se pudo
    reproducir esta última combinación (cookie real + sin
    Content-Type) en vivo por no tener una sesión de prueba a mano en
    este pase — queda como inferencia de código, no como hecho
    verificado empíricamente.
EXPECTED: ninguna mutación de este módulo debería ser disparable por
  un <form> HTML nativo cross-site ni por un fetch() cross-origin con
  la cookie de sesión de una víctima.
ACTUAL: el vector de <form> nativo (el más simple y el que no requiere
  JavaScript en la página atacante) está bloqueado, confirmado en vivo.
  El vector de fetch()/XHR cross-origin con Content-Type:
  application/json (el único que un atacante con JavaScript podría
  intentar para pasar jsonOnlyMiddleware) depende de que el preflight
  de CORS rechace el origen del atacante — que depende a su vez de que
  `FRONTEND_URL` (env var, `main.ts`) esté configurado como un único
  origen específico, nunca `*` ni una lista abierta. Esto NO se
  verificó en vivo en este pase (no se cambió `FRONTEND_URL` a un
  valor de prueba para confirmar el rechazo real del preflight), y no
  hay ningún test automatizado (unitario ni de integración, en
  `sales` ni en ningún otro módulo) que fije este comportamiento como
  contrato — es una propiedad de la CONFIGURACIÓN de despliegue, no
  del código, y el código no la protege si la configuración cambia.
  Además, `sameSite: 'none'` en producción (`auth-cookie.ts`,
  necesario porque frontend y backend viven en dominios distintos)
  remueve la protección CSRF nativa del navegador que `SameSite`
  daría — toda la defensa real recae en jsonOnlyMiddleware + CORS
  estricto, ninguna de las dos pensada originalmente como "la" defensa
  CSRF de `sales` (jsonOnlyMiddleware se agregó en la Fase 10 de
  `auth` para un hallazgo de `POST /users`, no para `sales`).
ROOT CAUSE: no hay ninguna defensa CSRF explícita y dedicada (token
  sincronizador, doble-submit cookie, chequeo de header `Origin`/
  `Referer`) — la protección real es la combinación incidental de
  `jsonOnlyMiddleware` (que sí bloquea el vector de <form> nativo,
  confirmado) y una configuración de CORS correcta (que bloquearía el
  vector de fetch() cross-origin, pero sin ningún test que lo
  confirme ni lo proteja de una regresión futura de `FRONTEND_URL`).
IMPACTO SI FRONTEND_URL SE CONFIGURA MAL (p. ej. `*`, o se agrega un
  segundo origen de forma laxa en el futuro): un atacante con
  JavaScript en una página que la víctima (vendedora u OWNER con
  sesión activa) visite podría crear ventas arbitrarias en su nombre
  (con `Content-Type: application/json` real vía fetch), descontando
  stock real y generando movimientos de caja falsos — sin que la
  víctima haga nada más que tener la pestaña abierta.
FIX RECOMENDADO (no aplicado en esta fase, por regla del protocolo):
  agregar un test de integración que fije el comportamiento de CORS
  contra un origen no autorizado (confirmando el rechazo del
  preflight), y considerar un chequeo explícito de `Origin`/`Referer`
  en `jsonOnlyMiddleware` o un middleware hermano, como defensa
  independiente de la configuración de CORS — así el sistema no
  depende de UNA sola variable de entorno bien puesta para estar
  protegido contra CSRF en todas las rutas mutantes, `sales` incluida.
```

## 10. SSRF

No aplica — el módulo no hace ninguna llamada HTTP saliente ni recibe
URLs de usuario.

## 11. Path traversal

No aplica — sin operaciones de filesystem en el módulo.

## 12. Sensitive information exposure

Sin hallazgos nuevos. `POST /sales` devuelve el objeto `Sale` base
(`tx.sale.create` sin `include`) — sin `items`/`payments`/`discounts`
anidados en la respuesta (consistente con el gap de alcance ya
documentado en T4.11: no hay `GET /sales`/`GET /sales/:id` todavía), así
que **RN-10 (ocultar `costoUnitario` para `SELLER`) no tiene ninguna
superficie que auditar hoy** — no hay ninguna respuesta HTTP de este
módulo que incluya `costoUnitario` en absoluto. Cuando se construya el
endpoint de lectura (ticket futuro), esa es la fase que debe verificar
el ocultamiento — señalado para que no se pierda, no un hallazgo de
esta fase. El 500 genérico de `GlobalExceptionFilter` (confirmado en la
Fase 08 para el caso de desborde de precisión) no filtra ningún detalle
interno.

## 13. Secrets

Sin hallazgos. El módulo no maneja ni referencia ningún secreto
(`JWT_SECRET`, credenciales, API keys) — esas viven en `auth`/
`config/env.schema.ts`, ya auditadas en fases anteriores. `grep` de
patrones típicos de secretos en `src/modules/sales`: cero resultados.

## 14. Logs

Sin hallazgos. `pinoHttp` no tiene ningún serializer de `req.body`
configurado (confirmado leyendo `app.module.ts`) — montos, descuentos,
`referencia` de pagos e `Idempotency-Key` de este módulo nunca llegan a
un log. La redacción de cookies/JWT (`LOG_REDACT_PATHS`, Fase 10 de
`auth`) sigue activa globalmente y cubre `POST /sales` igual que
cualquier otra ruta — confirmado en los logs reales generados durante
la suite de integración de esta fase (`"cookie":"[REDACTED]"` en cada
línea).

## 15. Error handling

Sin hallazgos nuevos. El hallazgo de la Fase 08 (500 crudo por
desborde de precisión) era justamente de esta categoría y ya está
corregido — reconfirmado que ningún endpoint del módulo devuelve un
mensaje de error con stack trace o detalle interno: todo pasa por
`GlobalExceptionFilter`, que normaliza a `{statusCode, timestamp, path,
message}`. Verificado en vivo: 401/415 de esta misma fase ya vienen en
ese formato limpio.

## 16. Rate limiting

**Observación LOW, consistente con una decisión ya de sistema, no un
olvido de este módulo.** El único endpoint con `@nestjs/throttler` en
todo el backend es `/auth/login` — `POST /sales` no tiene límite de
frecuencia propio. Impacto real bajo: ya requiere una sesión
autenticada (no es un vector de fuerza bruta ni de enumeración anónima),
y cada intento de abuso queda limitado por la disponibilidad real de
stock y por `payments_monto_check`/el resto de las validaciones de
negocio — no hay ganancia obvia para un atacante en spamear el
endpoint más allá de un DoS de bajo impacto (que además requiere
credenciales válidas). Documentado para que quede registrado, mismo
criterio que `cash-registers`: si se decide agregar rate limiting a
rutas mutantes de dinero más allá de login, es una decisión transversal
a varios módulos, no específica de `sales`.

## 17. Dependencies

Sin hallazgos nuevos. `npm audit --omit=dev` (backend): **3 high**,
exactamente la misma cadena ya documentada en otras fases
(`prisma` CLI → `@prisma/config` → `deepmerge-ts`, TD-9) — es la
herramienta de línea de comandos usada en build/migraciones, no el
cliente de Prisma que corre en producción; no hay ningún endpoint HTTP
que la ejecute. `npm audit --omit=dev` (frontend): **0
vulnerabilidades**. Ningún commit de T4.1–T4.11 ni de las Fases 07/08
agregó una dependencia nueva.

## 18. Sensitive data storage

**Observación LOW.** `payments.referencia` (columna `TEXT`, sin
formato/patrón validado más allá de `@MaxLength(500)`) podría contener
un número de tarjeta completo si alguien lo pega ahí a mano — riesgo
típico de un campo de referencia de pago con tarjeta en cualquier POS.
En la práctica, **la pantalla real (`CobroPage.tsx`) nunca envía
`referencia`** — el payload que arma `handleConfirmarVenta` solo manda
`{ metodo, monto }` por pago, ningún campo de referencia existe hoy en
la UI de cobro. El campo queda accesible solo para quien llame a la
API directamente (fuera del producto real), lo que baja el riesgo
práctico de MEDIUM a LOW. Si en el futuro se agrega un campo de
referencia a la UI, vale la pena reconsiderar un aviso ("no ingreses el
número completo de la tarjeta") o un enmascarado, no bloqueante hoy.
Los montos se guardan como `Decimal` en Postgres sin necesidad de
cifrado (no son datos personales ni credenciales).

## 19. Incorrect permissions

Sin hallazgos — ver sección 2. La única ruta real (`POST /sales`)
verificada contra la matriz de permisos de la spec (sección 8), sin
discrepancias.

## 20. Unauthorized endpoints

Sin hallazgos nuevos — ver también la Fase 07. El único endpoint real
del controller (`POST /sales`) coincide con lo documentado. `GET
/sales`, `GET /sales/:id` y `POST /sales/:id/anular` **no existen**
(gap de alcance ya señalado, no una ruta fantasma sin protección —
literalmente no hay código que las sirva, así que no hay superficie
que auditar ahí todavía).

---

## Resumen

Sin CRITICAL. Un HIGH matizado (CSRF, sección 9): la protección real
existe y se reconfirmó en vivo para el vector más simple (`<form>`
nativo, bloqueado por `jsonOnlyMiddleware`), pero el vector de
fetch()/XHR cross-origin depende enteramente de que `FRONTEND_URL` esté
bien configurado en cada entorno, sin ningún test automatizado que fije
ese contrato ni ninguna defensa independiente de esa variable — es
frágil, no roto hoy. Dos observaciones LOW (sin `@ArrayMaxSize` en
`items`/`payments`/`discounts`; ausencia de rate limiting en `POST
/sales`, decisión de sistema ya existente) y una observación LOW
adicional (`referencia` de pago sin formato validado, riesgo bajo
porque la UI real no lo usa hoy). Una reconfirmación de deuda técnica
ya documentada (TD-9, `npm audit` de la cadena de `prisma` CLI).

**No se declara el módulo seguro de forma permanente.** El hallazgo de
CSRF (sección 9) es candidato real para la Fase 10 (remediación) —
aunque no bloquea el Quality Gate por sí solo (la protección de
`<form>` nativo funciona hoy, confirmado en vivo), un test que fije el
comportamiento de CORS contra un origen no autorizado, y evaluar un
chequeo de `Origin`/`Referer` independiente de esa configuración,
cierra la brecha real entre "funciona hoy" y "no puede dejar de
funcionar por un cambio de configuración sin que nadie lo note". La
Fase 11 (re-auditoría) corresponde antes de dar por cerrada la
seguridad del módulo.
