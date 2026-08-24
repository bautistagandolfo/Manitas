# Security re-audit — módulo `products`/`variants`+`stock` (2026-08-23)

Fase 11 del protocolo. Fase 10 VERDE en `state/STATUS.md`, verificado
antes de empezar (nota: fue una fila declarada VERDE porque no había
ninguna vulnerabilidad que remediar, no porque se haya saltado — ver esa
fila para el detalle). La nota de proporcionalidad de esta fase que
permite omitirla no aplica: `MVP_SCOPE.md` §5 clasifica `products`/
`variants` como riesgo **ALTO** ("en retail el stock es plata"), y la
Fase 09 tuvo 1 hallazgo (no cero) — ninguna de las dos condiciones de la
omisión se cumple. Por eso esta fase se ejecuta de verdad, no se
documenta como omitida.

**Sin archivos modificados** (regla explícita de esta fase). Se
verificó contra `state/reports/modulo-products-secaudit-2026-08-23.md`
con una mezcla de relectura de código y verificaciones empíricas nuevas
contra el servidor de desarrollo real (no solo repetir lo que decía el
reporte anterior) — servidor detenido al finalizar.

Confirmado primero que no hay ningún commit de código entre la Fase 09
(`00d598a`) y este momento — `git log`/`git status` sin cambios en
`backend/src` ni `frontend/src` — así que cualquier verificación de la
Fase 09 sigue describiendo el mismo código, no una versión distinta.

---

## Previous vulnerabilities

Un solo hallazgo en la Fase 09:

1. **LOW** — `npm audit` del backend subió de 3 a 12 advisories (5 low,
   3 moderate, 4 high) al agregar `@stryker-mutator/core`/
   `@stryker-mutator/jest-runner` como devDependencies en la Fase 08.
   Los 9 nuevos vienen de la cadena de Stryker (`@inquirer/*`,
   `@babel/core`, `ajv`, `external-editor`, `tmp`), ninguno en el árbol
   de producción.

Sin CRITICAL, HIGH ni MEDIUM previos.

## Fixed

Ninguno — no había nada dentro del alcance de la Fase 10 para corregir
(el único hallazgo es una dependencia de desarrollo sin fix de código
disponible, ver TD-9). No aplica esta sección en el sentido de "fix
implementado y reverificado".

## Remaining

1. **LOW — hallazgo 1, sin cambios.** Reverificado en esta fase con
   `npm audit`/`npm audit --omit=dev` corridos de nuevo (no reusando el
   resultado de la Fase 09):
   - `npm audit` (todo): **12** advisories — 5 low, 3 moderate, 4 high.
     Idéntico a la Fase 09.
   - `npm audit --omit=dev`: **3** advisories, las tres HIGH — la misma
     cadena de `prisma` CLI ya aceptada desde el audit de `auth`.
     Ninguna de las 9 nuevas de Stryker aparece sin `devDependencies`,
     confirmando de nuevo que el impacto en producción sigue siendo
     nulo.
   - `npm audit` (frontend): **0** advisories, sin cambios.

   Sigue LOW, sigue sin exposición en producción, sigue documentado
   como TD-9 en `state/TECH_DEBT.md`. No escaló de severidad ni de
   alcance.

## New findings

Ninguno. Además de reverificar el único hallazgo de la Fase 09, se
repitieron o ampliaron las verificaciones empíricas de las categorías
más sensibles del módulo, contra el servidor de desarrollo real
(`npm run start:dev`):

- **CSRF (json-only middleware) en rutas de `products`/`stock`, no solo
  `auth`:** `curl -X POST http://localhost:3000/brands` con
  `Content-Type: application/x-www-form-urlencoded` → **415**. Mismo
  resultado contra `POST /stock/ajustes` (ruta OWNER-only de dinero/
  stock) → **415**. La Fase 09 solo había confirmado esto leyendo que
  el middleware corre con `forRoutes('*')`; acá se confirmó en vivo
  contra dos rutas reales de este módulo, una de ellas la más sensible
  (mueve stock).
- **Headers de `helmet` en una ruta del módulo:** `GET /brands` →
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`
  presentes; `X-Powered-By` ausente. Confirmado en vivo, no solo en
  `/auth/*` como hizo el audit original de `auth`.
- **Redacción de logs con una sesión real:** la corrida de los tests de
  integración de esta misma fase (ver abajo, "vector de privilege
  escalation") generó un login real y varios requests autenticados
  contra rutas de `variants`; el log de esa corrida muestra
  `"set-cookie":"[REDACTED]"` en la respuesta de `/auth/login` y ningún
  valor de cookie sin censurar en ninguna de las requests autenticadas
  posteriores a `/variants/:id`. Confirmado con datos de esta fase, no
  reciclado del audit de `auth`.
- **Vector de privilege escalation (mass-assignment en `PATCH
  /variants/:id`, abierto a SELLER):** se re-ejecutaron en vivo los 3
  tests de integración relevantes (`SELLER puede actualizar sku/
  barcode/activo`, `rechaza precioVenta en este endpoint`, `rechaza
  costoActual en este endpoint`) — **3/3 en verde**, con los códigos de
  respuesta reales observados en el log: 200 para el update legítimo,
  400 para los dos intentos de inyectar precio/costo. No se asumió que
  seguían pasando por haber pasado en la Fase 08/09.
- Grep repetido de `dangerouslySetInnerHTML`/`innerHTML`/`eval(` en
  `frontend/src` y de `fs`/`exec(`/`child_process` en
  `backend/src/modules/products`+`stock` — mismos resultados que la
  Fase 09 (cero coincidencias), sin código nuevo que pudiera haber
  introducido alguno.

Sin ningún hallazgo CRITICAL o HIGH adicional, ni evidencia de que
alguna de las protecciones verificadas se haya debilitado desde la Fase
09.

## Security status

**VERDE.** Los tres objetivos de esta fase se confirman:

1. La (única) vulnerabilidad previa (LOW, dependencias de Stryker) está
   correctamente descripta y sigue exactamente en el mismo estado —
   reverificado con `npm audit` corrido de nuevo, no reciclado.
2. No hay fixes de código que reverificar (no se aplicó ninguno en la
   Fase 10, no había nada CRITICAL/HIGH/MEDIUM que corregir), así que
   no hay superficie nueva que pudiera haber introducido una
   vulnerabilidad.
3. Sin CRITICAL ni HIGH adicionales — confirmado con verificaciones
   empíricas nuevas (no solo releer el reporte anterior) contra rutas
   reales de `products`/`stock`, incluida la más sensible del módulo
   (`/stock/ajustes`).

**No se declara el módulo `products`/`variants`+`stock` seguro en un
sentido absoluto ni permanente** — es una foto de este momento, sobre
este código. El módulo queda en condiciones de avanzar a la Fase 12
(production readiness) cuando corresponda en el protocolo.
