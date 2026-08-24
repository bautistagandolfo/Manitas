# Security audit — módulo `products`/`variants`+`stock` (2026-08-23)

Fase 09 del protocolo. Fase 08 (QA adversarial) VERDE, verificado en
`state/STATUS.md` antes de empezar. Auditoría de código (frontend +
backend) más verificaciones empíricas puntuales (lectura de logs reales,
`npm audit`) — sin modificar código en ningún momento (regla explícita
de esta fase).

No se asume que ninguna protección existente sea correcta, incluidas las
que ya se auditaron y corrigieron para `auth` (fases 09/10/11,
`modulo-auth-secaudit-2026-08-23.md`) — son globales (`AppModule`,
`main.ts`), así que también protegen las rutas de este módulo, pero se
releyó el código real para confirmarlo en vez de asumirlo por el nombre
del módulo donde se corrigieron.

**Sin hallazgos CRITICAL ni HIGH nuevos.** El módulo hereda correctamente
las protecciones globales corregidas en la fase 10 de `auth`, y las
verificaciones específicas de `products`/`variants`/`stock` (autorización
por ruta, ocultamiento de costo, SQL parametrizado, mass-assignment) no
encontraron ningún hallazgo bloqueante nuevo. Ver el único hallazgo LOW
abajo.

---

## Hallazgo 1 — Nuevas dependencias de desarrollo (Stryker) traen 9 advisories de `npm audit`, ninguna en el árbol de producción

```
SEVERITY: LOW
UBICACIÓN: backend/package.json (devDependencies:
  @stryker-mutator/core, @stryker-mutator/jest-runner — agregadas en la
  fase 08 de este módulo para el mutation testing obligatorio de
  BLUEPRINT §9.8 sobre stock.service.ts).
CAUSA: `npm audit` reporta 12 advisories en total (5 low, 3 moderate,
  4 high) contra 3 antes de esta fase (los 3 high ya documentados y
  aceptados en `state/TECH_DEBT.md`/el audit de `auth`, cadena de
  `prisma` CLI). Los 9 nuevos vienen enteramente de la cadena de
  Stryker: @stryker-mutator/core, @stryker-mutator/instrumenter,
  @stryker-mutator/jest-runner, @inquirer/prompts, @inquirer/editor,
  @babel/core, ajv, external-editor, tmp (este último es el único HIGH
  nuevo — path traversal/symlink en la escritura de archivos temporales
  del paquete `tmp`, usado internamente por el editor interactivo de
  `@inquirer/editor`, una dependencia de la CLI de Stryker que este
  proyecto nunca invoca). Confirmado con `npm audit --omit=dev`: sigue
  dando exactamente los mismos 3 high que antes de esta fase — ninguno
  de los 9 nuevos aparece, porque Stryker es 100% devDependency.
IMPACTO: nulo en producción — `nest build` solo empaqueta `src/`, nunca
  `node_modules` de devDependencies, y Stryker no se ejecuta como parte
  del server (`start`/`start:dev`/`start:prod`), solo se invoca a mano
  (`npx stryker run`) en un entorno de desarrollo/CI controlado. El
  vector teórico (escritura de archivo temporal insegura vía symlink en
  `tmp`) requeriría que alguien con capacidad de correr `npx stryker
  run` ya tenga acceso al filesystem local de todos modos.
SOLUCIÓN RECOMENDADA: no bloquea, no amerita revertir la herramienta
  (el mutation testing es un requisito explícito del blueprint). Cuando
  Stryker publique una versión que actualice su cadena de `@inquirer/*`/
  `tmp`, correr `npm audit fix` y confirmar que sigue sin tocar el árbol
  de producción. Documentado en `state/TECH_DEBT.md` como TD-9.
```

---

## Recorrido completo de las 20 categorías

| # | Categoría | Resultado |
|---|---|---|
| 1 | Authentication | No introduce mecanismo propio — hereda `AuthGuard`/JWT de `auth`, ya auditado. Sin hallazgos nuevos. |
| 2 | Authorization | Verificado ruta por ruta contra `modulo-products-variants-spec.md` §8: `@Roles(OWNER)` en `POST /products/:id/variants`, `POST /products/:id/variants/grid`, `PATCH /variants/:id/price`, `GET /variants/:id/price-history`, y a nivel de clase en `PricesController` (`/prices/bulk-update/*`), `CatalogImportController` (`/products/import`) y `StockController` (`/stock/*`). Brand/category/color/size/product CRUD y `PATCH /variants/:id` (sku/barcode/activo) correctamente abiertos a cualquier rol autenticado (BLUEPRINT §5.1, no están en la lista de exclusiones de SELLER). Sin rutas mutantes sin guard. Sin hallazgos. |
| 3 | Access control | `AuthGuard` global (`APP_GUARD`) cubre todo el módulo, ninguna ruta usa `@Public()`. Confirmado leyendo cada controller. Sin hallazgos. |
| 4 | Privilege escalation | Verificado el vector más obvio del módulo: `UpdateVariantDto` (usado por el `PATCH /variants/:id` abierto a SELLER) excluye deliberadamente `precioVenta`/`costoActual` — probado empíricamente (test de integración existente) que mandarlos ahí da 400, sin importar el rol, porque el `ValidationPipe` global (`whitelist`/`forbidNonWhitelisted`) los rechaza antes de llegar al handler. `RequireOwner.tsx` en el frontend es defensa en profundidad documentada como tal (el propio comentario del código dice que el backend ya rechaza con 403); no es la única barrera. Sin hallazgos. |
| 5 | IDOR | No aplica en el sentido clásico: el catálogo es compartido por todo el personal autenticado según su rol, sin noción de "recurso propio" de un usuario que romper. IDs de producto/variante/talle/color/marca/categoría inexistentes dan 404 (`/products/999999`, `/variants/999999`, verificado en tests existentes), no un error genérico ni datos de otro registro. Sin hallazgos. |
| 6 | Input validation | `ValidationPipe` global + DTOs con `@MaxLength`/`@Min`/`@IsDecimal`/`@ArrayMaxSize` (este último agregado en la fase 08 de este módulo tras encontrarlo faltante en `CreateVariantGridDto`). Precio/costo siempre como string validado con `@IsDecimal`, nunca `number` (CLAUDE.md regla 5). Sin hallazgos nuevos. |
| 7 | SQL injection | Dos usos de SQL crudo en el alcance del módulo: `stock.service.ts` (`SELECT id FROM variants WHERE id = ${input.variantId} FOR UPDATE`) y `catalog-import.service.ts` (`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`, agregado en la fase 08). Ambos usan el template tag de Prisma (`tx.$queryRaw`/`tx.$executeRaw`), que parametriza automáticamente cualquier valor interpolado — confirmado leyendo el código, ninguno concatena strings. `key` en el segundo caso viene directo de `nombre` del CSV (input de usuario sin sanitizar), pero al ser un parámetro bindeado, no un fragmento de SQL, no es explotable sin importar qué caracteres traiga. El resto de las consultas del módulo pasan enteramente por el query builder de Prisma. Sin hallazgos. |
| 8 | XSS | Backend no renderiza HTML. Frontend en React (auto-escapa por defecto); confirmado por grep que no hay `dangerouslySetInnerHTML`, `innerHTML`, `eval()` ni `document.write` en ningún archivo de `frontend/src`, incluidos los nuevos de este módulo (`features/catalog/**`). Nombres de producto/marca/categoría/talle/color se renderizan como texto de React en todas las pantallas del catálogo, nunca inyectados como HTML. Sin hallazgos. |
| 9 | CSRF | El middleware `jsonOnlyMiddleware` (fix de la fase 10 de `auth`) corre con `forRoutes('*')` — confirmado en `app.module.ts` que cubre toda ruta mutante de la app, incluidas `/products/*`, `/variants/*`, `/stock/*`, `/prices/*`. Sin hallazgos nuevos. |
| 10 | SSRF | No aplica: ninguna operación del módulo dispara un request saliente a partir de input del usuario — la importación CSV solo parsea un string en memoria (`csv-parse`), sin resolver URLs ni rutas externas. |
| 11 | Path traversal | No aplica: sin manejo de filesystem en el módulo — confirmado por grep (`fs`, `path.join`, `readFile`, etc.) sin resultados en `src/modules/products` ni `src/modules/stock`. La importación CSV viaja como string en el body JSON, no como archivo subido a disco. |
| 12 | Sensitive information exposure | `costoActual` se oculta a quien no sea OWNER en `search`, `findOne`, `update` y el resultado de `create`/`createGrid` (RN-3, verificado en tests desde T2.x y de nuevo en la fase 08). La respuesta de `POST /products/import` no incluye costo/precio, solo `{linea, estado, sku, mensaje}`. `GlobalExceptionFilter` (global, ya auditado en `auth`) sigue cubriendo este módulo — sin stack traces ni detalles de Prisma en ninguna respuesta 4xx/5xx observada en los tests de integración. Sin hallazgos nuevos. |
| 13 | Secrets | El módulo no introduce ninguna variable de entorno ni secreto propio — usa `DATABASE_URL`/`JWT_SECRET` ya auditados. Sin hallazgos. |
| 14 | Logs | `redact` global (fase 10 de `auth`) sigue activo — confirmado en `app.module.ts`, cubre `req.headers.cookie` en toda request, incluidas las de este módulo. Sin `console.log` sueltos en `src/modules/products` ni `src/modules/stock` (confirmado por grep). Sin hallazgos nuevos. |
| 15 | Error handling | `GlobalExceptionFilter` global normaliza toda excepción del módulo. Errores de Prisma traducidos a mensajes de negocio (`prisma-error.util.ts`, `translateRowError` en el importador) en vez de propagar el error crudo. Sin hallazgos de seguridad — ver el hallazgo LOW no bloqueante de la fase 08 (mensaje de validación en inglés, cosmético, ya en TD-8, no expone información interna). |
| 16 | Rate limiting | Ninguna ruta del módulo es pública — todas exigen sesión (`AuthGuard`) y la mayoría además un rol específico, la misma barrera que `auth` ya consideró suficiente para el resto de sus rutas no-login. Sin hallazgos nuevos. |
| 17 | Dependencies | **Hallazgo 1 — LOW** (backend, dev-only). Frontend: `npm audit` → 0 vulnerabilidades. |
| 18 | Sensitive data storage | `precioVenta`/`costoActual` son datos de negocio sensibles (competitivos, no PII/credenciales) — almacenados como `Decimal` en Postgres, sin cifrado adicional; cubiertos por el control de acceso de RN-3 (hallazgo 12), no por cifrado en reposo, consistente con el resto del sistema (BLUEPRINT no pide cifrado a nivel de columna). Sin hallazgos nuevos. |
| 19 | Incorrect permissions | Guards globales (`AuthGuard` antes que `RolesGuard`) heredados sin alteración. Verificado que ningún controller del módulo declara un guard local que pise o duplique el global de forma inconsistente. Sin hallazgos. |
| 20 | Unauthorized endpoints | Listadas las 20 rutas reales del módulo (brands/categories/colors/sizes ×3 cada uno, products ×4, variants ×6, prices ×2, stock ×2, catalog-import ×1) contra `modulo-products-variants-spec.md` — coinciden exactamente, sin rutas de más. Un endpoint de la spec sigue sin implementar (`GET /variants/:id/stock-movements`), ya documentado como gap de alcance en la fase 07 — no es una ruta no autorizada, es una ruta que nunca se construyó; no aplica a esta categoría. |

---

## Verificaciones empíricas realizadas

- `npm audit` (backend, con y sin `--omit=dev`) y `npm audit` (frontend) —
  corridos de nuevo en esta fase, no asumidos del audit de `auth`
  (resultado: hallazgo 1).
- Grep de `dangerouslySetInnerHTML`/`innerHTML`/`eval(`/`document.write`
  en todo `frontend/src` — 0 resultados.
- Grep de `fs`/`path.join`/`readFile`/`writeFile`/`child_process`/`exec(`
  en `backend/src/modules/products` y `backend/src/modules/stock` — 0
  resultados.
- Grep de `$queryRaw`/`$executeRaw` en `backend/src/modules` — confirmados
  los dos usos del módulo, ambos con template tag parametrizado de
  Prisma, ninguno con concatenación de strings.
- Lectura directa de `app.module.ts`, `main.ts`, `env.schema.ts` y
  `json-only.middleware.ts` para confirmar que los fixes de la fase 10
  de `auth` (CSRF, redact de logs, helmet, `JWT_SECRET.min(32)`,
  `X-Powered-By`) siguen aplicados y son globales (`forRoutes('*')` /
  `APP_GUARD` / `APP_PIPE`), no locales al módulo `auth`.
- Test de integración existente releído y confirmado: `PATCH
  /variants/:id` con `precioVenta`/`costoActual` en el body da 400
  (mass-assignment bloqueado en la ruta abierta a SELLER, el vector de
  privilege escalation más obvio del módulo).

## Resultado final

**VERDE.** Sin hallazgos CRITICAL ni HIGH. El único hallazgo nuevo
(LOW, dependencias de desarrollo de Stryker) no bloquea el Quality Gate
y queda documentado en `state/TECH_DEBT.md` como TD-9. Las protecciones
globales corregidas en la fase 10 de `auth` (CSRF, logs, headers,
secretos) se verificaron activas y aplicables a este módulo, no solo
asumidas.

**No se declara el módulo `products`/`variants`+`stock` seguro en un
sentido absoluto** — como con `auth`, esto es una auditoría puntual, no
una garantía permanente. A diferencia de `auth` (que encontró CRITICAL/
HIGH y necesitó las fases 10-11 de remediación/re-auditoría), acá no hay
nada que remediar: el único hallazgo es LOW, de una dependencia de
desarrollo sin exposición en producción, sin un fix de código disponible
todavía (queda como TD-9). Las fases 10 y 11 no aplican por falta de
objeto — el módulo queda en condiciones de avanzar a la fase 12
(production readiness) cuando corresponda en el protocolo.
