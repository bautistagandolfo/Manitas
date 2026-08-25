# Security Re-audit — módulo `sales` (2026-08-25)

Fase 11 del protocolo. **Sin archivos modificados** (regla explícita de
la fase). Verificación independiente contra
`state/reports/modulo-sales-secaudit-2026-08-25.md` (fase 09) y
`state/reports/modulo-sales-secremediation-2026-08-25.md` (fase 10),
con re-chequeos empíricos en vivo contra el servidor real, no solo
relectura de los reportes anteriores.

Confirmado primero qué cambió entre la fase 09 y la fase 10:
`git log fase09-secaudit-sales..fase10-secremediation-sales -- backend/src
backend/prisma frontend/src` devuelve exactamente un commit (`8ff49aa`),
coincidiendo con lo documentado en la fase 10 — sin ningún cambio de
código adicional o no declarado entre las dos fases.

## Previous vulnerabilities

La fase 09 encontró:

1. **HIGH matizado (CSRF, sección 9)**: `jsonOnlyMiddleware` ya
   bloqueaba el vector de `<form>` HTML nativo, pero el vector de
   fetch()/XHR cross-origin dependía enteramente de que `FRONTEND_URL`
   (CORS) estuviera bien configurado, sin ningún chequeo independiente
   ni test que fijara ese contrato.
2. **LOW (sección 6)**: sin `@ArrayMaxSize` en `items`/`payments`/
   `discounts` de `CreateSaleDto`.
3. **LOW (sección 16)**: sin rate limiting en `POST /sales` — decisión
   de sistema ya existente, no específica de este módulo.
4. **LOW (sección 18)**: `payments.referencia` sin formato validado —
   riesgo bajo porque la UI real nunca envía este campo.

## Fixed

**Hallazgo 1 (HIGH matizado) — corregido, reconfirmado en vivo.**
`OriginCheckMiddleware` sigue registrado en `AppModule.configure()`
(línea 113 de `app.module.ts`, verificado leyendo el archivo tal como
quedó en el commit `8ff49aa`). Reproducido de nuevo, EN VIVO contra el
servidor real (`curl -X POST /sales -H "Content-Type: application/json"
-H "Origin: https://evil.example.com"`):

```
{"statusCode":403,"message":"Origen no autorizado"}
```

Antes del fix (fase 09), este mismo request llegaba hasta `AuthGuard`
(401 "No hay sesión activa" — el error de la CAPA SIGUIENTE, prueba de
que el request pasaba sin ningún rechazo por `Origin`). Ahora se
rechaza en la capa de middleware, antes de tocar la sesión. Reconfirmado
que el camino legítimo sigue intacto: `Origin: http://localhost:5173`
(el valor real de `FRONTEND_URL` en este entorno) y sin ningún header
`Origin` en absoluto dan exactamente el mismo resultado que antes del
fix (401 "No hay sesión activa", sin cookie) — el middleware no
introdujo ningún falso positivo contra el flujo real.

Los 10 tests unitarios de `origin-check.middleware.spec.ts` y los 2
tests de integración HTTP nuevos de `sales-controller.integration.spec.ts`
(caso 15: `Origin` cross-site → 403, nada escrito; caso 16: `Origin`
real → sigue funcionando, 201) corridos de nuevo — **12/12 verde**.

**Hallazgo 2 (LOW) — corregido, reconfirmado.** `@ArrayMaxSize(500)` en
`items`, `@ArrayMaxSize(20)` en `payments`/`discounts` de
`CreateSaleDto`, verificado presente en el archivo actual. Los 2 tests
de integración nuevos (caso 12b: 501 líneas en `items` → 400; caso 12c:
21 pagos → 400) corridos de nuevo — **2/2 verde**.

## Remaining

Las 2 LOW que la fase 10 dejó documentadas a propósito (no
corregidas) siguen exactamente igual, sin agravarse:

- **Sin rate limiting en `POST /sales`.** Riesgo bajo reconfirmado:
  sigue exigiendo una sesión autenticada (no es un vector de fuerza
  bruta ni enumeración anónima), mismo criterio ya aceptado en
  `cash-registers`.
- **`payments.referencia` sin formato validado.** Riesgo bajo
  reconfirmado: `CobroPage.tsx` sigue sin enviar este campo (grep de
  `referencia` en el archivo: cero resultados, igual que en la fase
  09) — el campo solo es alcanzable por un cliente HTTP directo, fuera
  del producto real.

Ninguna de las dos bloquea el Quality Gate (son observaciones LOW,
documentadas, no CRITICAL/HIGH/MEDIUM pendiente).

## New findings

Ninguno. Sin código modificado en esta fase, así que no hay superficie
nueva que un fix pudiera haber introducido — el checklist "que los
fixes no introduzcan nuevas vulnerabilidades" (punto 2 de esta fase) se
verificó de forma NO trivial acá (a diferencia de un caso sin fixes de
código): se confirmó explícitamente que `OriginCheckMiddleware` no
rompe el camino legítimo (arriba) y que su orden de registro
(`helmet()`, `jsonOnlyMiddleware`, `OriginCheckMiddleware`,
`cookieParser()`) no genera un bypass — los métodos no mutantes
(`GET`/`HEAD`/`OPTIONS`, incluido el preflight real de CORS) pasan sin
tocar el chequeo de `Origin`, reconfirmado con un `curl -X OPTIONS
/sales` real: `X-Powered-By` ausente, sin ningún 403 inesperado.

Re-chequeos empíricos adicionales, específicos de este módulo, corridos
de nuevo contra el servidor real (no solo releídos de fases
anteriores):

- **Autenticación**: `POST /sales` sin cookie → **401** (reconfirmado
  en vivo).
- **CSRF, vector `<form>` nativo**: `Content-Type:
  application/x-www-form-urlencoded` → **415** (reconfirmado en vivo,
  mismo resultado que la fase 09 — `jsonOnlyMiddleware` no se tocó en
  la fase 10, sigue intacto).
- **Headers de seguridad**: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN` presentes, `X-Powered-By` ausente
  (reconfirmado en vivo, tanto en una respuesta 401 real como en el
  preflight `OPTIONS`).
- **Regresión completa**: 346/346 unitarios, 288/288 integración
  (Postgres real, 26 archivos, todos los módulos, no solo `sales`) —
  ambas suites corridas desde cero en esta fase, no reusadas de la
  fase 10.

## Security status

**Sin CRITICAL ni HIGH.** El único HIGH matizado de la fase 09 está
corregido y reconfirmado en vivo, sin efectos secundarios detectados
sobre el flujo legítimo. Dos LOW siguen documentadas y no bloqueantes,
sin agravarse. El módulo pasa la fase 11 con verificación empírica real
contra el servidor corriendo, no solo por ausencia de cambios de
código.

**El módulo `sales` queda en condiciones de avanzar a la fase 12
(production readiness) cuando corresponda** — no se declara terminado
ni "listo para producción" acá, eso lo decide específicamente la fase
12.
