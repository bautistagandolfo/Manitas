# Security remediation — módulo `auth` (2026-08-23)

Fase 10 del protocolo. Corrige exclusivamente los hallazgos de
`state/reports/modulo-auth-secaudit-2026-08-23.md` (fase 09, BLOQUEADO).
Sin funcionalidad nueva, sin tocar nada fuera de esos hallazgos.

**No se declara el módulo seguro** — corresponde a la fase 11 (security
re-audit) confirmarlo de forma independiente.

## Vulnerabilidades corregidas

### Hallazgo 1 (CRITICAL) — CSRF vía `application/x-www-form-urlencoded`

Nuevo middleware `common/security/json-only.middleware.ts`, registrado
global en `AppModule.configure()`: cualquier request con método
POST/PUT/PATCH/DELETE cuyo `Content-Type` no sea `application/json` se
rechaza con 415 antes de llegar a ningún guard, DTO o servicio. Un
`<form>` HTML nativo solo puede mandar
`application/x-www-form-urlencoded`, `multipart/form-data` o
`text/plain` — nunca `application/json` — así que el vector queda
cerrado por completo, sin afectar al frontend real (que ya mandaba
`Content-Type: application/json` siempre, body o no).

Verificado con el mismo método que encontró el bug en la fase 09: `curl
-X POST /auth/login -H "Content-Type: application/x-www-form-urlencoded"`
ahora da 415 (antes daba 401, es decir, el body llegaba a
`validateUser()`). Test de integración nuevo en `auth.integration.spec.ts`
y `users.integration.spec.ts` (este último confirma además que ningún
usuario se crea).

### Hallazgo 2 (HIGH) — JWT de sesión en texto plano en los logs

`LoggerModule.forRootAsync` en `app.module.ts` ahora configura
`redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' }`, con
`LOG_REDACT_PATHS` (`req.headers.cookie`, `req.headers.authorization`,
`res.headers["set-cookie"]`) extraído a `config/logger.config.ts`.
Cubre tanto la cookie que manda el cliente en cada request como el
`Set-Cookie` que emite el propio `/auth/login` al loguear a alguien
(antes solo se había señalado la primera en la auditoría; la segunda
es la misma clase de fuga y quedaba igual de expuesta).

Verificado con `pino` real corriendo con esta config exacta
(`logger.config.spec.ts`, 4 tests) y, de nuevo, contra el server real:
una corrida completa de `test:integration` mostró
`"cookie":"[REDACTED]"` en el log en vez del JWT.

### Hallazgo 3 (MEDIUM) — sin headers de seguridad básicos

`helmet()` agregado como middleware global en `AppModule.configure()`
(no en `main.ts`, para que también corra en los tests de integración,
que arman la app con `TestingModule` + `createNestApplication()` sin
pasar por `bootstrap()`). Cubre X-Frame-Options, Content-Security-Policy,
X-Content-Type-Options, HSTS, etc. — verificado con un test de
integración nuevo y contra el server real.

### Hallazgo 4 (MEDIUM) — `JWT_SECRET`/`COOKIE_SECRET` con longitud mínima débil

`JWT_SECRET` en `env.schema.ts`: `.min(16)` → `.min(32)`. `COOKIE_SECRET`
eliminado del schema (no se usaba en ningún lado — `cookieParser()` se
llama sin argumento; exigirlo daba una falsa sensación de que las
cookies estaban firmadas). `.github/workflows/ci.yml` actualizado para
usar un `JWT_SECRET` de CI de más de 32 caracteres y sacar
`COOKIE_SECRET`.

### Hallazgo 5 (LOW) — el fix de `X-Powered-By` de fase 08 no cubría el preflight OPTIONS

El diagnóstico original (helmet en `main.ts`) resultó insuficiente: se
verificó empíricamente que ni el `removeHeader` manual de fase 08 ni
`helmet()` como middleware sacan el header de una respuesta OPTIONS de
preflight — Express lo vuelve a agregar al finalizar la respuesta sin
importar qué haya hecho un middleware antes. El fix real es
`app.disable('x-powered-by')`, un setting de la app (no un header
removible), aplicado una sola vez en `AppModule.onModuleInit()` vía
`HttpAdapterHost` — corre tanto en `bootstrap()` como en los tests de
integración. Verificado: antes del fix, `curl -X OPTIONS /auth/login`
seguía devolviendo `X-Powered-By: Express`; después, no. Test de
integración nuevo que cubre esta respuesta específicamente.

### Hallazgo 6 (LOW) — `prisma` (CLI) como dependencia de producción

`prisma` movido de `dependencies` a `devDependencies` en
`backend/package.json` — coincide con la recomendación oficial de
Prisma (el CLI no corre en el runtime del server, solo en
build/migrate/seed). CI usa `npm ci` (instala devDependencies también),
y Render corre `prisma migrate deploy` como paso previo al arranque
dentro del mismo build (BLUEPRINT §9.10) — moverlo no rompe ningún
paso existente, verificado contra `.github/workflows/ci.yml`.

**Nota honesta:** `npm audit --omit=dev` sigue reportando la misma
cadena (`deepmerge-ts` vía `@prisma/config` vía `prisma`) después del
cambio. Investigado por qué: `@prisma/client` (dependencia real de
producción) declara `prisma: '*'` como `peerDependency` — así que
`prisma` sigue siendo alcanzable desde el grafo de producción sin
importar dónde se lo declare en `package.json` (confirmado con
`npm ls prisma --omit=dev`). Este es un detalle estructural de cómo
Prisma empaqueta su CLI y su cliente, no algo corregible desde este
`package.json`. La clasificación LOW de la fase 09 sigue siendo la
correcta: el código vulnerable no se ejecuta nunca a partir de un
request real de esta app (solo lo dispara el CLI de Prisma, invocado a
mano o en build/deploy). Sigue pendiente un patch de Prisma que no sea
breaking (el disponible hoy fuerza downgrade a 6.12.0).

## Tests

- Unitarios: **29/29** (25 previos + 4 nuevos en
  `config/logger.config.spec.ts`, que corren `pino` real con la config
  de redact exacta contra un log de muestra).
- Integración: **43/43** (39 previos + 4 nuevos: CSRF/415 en
  `POST /auth/login` y `POST /users`, X-Powered-By ausente en OPTIONS,
  headers de helmet presentes).
- Ningún test existente se eliminó, debilitó ni se dejó
  deshabilitado.

## Regresión

Toda la suite de integración (`auth`, `users`, más los otros 2 archivos
de integración del repo) corrió completa después de cada fix, no solo
los tests nuevos — 43/43 en verde en la corrida final.

## Build

`npm run build` (backend) y `npm run lint` (backend) en verde. Frontend
no se tocó — fuera del alcance de esta fase (los hallazgos de la fase
09 eran todos de backend).

## Problemas pendientes

- **Acción manual del usuario, no corregible por el agente:** el
  `backend/.env` local tiene un `JWT_SECRET` de menos de 32 caracteres
  — desde este fix, el server no arranca así (`Variables de entorno
  inválidas: JWT_SECRET: Too small`). El agente no puede leer ni editar
  `.env`/`.env.example` (bloqueado por `.claude/settings.json`, a
  propósito). Hay que generar uno nuevo de al menos 32 caracteres (por
  ejemplo `openssl rand -base64 32`) y actualizar `backend/.env` a mano
  — también en cualquier entorno de producción/staging ya desplegado.
  Todos los tests y verificaciones de esta fase se corrieron pasando un
  `JWT_SECRET` largo por variable de entorno del shell (no toca el
  `.env`, dotenv no pisa una variable ya seteada).
- `backend/.env.example` todavía tiene la línea `COOKIE_SECRET=`, por
  la misma restricción de edición — hay que sacarla a mano (cosmético,
  no funcional: el schema ya no la exige).
- Hallazgo 6: ver nota arriba — sigue habiendo un advisory HIGH de
  `npm audit` en la cadena de `prisma`, no corregible desde este
  `package.json`; el riesgo real sigue siendo bajo (nunca se ejecuta a
  partir de un request). Reevaluar cuando Prisma publique un patch no
  breaking.
