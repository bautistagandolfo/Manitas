# QA adversarial — módulo `returns` (2026-08-28)

Fase 08 del protocolo. Precondición verificada: Fase 07 VERDE
(`state/STATUS.md`, commit `389250a`).

---

## 1. Lógica de negocio / integridad de datos

### Hallazgo real — SEVERITY: HIGH

```
SEVERITY: HIGH
REPRODUCTION: POST /returns (o ReturnsService.crearDevolucion directo)
  con { saleId: <venta A>, items: [{ saleItemId: <línea real de una
  venta B completamente distinta>, cantidad, reingresaStock }] }.
EXPECTED: 400 "La línea <id> no existe en esta venta" — el mensaje ya
  existía en el código, pensado exactamente para este caso, pero nunca
  se disparaba.
ACTUAL (antes del fix): 201 — la devolución se crea con éxito.
  `returns.sale_id` queda apuntando a la venta A, pero `total_devuelto`,
  `return_items.neto_linea` y `costo_unitario` son los de la línea de
  la venta B. Confirmado en vivo con Postgres real: venta A de $100,
  venta B de $250 → devolución creada con `saleId` de A pero
  `totalDevuelto: "250"` (el precio de B).
ROOT CAUSE: `crearDevolucion` (paso 5) leía `sale_items` filtrando
  SOLO por su propio `id` (`WHERE id IN (...)`), sin exigir que esas
  filas pertenecieran a `input.saleId`. El chequeo "sale_items.saleId
  == input.saleId" nunca se verificaba en ningún punto — ni siquiera
  el lock (paso 4) lo filtraba. `GET /returns/sales/:numero`
  (`buscarVentaParaDevolucion`) SÍ filtra correctamente por
  `saleId: sale.id`, así que la pantalla normal de devolución nunca
  puede ofrecer un `saleItemId` ajeno — el bug requiere manipular la
  request directamente (a mano, con curl/Postman, o un bug futuro de
  UI), no es alcanzable clickeando la pantalla real tal como está hoy.
FIX: agregar `saleId: input.saleId` al `where` de
  `tx.saleItem.findMany` (paso 5). Con el filtro, una línea ajena
  simplemente no aparece en `saleItemRows` — el chequeo `if
  (!saleItem) throw ...` que ya existía (nunca alcanzado hasta ahora)
  la rechaza con el mensaje correcto, sin necesitar código nuevo.
```

**Por qué HIGH y no CRITICAL:** no es explotable para robar dinero
directamente — el importe reintegrado sigue siendo el de la línea real
que se devuelve (nunca más de lo que esa línea vale), y el chequeo de
tope por línea (RN-4/invariante 8) se sigue aplicando correctamente
contra el acumulado de ESA línea. El daño real es de **integridad
referencial**: la `Return` queda asociada a una venta que en los
hechos no tiene esa línea, lo que corrompe la trazabilidad venta↔
devolución y podría distorsionar el CMV que `resultados` (Etapa 6)
calcula a partir de `return_items.costo_unitario` — un dato copiado de
la línea equivocada. No bloquea el Quality Gate en CRITICAL, pero sí
en HIGH (afecta integridad de datos, BLUEPRINT §9.8) — corregido en
esta misma fase, con test de integración (Postgres real) y test
unitario que reproducen el escenario antes del fix y confirman el
rechazo después.

**Por qué no se detectó antes:** el mock unitario de
`tx.saleItem.findMany` (`returns.service.spec.ts`) devuelve siempre
las filas construidas por el test, sin leer el `where` real — ningún
test unitario podía detectar un filtro faltante. Los tests de
integración (Postgres real) de T5.1–T5.6 nunca ejercitaron el caso
"`saleItemId` de otra venta" porque toda la suite construye sus
fixtures con `saleId`/`saleItemId` siempre coherentes entre sí (nunca
se probó deliberadamente la incoherencia). Corregido en esta fase con
un test de integración nuevo que sí la ejercita, y con aserciones
unitarias sobre el argumento exacto de `findMany` (mata además varios
mutantes de Stryker sobre esa misma línea, ver sección 5).

### Resto de la categoría — sin hallazgos nuevos

- **Fallos a mitad de operación / rollback**: ya cubierto
  exhaustivamente por los tests de integración de T5.1–T5.8 (venta
  anulada, sin sesión, tope excedido, fuera de plazo, suma de
  reintegros incorrecta — cada uno verifica que no queda ninguna fila
  huérfana en `returns`/`return_items`/`return_payments`/
  `stock_movements`/`cash_movements`). Todo dentro de una única
  transacción Prisma — atomicidad garantizada por el motor.
- **Estados intermedios inconsistentes**: el `let devolucion` +
  reasignación tras `tx.return.update` (T5.5, `saleNuevaId`) ya se
  verificó explícitamente en T5.5 (bug real encontrado y corregido en
  esa sesión). Sin casos nuevos.
- **Datos huérfanos**: el `previousReturnItems`/lock del paso 4 siguen
  leyendo/bloqueando por los `saleItemId` tal como vienen del request
  (antes de saber cuáles son válidos) — no genera ningún dato huérfano
  (el flujo se corta antes del `create` si alguno es ajeno), solo hace
  una lectura de más sobre una fila que después se descarta. Efecto
  menor de performance, no de integridad — anotado para la Fase 12,
  no bloquea nada.

## 2. API

- **Parámetros inválidos / tipos incorrectos**: cubiertos por
  `class-validator` en ambos DTOs (`CreateReturnDto`,
  `SalePaymentDto.returnId`) y por los tests HTTP de T5.7/T5.8
  (`returns-controller.integration.spec.ts`, `sales-controller.
  integration.spec.ts`) — body inválido, tipos incorrectos,
  `esOwner` forjado, arrays más allá de `@ArrayMaxSize`.
- **Requests incompletos**: cubierto (`ArrayNotEmpty`, campos
  requeridos).
- **Requests duplicados**: idempotencia (RN-9/§9.7) probada a nivel
  unitario, integración y HTTP en T5.1/T5.7/T5.8.
- **Respuestas/status incorrectos**: contrastados literalmente contra
  la tabla de errores de la spec en la Fase 07 — coinciden los 11.
- **Manipulación de IDs**: el hallazgo de la sección 1 es exactamente
  esta categoría. Revisados además: `returnId` en `POST /sales`
  (ajeno/inexistente → 404, ya probado desde T5.8); `ventaNueva.
  items[].variantId` inexistente → delegado a `crearVenta`, ya
  validado y probado del lado de `sales`. Sin otros hallazgos.

## 3. UI

Revisado `DevolucionPage.tsx`/`CobroPage.tsx`/`PaymentLinesBuilder.tsx`:

- **Estados vacíos**: número de venta/devolución vacío o no numérico
  rechazado en el cliente antes de pegarle al backend
  (`handleBuscar`/`buscarCredito`), mensaje humano.
- **Errores**: `err instanceof ApiError ? err.message : '...'` en
  ambas pantallas — nunca un código crudo (BLUEPRINT §12.6 regla 2).
- **Loading/doble click**: "Confirmar devolución"/"Confirmar cambio"
  con `loading`/`disabled` mientras `submitting` (§12.6 regla 3); la
  clave de idempotencia persistida cubre la ventana de milisegundos
  entre dos clicks antes de que React aplique `disabled` — el backend
  es la última palabra real, mismo patrón que `sales`.
- **Refresh a mitad de camino**: decisión de alcance ya documentada en
  T5.7 (sin `sessionStorage` para el borrador de devolución — se
  pierde la selección, no la integridad, nada se envía hasta
  confirmar).
- **Datos extremadamente largos**: `referencia` truncada a 500
  caracteres en el DTO; un número de venta/devolución astronómico en
  el input numérico del frontend llega al backend como número (o falla
  a parsear) y `ParseIntPipe` responde 400 legible — sin riesgo de
  crash.

Sin hallazgos nuevos en esta categoría.

## 4. Security

- **Autenticación/autorización**: cubierto (`AuthGuard` global, tests
  401 en los tres controllers tocados; fuera de plazo exige `OWNER`,
  ya probado).
- **IDOR / acceso a recursos ajenos**: el modelo de negocio es
  "tienda única, cualquier empleado ve/opera cualquier venta o
  devolución" — decisión de negocio ya documentada explícitamente en
  la spec (sección 8, "sin restricción de mis devoluciones"), no una
  vulnerabilidad dado ese contexto.
- **Manipulación de IDs**: ver hallazgo de la sección 1 — es, en
  rigor, tanto un problema de integridad de datos como de seguridad
  (permite mezclar datos de dos ventas sin relación), clasificado acá
  también.
- **Inputs maliciosos / SQL injection**: el lock (`$queryRaw`) usa
  `Prisma.join()` para parametrizar los IDs — nunca concatenación de
  strings crudos. Sin vector de inyección.
- **XSS**: no aplica del lado del backend (API JSON); el frontend usa
  React (que escapa por defecto) en las tres pantallas tocadas, sin
  ningún `dangerouslySetInnerHTML`.
- **Exposición de información**: `costoUnitario` confirmado ausente
  (no `null`, ausente del JSON) para `SELLER` en
  `GET /returns/sales/:numero` — ya probado explícitamente
  (`hasOwnProperty` false) en el nuevo test unitario de esta fase.

Sin hallazgos nuevos de seguridad más allá del ya reportado en la
sección 1.

## 5. Testing de mutación (Stryker, obligatorio — BLUEPRINT §9.8)

```
npx stryker run --mutate "src/modules/returns/**/*.service.ts"
```

**Antes: 59.72%** (126 killed, 18 survived, 67 sin cobertura — muy por
debajo del umbral). La gran mayoría del "sin cobertura" estaba
concentrada en `buscarVentaParaDevolucion` (T5.7) y `consultarCredito`
(T5.8): ambos métodos, hasta esta fase, solo tenían cobertura de
integración (Postgres real) — Stryker corre exclusivamente la suite
unitaria (`stryker.conf.json`, mismo criterio que `sales`/`stock`/
`cash-registers`), así que esos ~65 mutantes nunca se ejercitaban en
absoluto.

**Después: 99.05%** (209 killed, 2 survived, 0 sin cobertura).
Agregados **17 tests unitarios nuevos**: cobertura completa de
`buscarVentaParaDevolucion` (camino feliz, con devolución previa
parcial, `costoUnitario` OWNER/SELLER, venta inexistente, fuera de
plazo, dentro de plazo) y `consultarCredito` (crédito íntegro, parcial,
totalDevuelto-sin-crédito-marcado, número inexistente), más 6 tests
dirigidos dentro de `crearDevolucion` para matar mutantes puntuales
(retorno temprano de idempotencia con el `where` exacto, `saleId`
exacto en la lectura de la venta, orden ascendente del lock
verificado con datos fuera de orden, el propio hallazgo de
manipulación de IDs a nivel unitario, `referencia ?? null` explícito).

**2 mutantes sobrevivientes, documentados y aceptados — no forzados:**

```
297:9  EqualityOperator  diasTranscurridos > diasPlazo  →  >=
528:22 EqualityOperator  diasTranscurridos <= diasPlazo →  <
```

Ambos son el mismo caso estructural: el borde EXACTO entre "dentro" y
"fuera" de plazo (`diasTranscurridos === diasPlazo`, al nanosegundo)
depende de `Date.now()` real. Un test no puede cronometrar ese empate
exacto de forma determinista sin inyectar el reloj del sistema en el
servicio — cambio de diseño que excede un "fix mínimo" de esta fase
(la Fase 08 corrige hallazgos, no refactoriza para testabilidad). El
comportamiento real (`>`/`<=` vs `>=`/`<`) en ese instante-frontera
preciso no tiene ningún impacto de negocio observable: cualquier
devolución real llega siempre con una diferencia de al menos varios
milisegundos respecto del corte exacto, nunca exactamente `0`. Se
intentó matarlos con un test de borde (30 días exactos, con margen de
milisegundos) — el margen necesario para que el test sea determinista
hace que el operador original y el mutado den el mismo resultado,
confirmando que son estructuralmente imposibles de distinguir sin
inyección de reloj.

## Resultado

```
SEVERITY: HIGH (1 hallazgo — corregido y probado, ver sección 1)

Testing de mutación: 59.72% → 99.05% (umbral 80%, superado)
Tests: 418/418 unitarios (+16), 354/354 integración (+1) — dos
  corridas seguidas sin flakes
tsc --noEmit / lint / nest build: limpios
```

No se declara el módulo aprobado — corresponde a la Fase 09
(security audit, sin modificar código) confirmarlo de forma
independiente.
