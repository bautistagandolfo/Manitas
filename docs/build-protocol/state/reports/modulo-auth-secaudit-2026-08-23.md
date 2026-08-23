# Security audit — módulo `auth` (2026-08-23)

Fase 09 del protocolo. Fase 08 (QA adversarial) VERDE, verificado en
`state/STATUS.md` antes de empezar. Auditoría de código (frontend +
backend) más algunas verificaciones empíricas puntuales contra el server
de desarrollo (curl directo — no se modificó código en ningún momento,
solo se leyó y se lanzaron requests de lectura/prueba). Servidor de
desarrollo parado al terminar.

No se asume que ninguna protección existente sea correcta — varias de las
verificadas abajo se confirmaron mirando el request/response real, no
solo el código.

---

## Hallazgo 1 — Sin protección CSRF real: la API acepta bodies `application/x-www-form-urlencoded` en rutas que mutan estado

```
SEVERITY: CRITICAL
UBICACIÓN: backend/src/main.ts (bootstrap — body parser default de Nest,
  nunca restringido) + backend/src/modules/auth/auth.controller.ts
  (POST /auth/login) + backend/src/modules/auth/users.controller.ts
  (POST /users).
CAUSA: NestFactory.create(AppModule, ...) no pasa { bodyParser: false },
  así que Nest habilita los parsers de Express para JSON *y* para
  application/x-www-form-urlencoded en toda la app, sin distinción por
  ruta. Ningún guard, middleware o DTO restringe el Content-Type
  aceptado. La única defensa contra requests cross-site es CORS
  (origin fijo a FRONTEND_URL, sin reflejar el Origin del request —
  verificado correcto), pero CORS **no** protege nada acá: un
  <form method="POST"> HTML nativo (sin JavaScript) solo puede enviar
  application/x-www-form-urlencoded, multipart/form-data o text/plain —
  los tres son "simple requests" del estándar Fetch/CORS, por lo que el
  navegador nunca dispara preflight ni bloquea el envío, sin importar
  qué diga la política de CORS del servidor. CORS solo le impide al
  atacante *leer la respuesta* via JavaScript, no impide que el server
  reciba y procese el POST con efectos secundarios reales.
  Verificado empíricamente: `curl -X POST /auth/login -H
  "Content-Type: application/x-www-form-urlencoded" --data
  "email=...&password=..."` devolvió 401 (credenciales incorrectas),
  no 400 — es decir, el body llegó, pasó el ValidationPipe y llegó a
  AuthService.validateUser() exactamente igual que si hubiera sido JSON.
IMPACTO: en producción, la cookie de sesión usa `SameSite=None; Secure`
  (necesario porque frontend y backend viven en dominios distintos —
  auth-cookie.ts) — el caso más permisivo de SameSite, pensado para que
  la cookie viaje en requests cross-site legítimos del propio frontend,
  pero que también permite que viaje (o se fije) en un POST cross-site
  disparado por cualquier página, sin que el usuario haga nada más que
  abrirla.
ESCENARIO DE EXPLOTACIÓN:
  (A) Toma de cuenta OWNER completa, sin interacción real de la víctima:
      un OWNER logueado en Manitas (sesión activa en otra pestaña) abre
      cualquier página que el atacante controle (puede ser un iframe
      oculto en un sitio de terceros). Esa página tiene un
      <form method="POST" action="https://api.manitas.example/users"
      enctype="application/x-www-form-urlencoded"> con
      email=atacante@evil.com, password=..., nombre=X, rol=OWNER, y se
      auto-envía con JS (`form.submit()`) al cargar. El navegador manda
      el POST con la cookie real del OWNER (SameSite=None la deja pasar
      cross-site). AuthGuard valida el JWT (es legítimo, es la sesión
      real del OWNER) y RolesGuard lo deja pasar porque el usuario real
      *es* OWNER. Resultado: un OWNER nuevo, con contraseña conocida
      por el atacante, creado silenciosamente — control total del
      sistema (incluida la capacidad de desactivar al OWNER original,
      ver fase 08).
  (B) Login-CSRF: sin necesitar sesión previa, el mismo tipo de
      formulario contra POST /auth/login con credenciales que el
      atacante ya conoce (una cuenta propia, o una robada) fuerza a la
      víctima a autenticarse como el atacante sin que se dé cuenta —
      cualquier venta, movimiento de stock o dato que cargue después
      queda atribuido a la cuenta del atacante, y el atacante puede
      revisarlo después iniciando sesión normalmente.
SOLUCIÓN RECOMENDADA: rechazar cualquier request cuyo Content-Type no
  sea exactamente `application/json` en toda ruta que mute estado (lo
  más simple: `NestFactory.create(AppModule, { bodyParser: false })` +
  registrar explícitamente solo `express.json()`, o un middleware/guard
  global que valide el header antes del body parser). Esto cierra el
  vector por completo: un <form> HTML nunca puede producir
  application/json, así que cualquier intento cross-site cae en un 415
  antes de llegar al DTO. Las llamadas legítimas del frontend
  (http-client.ts) ya mandan siempre 'Content-Type': 'application/json',
  así que el fix no rompe nada existente. Complementar con verificación
  de `Origin`/`Referer` en rutas de mutación es defensa en profundidad
  opcional, pero el fix de Content-Type ya resuelve el problema raíz.
```

## Hallazgo 2 — El token de sesión (JWT) queda en texto plano en los logs de cada request

```
SEVERITY: HIGH
UBICACIÓN: backend/src/app.module.ts (LoggerModule.forRootAsync —
  configuración de nestjs-pino/pino-http).
CAUSA: la config de pinoHttp solo define `level` y `transport`; no hay
  `redact` ni serializers custom. El serializer por defecto de
  pino-http vuelca `req.headers` completo en cada línea de log,
  incluyendo el header `cookie` tal cual llega. Verificado empíricamente
  contra el log real del server en desarrollo: cada "request completed"
  incluye un objeto `headers` con todo lo recibido — en un request con
  la cookie de sesión puesta, `access_token=<JWT>` aparecería ahí en
  texto plano, en cada una de las requests que haga un usuario logueado
  (prácticamente todo el tráfico autenticado de la app).
IMPACTO: el JWT es la única credencial de sesión (stateless, BLUEPRINT
  §9.6) — quien lo tenga puede actuar como ese usuario hasta que expire
  (máximo 12h) sin volver a necesitar contraseña. httpOnly protege
  contra robarlo desde el navegador (XSS), pero no aporta nada contra
  esto: el token queda expuesto en un canal totalmente distinto
  (logs), accesible a cualquiera con permiso de lectura de logs —
  un servicio de logging mal configurado como público, un colaborador
  con acceso de solo-lectura a logs para debugging, un proveedor de
  hosting con un dashboard de logs compartido, etc. Esto incluye
  sesiones de OWNER.
ESCENARIO DE EXPLOTACIÓN: alguien con acceso de lectura a los logs de
  producción (Render u otro hosting, según BLUEPRINT) busca líneas con
  `"cookie":"access_token=` en las últimas horas, copia un token de una
  sesión de OWNER todavía vigente, y lo usa directamente como cookie
  en sus propios requests — sesión secuestrada sin tocar la base de
  datos ni necesitar la contraseña.
SOLUCIÓN RECOMENDADA: agregar `redact` a la config de pinoHttp
  (mínimo: `redact: ['req.headers.cookie', 'req.headers.authorization']`,
  con censura, no solo omisión, para no perder la forma del log). Repetir
  la verificación empírica después del fix (grep del log por
  `access_token` tras un request autenticado) antes de dar por cerrado.
```

## Hallazgo 3 — Sin headers de seguridad básicos (CSP, X-Frame-Options, HSTS, etc.)

```
SEVERITY: MEDIUM
UBICACIÓN: backend/src/main.ts / backend/src/app.module.ts — no hay
  `helmet` ni configuración manual de estos headers en ningún lado del
  módulo (solo se remueve X-Powered-By, ver fase 08).
CAUSA: nunca se agregó helmet u otro middleware equivalente.
IMPACTO: la pantalla de login (`/login` en el frontend) es la única
  ruta pública que pide credenciales — sin `X-Frame-Options: DENY` o
  una CSP con `frame-ancestors 'none'`, nada impide que un atacante la
  embeba en un <iframe> dentro de otra página y superponga una UI
  encima (clickjacking) para inducir a la víctima a escribir sus
  credenciales pensando que está en otro contexto, o a hacer clic donde
  el atacante quiere. Sin CSP tampoco hay una segunda capa de defensa
  contra XSS si en el futuro se introduce un sink (hoy no hay ninguno
  verificado — ver sección XSS más abajo).
ESCENARIO DE EXPLOTACIÓN: un atacante embebe manitas.example/login en
  un iframe transparente superpuesto a un botón atractivo en su propio
  sitio; la víctima cree que interactúa con el sitio del atacante pero
  en realidad sus clicks/tipeo caen sobre el iframe de Manitas.
SOLUCIÓN RECOMENDADA: agregar `helmet` con su configuración por
  defecto (cubre X-Frame-Options, X-Content-Type-Options, HSTS en
  producción, y más) como primer middleware de la app — reemplaza
  también, de paso, el removeHeader manual de X-Powered-By del
  hallazgo 5.
```

## Hallazgo 4 — `JWT_SECRET`/`COOKIE_SECRET` con longitud mínima insuficiente para HMAC

```
SEVERITY: MEDIUM
UBICACIÓN: backend/src/config/env.schema.ts, líneas 10-11.
CAUSA: `z.string().min(16)` para ambos. 16 caracteres (128 bits si son
  aleatorios de verdad, bastante menos si es una passphrase memorable)
  está por debajo de las 256 bits (32 bytes) que se recomiendan como
  mínimo para una clave HMAC-SHA256 (la que usa @nestjs/jwt/jsonwebtoken
  por defecto para HS256). Un secreto corto o poco aleatorio es más
  viable de fuerza-brutear offline si alguna vez se filtra un token
  firmado, para forjar tokens nuevos.
  Nota aparte, no una vulnerabilidad en sí: `COOKIE_SECRET` se exige en
  el schema (falla el arranque si falta) pero no se usa en ningún lado
  del código — `cookieParser()` en app.module.ts se llama sin
  argumento. La app no depende de cookies firmadas (la integridad la da
  la firma del JWT), así que no hay explotación posible por esto, pero
  es una variable de entorno "de seguridad" que da una falsa sensación
  de protección — alguien podría asumir que las cookies están firmadas
  cuando no lo están.
IMPACTO: reduce el margen de seguridad del mecanismo que protege toda
  la autenticación del sistema, aunque no es explotable hoy sin además
  conocer o adivinar el valor real del secreto en producción.
SOLUCIÓN RECOMENDADA: subir el mínimo a `.min(32)` (idealmente generado
  con `openssl rand -base64 32` o similar, documentado en el README de
  deploy). Para `COOKIE_SECRET`: o se empieza a usar
  (`cookieParser(config.get('COOKIE_SECRET'))` + `signed: true` en las
  cookie options, si se quiere esa capa extra) o se elimina del schema
  para no exigir una variable que no hace nada.
```

## Hallazgo 5 — El fix de `X-Powered-By` (fase 08) no cubre las respuestas de preflight CORS

```
SEVERITY: LOW
UBICACIÓN: backend/src/app.module.ts (middleware que remueve el header,
  agregado en fase 08) vs backend/src/main.ts (app.enableCors()).
CAUSA: `app.enableCors()` en main.ts registra el middleware de `cors`
  antes de que Nest module llegue a aplicar el middleware de
  AppModule.configure() (el que remueve X-Powered-By) — las respuestas
  OPTIONS de preflight las resuelve directamente el paquete `cors`, sin
  pasar por ese middleware. Verificado empíricamente: `curl -X OPTIONS
  /auth/login` devuelve `X-Powered-By: Express` en el header; un GET o
  POST normal a la misma ruta, no.
IMPACTO: mínimo — la fase 08 ya clasificó esto como LOW (fuga de
  información trivial, qué framework corre atrás). Se re-abre acá solo
  porque el fix declarado VERDE en fase 08 en realidad no cubre el 100%
  de las respuestas, y el punto de una auditoría es no asumir que un
  fix previo es completo.
ESCENARIO DE EXPLOTACIÓN: ninguno más allá de fingerprinting trivial
  del stack, igual que el hallazgo original de fase 08.
SOLUCIÓN RECOMENDADA: se resuelve solo al adoptar `helmet` (hallazgo 3)
  con `app.use(helmet())` como el primer middleware de todos, antes de
  `enableCors()` — helmet cubre esto sin depender del orden relativo a
  CORS.
```

## Hallazgo 6 — Dependencias: 3 advisories HIGH en la cadena de `prisma` (CLI)

```
SEVERITY: LOW
UBICACIÓN: backend/package.json — `prisma` listado como dependencia de
  producción (no devDependency), línea 37.
CAUSA: `npm audit` reporta 3 vulnerabilidades HIGH: `deepmerge-ts`
  (stack exhaustion al mergear grafos de objetos recursivos) por debajo
  de la versión que requiere `@prisma/config`, del que depende `prisma`
  (el CLI, usado para `migrate`/`generate`/`db seed`). El paquete que sí
  corre en runtime, `@prisma/client`, no está en esa cadena.
IMPACTO: bajo en la práctica — el CLI `prisma` no se ejecuta como parte
  del server en producción (solo en build/deploy/migraciones, en un
  entorno controlado, no expuesto a input de usuarios finales), así que
  la superficie de explotación real vía esta app es prácticamente nula.
  Igual corresponde señalarlo: está en `dependencies` en vez de
  `devDependencies`, lo que amplía innecesariamente el árbol de
  producción, y el advisory sigue sin resolver.
SOLUCIÓN RECOMENDADA: mover `prisma` a `devDependencies` (no hace falta
  en el runtime del server, solo en build time / CI para migraciones) y
  correr `npm audit fix` cuando Prisma publique un patch que no sea
  breaking (el fix disponible hoy fuerza un downgrade a 6.12.0, breaking
  — no aplicar a ciegas). Revisar de nuevo en la próxima fase de
  producción-readiness.
```

---

## Recorrido completo de las 20 categorías

| # | Categoría | Resultado |
|---|---|---|
| 1 | Authentication | JWT firmado (HS256), argon2 para hashes, dummy-hash contra timing attack (fase 08). Secreto con longitud mínima débil — **hallazgo 4**. |
| 2 | Authorization | `RolesGuard` + `@Roles(OWNER)` a nivel de clase en `UsersController`; verificado que un SELLER recibe 403. Correcto. |
| 3 | Access control | `AuthGuard` global, todo exige sesión salvo `@Public()` explícito en login/logout. Correcto. |
| 4 | Privilege escalation | Solo OWNER puede cambiar roles (`UpdateUserDto.rol`), y solo vía ruta OWNER-only. Sin vía directa de auto-escalación — **pero ver hallazgo 1**, que permite crear un OWNER nuevo vía CSRF sin pasar por ningún control de rol legítimo. |
| 5 | IDOR | `/auth/me` siempre usa el `id` del propio JWT, nunca un parámetro. `/users/*` es admin-only sin noción de "recurso propio" que romper. Sin hallazgos. |
| 6 | Input validation | `ValidationPipe({whitelist, forbidNonWhitelisted, transform})` global + `@MaxLength` en todos los campos relevantes (fase 08). Correcto — **pero ver hallazgo 1**: la validación es sólida, el problema es que acepta el Content-Type equivocado para empezar. |
| 7 | SQL injection | Prisma parametriza todo; el único `$queryRaw` (users.service.ts) es una plantilla 100% estática, sin interpolar input. Sin hallazgos. |
| 8 | XSS | Backend no renderiza HTML. Frontend en React (auto-escapa); sin `dangerouslySetInnerHTML`, `innerHTML` ni `eval` en todo `frontend/src` (verificado por grep). Sin hallazgos — CSP como defensa en profundidad, ver hallazgo 3. |
| 9 | CSRF | **Hallazgo 1 — CRITICAL.** |
| 10 | SSRF | No aplica: el módulo `auth` no dispara ningún request saliente a partir de input del usuario. |
| 11 | Path traversal | No aplica: sin manejo de archivos/paths en el módulo. |
| 12 | Sensitive information exposure | `passwordHash` omitido consistentemente (`omit: { passwordHash: true }`) en las 4 operaciones que devuelven un usuario. Mensajes de error genéricos en login. **Pero ver hallazgo 2** (token en logs). |
| 13 | Secrets | `.env` correctamente en `.gitignore` (verificado, no trackeado), seed exige variables de entorno y nunca hardcodea la contraseña del OWNER. **Ver hallazgo 4** (longitud mínima). |
| 14 | Logs | **Hallazgo 2 — HIGH.** Por lo demás: sin `console.log` sueltos, sin bodies logueados (passwords nunca aparecen), stack traces solo van al log interno, nunca a la respuesta HTTP. |
| 15 | Error handling | `GlobalExceptionFilter` normaliza toda excepción, nunca expone stack ni detalles internos en la respuesta (5xx → mensaje genérico). Correcto. |
| 16 | Rate limiting | `/auth/login` limitado a 20/min por IP (fase 08), verificado. Resto de rutas no lo necesita (ya exige sesión/rol, barrera más fuerte). Sin hallazgos nuevos. |
| 17 | Dependencies | **Hallazgo 6 — LOW** (backend). Frontend: `npm audit` → 0 vulnerabilidades. |
| 18 | Sensitive data storage | Contraseñas solo como hash argon2 (nunca texto plano, verificado en tests de fase 07/08). Sin hallazgos nuevos. |
| 19 | Incorrect permissions | Guards globales correctamente ordenados (`AuthGuard` antes que `RolesGuard`, comentado explícitamente en el código). Verificado que no hay ninguna ruta del módulo sin guard o con guard mal aplicado. Sin hallazgos. |
| 20 | Unauthorized endpoints | Se listaron las 6 rutas reales del módulo (`/auth/login`, `/auth/logout`, `/auth/me`, `/users` POST/GET, `/users/:id` PATCH, `/users/:id/password` PATCH) contra `modulo-auth-spec.md` — no hay rutas de más ni de menos. Sin hallazgos. |

---

## Verificaciones empíricas realizadas

Todas contra el server de desarrollo real (`npm run start:dev`, detenido
al finalizar), sin modificar código:

- CORS: un `Origin` falso (`https://evil-attacker.example`) en el
  preflight y en un GET normal **no** se refleja en
  `Access-Control-Allow-Origin` — se mantiene fijo al `FRONTEND_URL`
  configurado. Correcto, sin hallazgo.
- `POST /auth/login` con `Content-Type: application/x-www-form-urlencoded`
  devuelve 401 (no 400) → confirma el hallazgo 1.
- Log real del server: cada request logueada incluye `req.headers`
  completo sin redactar → confirma el hallazgo 2 (por construcción del
  serializer; no se disponía de una cookie de sesión real para capturar
  el valor literal, pero el mecanismo que la expondría está confirmado).
- `X-Powered-By` ausente en respuestas GET/POST normales, presente en
  la respuesta OPTIONS de preflight → confirma el hallazgo 5.

## Resultado final

**BLOQUEADO.** Hay un hallazgo CRITICAL (1) y uno HIGH que afecta
autenticación/autorización (2) — ambos bloquean el Quality Gate por
regla explícita de `QUALITY_GATE.md` ("CRITICAL: Siempre bloquea" /
"HIGH: Bloquea si afecta seguridad, autenticación, autorización"). No
se corrigió nada en esta fase (regla explícita de fase 09) — los fixes
recomendados arriba son candidatos directos para la fase 10
(remediación).

**No se declara el módulo `auth` seguro.** Los hallazgos MEDIUM/LOW (3,
4, 6) no bloquean por sí solos, pero corresponde documentarlos en
`state/TECH_DEBT.md` si se decide diferir alguno más allá de la fase 10.
