# Security re-audit — módulo `auth` (2026-08-23)

Fase 11 del protocolo. Fase 10 (remediación) VERDE, verificado en
`state/STATUS.md` antes de empezar. Ningún archivo modificado durante
esta fase (regla explícita) — solo lectura de código, corridas de test
existentes, y verificación empírica contra el server real levantado
localmente. Servidor de desarrollo detenido al terminar.

No se asumió que ningún fix de la fase 10 fuera correcto solo porque el
reporte de esa fase lo dijera — cada uno se volvió a verificar acá,
independientemente, contra `state/reports/modulo-auth-secaudit-2026-08-23.md`.

## Previous vulnerabilities

Las 6 de la fase 09 (`modulo-auth-secaudit-2026-08-23.md`):

1. **CRITICAL** — sin protección CSRF real (la API aceptaba bodies
   `application/x-www-form-urlencoded` en rutas de mutación).
2. **HIGH** — el JWT de sesión quedaba en texto plano en cada línea de
   log.
3. **MEDIUM** — sin headers de seguridad básicos (sin `helmet`).
4. **MEDIUM** — `JWT_SECRET`/`COOKIE_SECRET` con longitud mínima débil
   (16 caracteres) y `COOKIE_SECRET` sin usar en ningún lado.
5. **LOW** — el fix de `X-Powered-By` de la fase 08 no cubría las
   respuestas OPTIONS de preflight de CORS.
6. **LOW** — `prisma` (CLI) listado como dependencia de producción en
   vez de dev, con 3 advisories HIGH de `npm audit` en su cadena.

## Fixed

**1 (CRITICAL, CSRF) — confirmado corregido.** Re-verificado contra el
server real (no solo los tests): `curl -X POST /auth/login` y
`curl -X POST /users`, ambos con `Content-Type:
application/x-www-form-urlencoded`, dan **415** — el body nunca llega a
`validateUser()` ni a `UsersService.create()`. Un login legítimo con
`Content-Type: application/json` sigue funcionando (401 por credenciales
incorrectas, no 415/400) — el fix no rompió el flujo real. Test de
integración dedicado en ambos módulos (`auth.integration.spec.ts`,
`users.integration.spec.ts`), corrido y en verde.

**2 (HIGH, JWT en logs) — confirmado corregido.** Corrida completa de
`npm run test:integration` (43 tests, incluye decenas de logins/logouts
reales) contra el log real: **0** apariciones de un JWT en texto plano,
**102** apariciones de `"cookie":"[REDACTED]"` / `[REDACTED]` en su
lugar. Se buscó explícitamente cualquier `"cookie":"access_token=` sin
censurar — no hay ninguna.

**3 (MEDIUM, sin headers de seguridad) — confirmado corregido.**
`X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: ...` presentes en una respuesta real del
server (`GET /health`).

**4 (MEDIUM, secretos débiles) — confirmado corregido, y de la forma
más fuerte posible.** `env.schema.ts` tiene `JWT_SECRET: z.string().min(32)`
y ya no declara `COOKIE_SECRET`. Más importante: el usuario regeneró el
`JWT_SECRET` real de su `backend/.env` (32 bytes, vía
`RandomNumberGenerator` de .NET) y sacó `COOKIE_SECRET` de `.env` y
`.env.example`. Se confirmó **sin ningún override de variables de
entorno** — a diferencia de las fases 09 y 10, donde hubo que forzar un
`JWT_SECRET` temporal por shell porque el `.env` real todavía no
cumplía el mínimo —: el server levantó limpio (`npm run start:dev`) y
`npm run test:integration` corrió 43/43 en verde contra el `.env` real
tal cual quedó en el filesystem. Es la confirmación más directa posible
de que el mínimo de 32 caracteres se está cumpliendo de verdad, no solo
en el código.

**5 (LOW, X-Powered-By en preflight) — confirmado corregido.**
`curl -X OPTIONS /auth/login` con los headers reales de un preflight de
CORS (`Origin`, `Access-Control-Request-Method`) contra el server con
`enableCors()` activo (no el `TestingModule` de los tests, que lo
bypassea) — sin `X-Powered-By` en la respuesta. Este es exactamente el
escenario que el fix de la fase 08 no cubría; ahora sí.

**6 (LOW, `prisma` como dependencia de producción) — corregido en lo
que es corregible.** `prisma` está en `devDependencies`. Se re-confirma
la nota honesta de la fase 10: `npm audit --omit=dev` sigue marcando la
misma cadena porque `@prisma/client` (dependencia real de producción)
declara `prisma: '*'` como `peerDependency` — esto no es corregible
desde este `package.json`, es un detalle de cómo Prisma empaqueta su
CLI y su cliente. La clasificación LOW se mantiene: el código
vulnerable (`deepmerge-ts` vía `@prisma/config`) solo lo dispara el CLI
de `prisma`, nunca un request real de esta app.

## Remaining

Ninguno de los 6 hallazgos de la fase 09 sigue abierto como
vulnerabilidad de código. Lo único que sigue "pendiente" es la
limitación externa ya documentada en el hallazgo 6 (advisory de
`npm audit` no resoluble sin un patch de Prisma) — no es una
vulnerabilidad explotable desde esta app, es deuda de dependencias.

## New findings

Ninguno. Se revisó específicamente si los fixes de la fase 10
introducían algo nuevo:

- El middleware `json-only` (`common/security/json-only.middleware.ts`):
  se probó el caso límite de un request sin ningún header `Content-Type`
  — lo deja pasar (para no romper `POST /auth/logout`, que no manda
  body). Esto no reabre el CSRF: sin `Content-Type`, Nest no parsea el
  body como JSON de todos modos, así que cualquier intento de mandar
  campos (email/password/rol, etc.) sin declarar `application/json`
  sigue sin poder popular `req.body` — cae en un 400 de validación
  normal, no en una mutación real. Se probó también con mayúsculas
  (`Content-Type: APPLICATION/JSON`, pasa por el `.toLowerCase()`) y con
  charset (`application/json; charset=utf-8`, pasa por el `.startsWith()`)
  — ningún caso reabre el vector.
- El 415 que devuelve el middleware no expone información nueva (mensaje
  genérico, sin stack ni detalles internos).
- `app.disable('x-powered-by')` y `helmet()`: sin efectos secundarios
  encontrados — no hay ninguna dependencia del código en el header
  `X-Powered-By` ni en el comportamiento por defecto de Express que
  `helmet` modifica (CSP, HSTS, etc. no chocan con nada del frontend
  actual, que no carga recursos de terceros).
- Eliminar `COOKIE_SECRET` del schema: no hay ninguna referencia rota
  (ya se había confirmado en fase 10 que no se usaba en ningún lado del
  código; `cookieParser()` sigue llamándose sin argumento, sin cambios).

## Security status

**No bloqueado.** Los dos hallazgos que bloqueaban el Quality Gate en
la fase 09 (1 CRITICAL, 1 HIGH de autenticación) están confirmados
corregidos con verificación independiente, no solo revisión de código.
Los 3 MEDIUM/LOW también. No se encontró ningún CRITICAL o HIGH nuevo.

29/29 tests unitarios, 43/43 tests de integración (corridos sin ningún
override de entorno, contra el `.env` real), lint y build en verde.

**Aun así, no se declara el módulo `auth` "seguro" en un sentido
absoluto** — una re-auditoría interna no reemplaza una revisión externa
ni un pentest, y quedan fuera de alcance de este ciclo cosas como un
análisis de dependencias más profundo (SCA dedicado) o pruebas de carga
adversariales. Para lo que este protocolo pide en esta fase — que las
vulnerabilidades reportadas estén de verdad corregidas, que los fixes
no rompieran ni introdujeran nada nuevo, y que no haya CRITICAL/HIGH
pendiente — el resultado es que el módulo pasa. La fase 12 (production
readiness) es la que decide si el módulo está listo para producción en
conjunto con el resto de los criterios del Quality Gate.

## Nota fuera de alcance

`backend/.env.example` quedó con una modificación sin commitear (el
usuario sacó la línea `COOKIE_SECRET=` con el script de PowerShell,
como se le indicó en la fase 10). No se tocó ni se commiteó como parte
de esta fase (regla de "no modifiques ningún archivo") — queda a
criterio del usuario revisarlo y commitearlo.
