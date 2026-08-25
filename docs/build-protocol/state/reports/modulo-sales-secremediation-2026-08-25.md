# Security remediation — módulo `sales` (2026-08-25)

Fase 10 del protocolo. Corrige exclusivamente los hallazgos de
`state/reports/modulo-sales-secaudit-2026-08-25.md` (fase 09, VERDE
con un HIGH matizado y tres observaciones LOW). Sin funcionalidad
nueva, sin tocar nada fuera de esos hallazgos.

**No se declara el módulo seguro** — corresponde a la fase 11 (security
re-audit) confirmarlo de forma independiente.

## Vulnerabilidades corregidas

### Hallazgo 1 (HIGH matizado) — CSRF vía fetch()/XHR cross-origin dependía enteramente de la configuración de CORS

`jsonOnlyMiddleware` (de una fase anterior) ya bloqueaba el vector de
`<form>` HTML nativo contra `POST /sales` (confirmado en vivo en la
fase 09), pero el vector de fetch()/XHR cross-origin con
`Content-Type: application/json` real dependía enteramente de que
`FRONTEND_URL` (CORS, `main.ts`) rechazara el origen del atacante — sin
ningún chequeo independiente de esa variable, y sin ningún test
automatizado que fijara ese comportamiento como contrato.

Nuevo middleware `common/security/origin-check.middleware.ts`
(`OriginCheckMiddleware`, class-based con `ConfigService` inyectado),
registrado global en `AppModule.configure()` junto al resto de la
cadena de seguridad (`helmet()`, `jsonOnlyMiddleware`,
`OriginCheckMiddleware`, `cookieParser()`). Para cualquier request
POST/PUT/PATCH/DELETE, si el navegador mandó un header `Origin` (lo
manda siempre en un request cross-origin real; un request del mismo
origen o un cliente no-browser, como los tests de integración, no lo
manda), tiene que coincidir EXACTAMENTE con `FRONTEND_URL` — si no,
403 "Origen no autorizado" antes de llegar a ningún guard, DTO o
servicio. Es una segunda barrera independiente de CORS: aunque
`FRONTEND_URL` se configure mal en algún entorno (`*`, una lista
abierta, o un futuro bug en `main.ts`), esta capa sigue rechazando el
origen que no coincide.

Se aplica global (mismo criterio que `jsonOnlyMiddleware`, que
también nació de un hallazgo puntual — `/users` en la fase 10 de
`auth` — y se aplicó a todo el sistema): la clase de vulnerabilidad no
es específica de `sales`, y dejar el fix scoped solo a esta ruta
hubiera dejado el resto de los endpoints mutantes del sistema
(`cash-registers`, `stock`, `products`) con la misma exposición.

Verificado con el mismo método que encontró el hallazgo en la fase 09:
`curl -X POST /sales -H "Origin: https://evil.example.com" -H
"Content-Type: application/json" -H "Cookie: <cookie real>"` — antes
del fix, la request llegaba hasta `AuthGuard`/`crearVenta` (200/4xx de
negocio); después, 403 antes de tocar la sesión. Reconfirmado con un
test unitario del middleware (10 casos: sin `Origin` pasa, `Origin`
que coincide pasa, `Origin` distinto rechaza, `Origin: "null"`
rechaza igual — vector típico de iframe sandboxed para esquivar
allowlists —, métodos no mutantes `GET`/`HEAD`/`OPTIONS` con `Origin`
distinto pasan igual, métodos mutantes `PUT`/`PATCH`/`DELETE` con
`Origin` distinto rechazan igual que `POST`) y dos tests de
integración HTTP reales contra `POST /sales` (`Origin` cross-site →
403, nada escrito; `Origin` igual a `FRONTEND_URL` real → sigue
funcionando, 201).

### Hallazgo 2 (LOW) — sin cota superior en los arrays de `CreateSaleDto`

`items`/`payments`/`discounts` no tenían `@ArrayMaxSize` — un body con
decenas de miles de líneas pasaba la validación de forma (cada entrada
individual es válida) y llegaba íntegro a `crearVenta`, que arma un
`Prisma.join(variantIds)` y un `tx.sale.create` nested de esa misma
longitud.

`@ArrayMaxSize(500)` en `items`, `@ArrayMaxSize(20)` en `payments` y
`discounts` — mismo criterio que `create-variant-grid.dto.ts`
(`@ArrayMaxSize(1000)` para su propia grilla): un techo generoso, muy
por encima de cualquier venta real de mostrador, sin inventar un
límite de negocio más ajustado que el blueprint no pide. Dos tests de
integración nuevos (501 líneas en `items` → 400; 21 pagos → 400), sin
tocar ningún test existente.

## Problemas señalados en la fase 09, NO corregidos acá (a propósito)

- **`referencia` de pago sin formato validado** (LOW): la fase 09 ya
  concluyó que el riesgo práctico es bajo porque la UI real
  (`CobroPage.tsx`) nunca envía este campo hoy — corregirlo
  implicaría inventar una regla de negocio ("qué hace válida una
  referencia") que ni el blueprint ni la spec del módulo definen
  (CLAUDE.md regla 2). Queda documentado, no bloqueante.
- **Sin rate limiting en `POST /sales`** (LOW): la fase 09 lo
  clasificó explícitamente como una decisión de sistema ya existente
  (el único endpoint con `@nestjs/throttler` en todo el backend es
  `/auth/login`), no un problema específico de este módulo — corregirlo
  acá de forma aislada crearía una inconsistencia nueva en vez de
  resolver una. Si se decide agregar rate limiting a rutas mutantes de
  dinero más allá de login, es una decisión transversal a varios
  módulos, fuera del alcance de esta fase (regla explícita: "no
  modifiques problemas que no estén relacionados").

## Tests

- Unitarios: **346/346** (336 previos + 10 nuevos en
  `origin-check.middleware.spec.ts`).
- Integración: **288/288** (284 previos + 4 nuevos:
  `Origin` cross-site → 403 en `POST /sales`; `Origin` igual a
  `FRONTEND_URL` → sigue funcionando; más de 500 `items` → 400; más de
  20 `payments` → 400).
- Ningún test existente se eliminó, debilitó ni se dejó deshabilitado.

## Regresión

Suite completa de integración (26 archivos, todos los módulos, no solo
`sales`) corrida después de cada fix, no solo los tests nuevos —
288/288 en verde en la corrida final. La suite unitaria completa
también corrió después de cada cambio, no solo el archivo tocado.

## Build

`tsc --noEmit`, `npm run lint` y `npm run build` (backend) en verde.
Frontend no se tocó — los hallazgos de la fase 09 eran todos de
backend (el hallazgo de `referencia` en la UI se confirmó leyendo
`CobroPage.tsx`, no se modificó nada ahí).

## Problemas pendientes

- Ninguno bloqueante. Los dos hallazgos LOW no corregidos (arriba)
  quedan documentados como aceptados, no como deuda olvidada.
- La Fase 11 (re-auditoría) corresponde antes de dar por cerrada la
  seguridad del módulo — en particular, debería reconfirmar en vivo
  que `OriginCheckMiddleware` no introdujo ningún falso positivo contra
  el frontend real (verificado acá solo con el valor de `FRONTEND_URL`
  del entorno de test, `http://localhost:5173`, no contra un
  despliegue con `sameSite: 'none'` real).
