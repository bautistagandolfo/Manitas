# Spec del módulo `returns` (2026-08-25)

Fase 06 del protocolo, Etapa 5 de `state/ROADMAP.md` (T5.1–T5.7).
Riesgo **ALTO** (`MVP_SCOPE.md` §4: "Dinero + stock"). Dependencias
declaradas — `sales` (T4.4, VERDE, cierre completo Fases 07–12),
`settings` (T0.13, VERDE), `idempotencia` (T0.14, VERDE),
`cash-registers` (T3.2, VERDE) — las cuatro VERDE. Fuentes:
`BLUEPRINT.md` AD-8/AD-17/AD-18/AD-19, §3.5, §5.4, §5.6 (los 3
filtros del cálculo de resultados que dependen de este módulo),
invariantes 7/8/10/11/13/14/15, §7, §9.3, §9.4, §9.7, §9.8, §12.4,
§12.6; `MVP_SCOPE.md` §3.5, §4; `state/AMBIGUITIES.md` AMB-2 (ya
resuelta); `backend/prisma/schema.prisma` (modelos `Return`/
`ReturnItem`/`ReturnPayment`, enums `ReturnTipo`/
`StockMovementReferenciaTipo.RETURN`/`CashMovementReferenciaTipo.RETURN`,
ya en la base desde la Fase 01 — sin migración nueva necesaria para lo
esencial del módulo); `state/reports/modulo-sales-spec.md` y
`modulo-cash-registers-spec.md` (los dos módulos con los que `returns`
integra); `backend/src/modules/sales/sales.service.ts` y
`backend/src/modules/stock/stock.service.ts` (leídos completos, no
solo su firma — este módulo reusa/extiende ambos, ver sección 5).

---

## 1. Responsabilidad

Este módulo es dueño de:

- La **devolución** (`returns`): N líneas (`return_items`) contra
  líneas de una venta existente, N reintegros (`return_payments`), en
  una única operación transaccional (§5.4).
- El **reingreso condicional de stock** — delega la escritura real a
  `stock.service.ts` (CLAUDE.md regla 4: "Solo `stock.service.ts`
  escribe movimientos de stock"), pero decide POR LÍNEA si corresponde
  (`reingresa_stock`).
- El **reintegro condicional en caja** — delega la escritura real a
  `cash-register.service.ts` (mismo criterio que `sales`), solo por la
  parte de `return_payments` cobrada en `EFECTIVO` (invariante 7).
- El **cambio** (`tipo = CAMBIO`): una devolución más una venta nueva
  ligadas por `sale_nueva_id`, con el crédito de la devolución
  aplicado como pago de la venta nueva — orquesta la secuencia de
  4 pasos de §5.4, pero **la creación de la venta nueva la sigue
  haciendo `SalesService.crearVenta`**, reusada tal cual (ver sección
  5) — este módulo no reimplementa ninguna regla de negocio de venta
  (descuentos, prorrateo, stock, RN-4, etc.), solo le pasa un pago de
  método `CREDITO_DEVOLUCION`.
- La **autorización fuera de plazo** (`autorizado_por_user_id`), con
  el mismo criterio de construcción diferida que AMB-14 de `sales`
  (ver sección 8).

Este módulo **NO** es dueño de, y nunca escribe directamente en:

- `sales`/`sale_items`/`sale_discounts`/`payments` — ni siquiera la
  fila de `payments` que consume el crédito de una devolución
  (`CREDITO_DEVOLUCION` + `returnId`), sea dentro del flujo atómico de
  cambio (RN-9) o en una venta completamente separada, más adelante
  (T5.8, AMB-16 resuelta como diferido): esa escritura, y la
  validación de que no se gasta de más (invariante 14), viven siempre
  en `sales.service.ts` (sección 5) — `returns` nunca escribe ni
  valida esto directamente. `returns` SÍ **lee**
  `sales`/`sale_items`/`payments` directamente (mismo criterio que
  `SalesService.anularVenta` ya lee `returns`/`sale.payments`
  directamente sin necesitar que el otro módulo exponga un endpoint
  para eso).
- `stock_movements`/`variants.stock_actual` (delega a `stock.service.ts`).
- `cash_movements`/sesión de caja (delega a `cash-register.service.ts`).
- El cálculo de `resultados` (CMV, márgenes) — `returns` solo **deja
  los datos correctos** (`return_items.reingresa_stock`,
  `costo_unitario` copiado) para que Etapa 6 los use. **`returns` no
  resta nada de ningún costo/margen activamente** — ver la aclaración
  en RN-6 (T5.4 suele leerse como "revertir el costo", pero no hay
  ninguna resta que hacer en este módulo: es un dato que se persiste
  para que el filtro de §5.6 lo use después).
- La anulación de ventas (`sales`, ya construido) ni la anulación de
  devoluciones — **las devoluciones no se anulan** (§5.4, literal):
  si hace falta corregir una mal cargada, es un ajuste de stock manual
  y un movimiento de caja de tipo `AJUSTE`, ambos fuera de este
  módulo.

## 2. Reglas de negocio

**RN-1. Siempre contra una venta existente, no anulada (AD-19).**
`sale_id` obligatorio. Si la venta no existe → 404. Si está `ANULADA`
→ 409 (AD-19: excluyentes en ambas direcciones — una venta anulada no
admite devoluciones, y una venta con devoluciones no se puede anular,
ya construido del lado de `sales`).

**RN-2. Siempre requiere sesión de caja abierta** (§5.4, literal: "haya
o no reintegro en efectivo" — `cash_register_session_id` es columna
obligatoria en `returns`, no nullable). Mismo criterio que `sales`: se
verifica y se **bloquea la fila de la sesión** ANTES de cualquier otra
lectura (mismo hallazgo de la Fase 06/sección 5 de `sales` — el lock
temprano de sesión no depende de si hay reintegro en efectivo).

**RN-3. Plazo de devolución (`dias_plazo_devolucion`, default 30,
`SettingsService.getInt`, AMB-2 RESUELTA).** `fecha_actual − sale.fecha
> dias_plazo_devolucion` (en días completos, hora argentina — CLAUDE.md
regla 6) exige `autorizado_por_user_id` no nulo. Sin mecanismo de
verificación de contraseña todavía (mismo criterio de construcción
diferida que AMB-14 de `sales`, sección 8) — si quien opera no es
`OWNER`, se rechaza directo, sin vía de autorización por ahora.

**RN-4. Tope por línea, descontando devoluciones previas (invariante
8).** `SUM(return_items.cantidad WHERE sale_item_id = X) + cantidad_nueva
≤ sale_items.cantidad` de esa línea. Se valida DESPUÉS de bloquear las
filas de `sale_items` involucradas (ver sección 5) — sin el lock, dos
devoluciones parciales concurrentes de la misma línea podrían leer el
mismo acumulado "viejo" y las dos pasar, superando lo vendido.

**RN-5. Neto devuelto, no precio de lista (AD-18).** Por cada línea:

```
neto_linea_devuelto = round(neto_linea_original × cantidad_devuelta / cantidad_vendida)
```

**Con una excepción obligatoria, literal de AD-18:** si esta devolución
agota la línea (`cantidad_ya_devuelta_antes + cantidad_devuelta ==
cantidad_vendida`), el `neto_linea_devuelto` de ESTA devolución no es
el de la fórmula: es el **remanente exacto** —
`neto_linea_original − SUM(neto_linea_devuelto de las devoluciones
previas de esa línea)` — para que la suma de todas las devoluciones de
una línea nunca difiera del `neto_linea` original ni por un centavo de
redondeo acumulado. `total_devuelto = SUM(neto_linea_devuelto)` de
todas las líneas de esta devolución (invariante 11).

**RN-6. Reingreso de stock, condicional por línea.** Si
`return_items.reingresa_stock = true`, `stockService` incrementa
`stock_actual` de esa variante (delegado, nunca escrito acá
directamente). Si `false` (prenda fallada), el dinero se devuelve
igual pero el stock NO se toca — la mercadería se perdió.

**Aclaración explícita (T5.4 del roadmap, "reversión del costo
congelado"): no hay ninguna resta de costo que este módulo ejecute.**
`return_items.costo_unitario` se copia tal cual de
`sale_items.costo_unitario` (mismo congelado que ya hizo `sales`, AD-5)
— el módulo solo tiene que persistir ese dato correctamente. Es
`resultados` (Etapa 6, §5.6) quien calcula
`CMV -= SUM(return_items.cantidad × costo_unitario) WHERE
reingresa_stock = true` — filtrando por la bandera, nunca acá. T5.4 es
sobre "que el dato quede bien copiado y `reingresa_stock` bien
seteado", no sobre una operación activa de reversión.

**RN-7. Reintegro libre, suma exacta (invariante 11).**
`return_payments` no está atado a ningún medio en particular — el
cliente (quien llama a la API) decide método(s) y monto(s) por línea de
reintegro, el servicio solo valida
`SUM(return_payments.monto) == total_devuelto`, ANTES de escribir
nada (mismo criterio que `sales`, invariante 3). §5.4 dice "se
reintegra en la misma proporción [al medio de cobro original] salvo
que se indique otra cosa" — **decisión de esta sesión**: esa
"proporción por defecto" es una sugerencia de UX (T5.7, frontend,
calcula un default a partir de `sale.payments` y lo pre-carga), NO una
regla que el backend imponga o valide — mismo principio que `sales`
nunca dicta la combinación de medios de pago de una venta, solo valida
la suma.

**RN-8. Solo `EFECTIVO` mueve caja (invariante 7, AD-8).**
`SUM(return_payments.monto WHERE metodo = EFECTIVO)` genera **un solo**
`cash_movement` (no uno por línea de reintegro), tipo `DEVOLUCION`,
**negativo** (`TIPOS_POSITIVOS` de `cash-register.service.ts` ya
excluye `DEVOLUCION` — sale del cajón). `TARJETA_*`/`TRANSFERENCIA`/
`CREDITO_DEVOLUCION` no tocan la caja.

**RN-9. `CAMBIO` — secuencia exacta de 4 pasos, todo en una
transacción (§5.4, literal).**

1. Crear la devolución (`sale_nueva_id` en `null` todavía) + sus
   `return_items` — mismo cálculo de RN-5/RN-6 que una devolución
   común.
2. Registrar en `return_payments` un reintegro de método
   `CREDITO_DEVOLUCION` por el importe que se aplica al cambio (puede
   ser el `total_devuelto` completo, o menos si además hay un
   reintegro real por otro medio — por ejemplo, la prenda nueva es más
   barata y el resto se devuelve en efectivo). La suma de
   `return_payments` de esta devolución sigue teniendo que dar
   `total_devuelto` exacto (RN-7/invariante 11) — el `CREDITO_DEVOLUCION`
   es una línea más, no un caso especial de esa suma.
3. Crear la venta nueva llamando a **`SalesService.crearVenta(tx,
   input)` reusado tal cual** (ver sección 5), con un `payments` que
   incluye una línea `{ metodo: CREDITO_DEVOLUCION, monto: <el importe
   del paso 2>, returnId: <id de la devolución del paso 1> }` — más
   cualquier otro pago normal si la prenda nueva es más cara (la
   diferencia "se cobra normalmente", sin ninguna regla nueva: es una
   venta común con un medio de pago más en la lista).
4. Actualizar `returns.sale_nueva_id` con el id de la venta creada en
   el paso 3.

**RN-10. El crédito de una devolución se usa una sola vez, y queda
disponible para una venta futura (invariante 14, AMB-16 RESUELTA —
diferido).** La suma de los `payments.monto` con
`metodo = CREDITO_DEVOLUCION` que referencian una devolución
(`payments.return_id`) nunca supera su `total_devuelto` — **sin
importar si esos pagos ocurren en el mismo momento del cambio (RN-9)
o en una venta completamente distinta, más adelante, sin relación con
`returns.service.ts` en absoluto.** El PO confirmó explícitamente que
el crédito es una nota de crédito real, no algo que solo exista dentro
del flujo atómico — decisión que cambia dónde vive la validación: ver
sección 5 (`SalesService.crearVenta` la valida ella misma, con su
propio lock, no `returns.service.ts`) y la sección 4 (endpoint nuevo
de consulta de saldo, y la extensión de la pantalla de cobro para
aplicar un crédito viejo, T5.8).

**RN-11. Una venta pagada con `CREDITO_DEVOLUCION` no se puede anular**
(invariante 15) — **ya construido del lado de `sales`** (T4.7, paso 5
de `anularVenta`), reconfirmado acá porque es la venta nueva de un
cambio la que queda protegida por esa regla, sin que `returns` tenga
que hacer nada adicional.

## 3. Invariantes

De la sección 6 del blueprint, los que este módulo toca (numeración
del blueprint):

- **7** — de los reintegros (`return_payments`), solo `EFECTIVO` genera
  `cash_movements`. Garantizado por construcción: RN-8 filtra
  explícitamente antes de llamar a `cashRegisterService.registrarMovimiento`.
- **8** — `SUM(return_items.cantidad)` por `sale_item_id` nunca supera
  lo vendido en esa línea. Garantizado por RN-4, validado con el lock
  de `sale_items` tomado ANTES de leer el acumulado (sección 5) — sin
  eso, el invariante se puede violar bajo concurrencia real, no solo
  en teoría.
- **10** — ninguna devolución se registra sin sesión de caja abierta.
  Garantizado por RN-2 (fail-fast, lock temprano).
- **11** — `total_devuelto == SUM(return_items.neto_linea)` y
  `SUM(return_payments.monto) == total_devuelto`. Garantizado por
  construcción (RN-5/RN-7: el servicio arma esas sumas él mismo, nunca
  las recibe calculadas del cliente) — mismo criterio que el
  invariante 12 de `sales`.
- **13** — ninguna venta tiene a la vez `ANULADA` y devoluciones por
  `sale_id` (AD-19). La mitad que le toca a `returns` (no crear una
  devolución contra una venta `ANULADA`) está en RN-1; la otra mitad
  (no anular una venta con devoluciones) ya está en `sales` (T4.7).
- **14** — el crédito de una devolución no se gasta de más. Ver RN-10 y
  AMB-16 — el mecanismo exacto de dónde se valida depende de la
  resolución de esa ambigüedad.
- **15** — una venta con un pago `CREDITO_DEVOLUCION` no se anula.
  Garantizado del lado de `sales` (T4.7), `returns` no necesita
  replicar el chequeo.

## 4. Contratos de API

**Decisión de esta sesión** (arquitectura, no negocio — mismo criterio
que T4.2 decidió el formato de `descripcionSnapshot` sin escalar una
ambigüedad): `sales` ya cerró su Fase 12 sin `GET /sales`/
`GET /sales/:id` (gap de alcance documentado, sin ticket que lo
reserve). Para que la pantalla de devolución (T5.7) pueda buscar una
venta y saber qué le queda disponible para devolver por línea, este
módulo expone su PROPIO endpoint de lectura — no se reabre
`SalesController` (módulo ya cerrado y aprobado, Fase 12) para agregar
algo que en rigor es una consulta específica de `returns` ("¿qué se
puede devolver de esta venta?"), no un listado genérico de ventas.

| Método | Ruta | Rol | Body/Query | Notas |
|---|---|---|---|---|
| `GET` | `/returns/sales/:numero` | cualquiera autenticado | — | Busca la venta por `numero` (lo que el mostrador conoce, no el `id` interno — mismo criterio que un ticket/comprobante). 404 si no existe. Devuelve `saleId`, `numero`, `fecha`, `estado`, `dentroDePlazo` (bool, calculado contra `dias_plazo_devolucion`), `items: [{ saleItemId, variantId, descripcionSnapshot, cantidadVendida, cantidadDisponible, netoLineaOriginal, netoLineaDisponible }]` (calculados leyendo `sale_items` + `return_items` agregados, sin locks — es una lectura, no compone con ninguna transacción de escritura), `payments: [{ metodo, monto }]` (la venta original, para que el frontend sugiera la proporción de RN-7). `SELLER`: sin `costoUnitario` en ningún lado (RN-10 de `sales`, mismo criterio). |
| `POST` | `/returns` | cualquiera autenticado (RN-1, mismo criterio que `sales`: "es el trabajo del vendedor") | `{ saleId: number, tipo: 'DEVOLUCION' \| 'CAMBIO', items: [{ saleItemId, cantidad, reingresaStock }], returnPayments: [{ metodo, monto, referencia? }], creditoAplicado?: { monto }, ventaNueva?: CreateSaleDto }`, header `Idempotency-Key` | Idempotente (RN-9 de §9.7, mismo patrón `withIdempotency` que `sales`/`cash-registers`). `tipo = CAMBIO` exige `creditoAplicado` y `ventaNueva`; `tipo = DEVOLUCION` los rechaza si vienen (400, "no aplica"). `esOwner` resuelto siempre del JWT (nunca del body), igual que `sales`. Devuelve la `Return` creada (y, si es cambio, el `id`/`numero` de la venta nueva). |
| `GET` | `/returns/:numero/credito` | cualquiera autenticado | — | **Nuevo, AMB-16 RESUELTA (diferido) — T5.8.** Busca la devolución por SU PROPIO `numero` (el "comprobante" que la clienta presenta más adelante, no el número de la venta original). 404 si no existe. Devuelve `{ returnId, numero, totalDevuelto, creditoConsumido, creditoDisponible, saleId }` — `creditoConsumido`/`creditoDisponible` calculados en vivo (`SUM(payments.monto) WHERE return_id = X AND metodo = CREDITO_DEVOLUCION`, sin columna de saldo cacheada — mismo criterio que `reconciliar()` de `sales`/`cash-registers`/`stock`: derivar de la fuente, no mantener una segunda verdad redundante). Es una lectura pura, sin lock (el lock real que protege de gastar de más ocurre recién en `POST /sales`, sección 5). |

**Extensión necesaria de un módulo ya cerrado (`sales`, Fase 12),
consecuencia directa de AMB-16 resuelta como diferido — T5.8:**
`CreateSaleDto`/`SalePaymentDto` ganan un campo `returnId?: number`,
válido únicamente junto con `metodo: CREDITO_DEVOLUCION` (400 si viene
con cualquier otro método, 400 si `CREDITO_DEVOLUCION` viene sin
`returnId`). `CobroPage.tsx` gana una quinta opción de medio de pago
("Aplicar crédito de devolución"): busca por número de devolución
(reusa `GET /returns/:numero/credito`), muestra el saldo disponible,
precarga el importe con el menor entre "saldo pendiente de la venta" y
"crédito disponible" — mismo criterio de UX que los atajos `1`-`4` ya
construidos en T4.11. Ver sección 5 para el mecanismo de validación
exacto que `sales.service.ts` gana con esto.

**Explícitamente fuera de esta fase (mismo criterio que los gaps ya
documentados de `sales`)**: `GET /returns`, `GET /returns/:id`
(listado/detalle históricos). No hay ticket que los reserve en
`ROADMAP.md` — quedan para cuando la pantalla de resultados/histórico
los necesite.

## 5. Transacciones y concurrencia

`ReturnsService.crearDevolucion(tx, input)` — **mismo contrato que
`SalesService.crearVenta`: recibe siempre el `tx` de una transacción ya
abierta por quien llama (el controller), nunca abre la suya propia.**

Orden exacto de una devolución simple (`tipo = DEVOLUCION`):

1. `cashRegisterService.getSesionAbiertaOrThrow(tx)` — fail-fast (RN-2).
2. Lock de la fila de sesión, **siempre** (`SELECT id FROM
   cash_register_sessions WHERE id = ${sesion.id} FOR UPDATE`) — mismo
   hallazgo que `sales`: no depende de si hay reintegro en efectivo.
3. Leer la venta (`sale_id`), verificar que existe y no está `ANULADA`
   (RN-1).
4. **Lock de los `sale_items` involucrados, ordenado por id** —
   `SELECT id FROM sale_items WHERE id IN (${ids}) ORDER BY id FOR
   UPDATE` (mismo patrón exacto que BLUEPRINT §9.4 exige para
   variantes, aplicado acá a líneas de venta en vez de variantes: sin
   este lock, dos devoluciones parciales concurrentes de la MISMA línea
   leen el mismo acumulado "viejo" y las dos podrían pasar el tope de
   RN-4, o las dos podrían creerse "la que agota la línea" y aplicar el
   remanente exacto de RN-5 dos veces).
5. Con el lock tomado, leer para cada `sale_item` involucrado:
   `SUM(return_items.cantidad)` y `SUM(return_items.neto_linea)` ya
   registrados contra esa línea (agregado sobre `return_items`, no
   sobre `returns` — puede haber devoluciones previas de otras
   devoluciones distintas).
6. Validar plazo (RN-3) contra `sale.fecha`.
7. Validar tope por línea (RN-4) con los acumulados del paso 5.
8. Calcular `neto_linea_devuelto` por línea (RN-5, incluida la regla
   del remanente exacto).
9. `total_devuelto = SUM(neto_linea_devuelto)`.
10. Validar `SUM(return_payments.monto) == total_devuelto` (RN-7),
    ANTES de escribir nada.
11. `tx.return.create` con `items`/`returnPayments` anidados en una
    sola escritura nested (mismo criterio que `sales.create` con
    `items`/`payments`/`discounts`).
12. Por cada `return_item` con `reingresaStock = true`:
    `stockService.reingresarPorDevolucion(tx, { variantId, cantidad,
    returnId, userId })` — **nuevo método de `stock.service.ts`**,
    mismo patrón que `descontarPorVenta`/`revertirPorAnulacion`
    (incremento atómico vía `{ increment: cantidad }`, sin lock propio
    porque la variante no se lee para decidir nada acá — a diferencia
    de `crearVenta`, reingresar stock nunca puede fallar por "no hay
    suficiente").
13. Si `SUM(return_payments WHERE metodo = EFECTIVO) > 0`:
    `cashRegisterService.registrarMovimiento(tx, { sessionId, tipo:
    DEVOLUCION, monto: esa suma, referenciaTipo: RETURN, referenciaId:
    return.id, descripcion: "Devolución venta #N", userId })`.

**`tipo = CAMBIO`**: los pasos 1–10 son idénticos (arman la devolución
con `sale_nueva_id` en `null` todavía). Después:

11. `tx.return.create` (paso 1 de RN-9).
12–13. Igual que arriba (reingreso de stock, movimiento de caja por la
    parte NO cubierta por crédito).
14. `salesService.crearVenta(tx, { ...ventaNueva, payments: [
    ...ventaNueva.payments, { metodo: CREDITO_DEVOLUCION, monto:
    creditoAplicado.monto, returnId: return.id } ] })` — reusa el
    mecanismo de `sales.service.ts` descrito abajo, con
    `returnId = return.id` (la devolución recién creada EN ESTA MISMA
    transacción, todavía sin ningún crédito consumido — el chequeo de
    invariante 14 pasa trivialmente acá, pero corre igual, sin caso
    especial: es el mismo código que protege el uso diferido).
15. `tx.return.update({ where: { id: return.id }, data: { saleNuevaId:
    sale.id } })` (paso 4 de RN-9).

**Mecanismo compartido en `SalesService.crearVenta` (AMB-16 RESUELTA
como diferido — construido en T5.5, reusado por RN-9 arriba y por
T5.8): cambio real, no un passthrough.**

Antes: `CrearVentaPaymentInput` no tenía campo `returnId` en absoluto
(leí el archivo completo en esta sesión — no es que faltara validarlo,
el campo no existía), así que `payments.return_id` nunca se persistía.
Con el crédito confirmado como diferido, la validación de que no se
gasta de más (invariante 14) tiene que vivir DENTRO de `crearVenta`
misma — no en `returns.service.ts` — porque cualquier `POST /sales`
futuro, sin relación alguna con el `returns` que originó el crédito,
puede intentar gastarlo (T5.8). Pasos nuevos dentro de `crearVenta`,
insertados junto al resto de la validación de pagos (paso 8 de la spec
de `sales`, "cada pago tiene que ser positivo"):

1. `returnId?: number` opcional en `CrearVentaPaymentInput`. Válido
   solo junto con `metodo: CREDITO_DEVOLUCION` (400 en cualquier otra
   combinación — un pago en efectivo con `returnId` no tiene sentido,
   y un `CREDITO_DEVOLUCION` sin `returnId` no tiene ninguna
   devolución real detrás que lo respalde).
2. Para cada payment con `returnId` presente: **lock de la fila de la
   `Return` referenciada** — `SELECT id FROM returns WHERE id IN
   (${ids}) ORDER BY id FOR UPDATE` (mismo patrón exacto de BLUEPRINT
   §9.4, aplicado acá a devoluciones en vez de variantes/sesiones —
   **sin este lock, dos ventas simultáneas que gastan el mismo crédito
   podrían leer el mismo "consumido hasta ahora" y las dos pasar**,
   violando el invariante 14 igual que dos ventas simultáneas de la
   última unidad violarían el invariante 5 sin el lock de variante).
3. Con el lock tomado: `tx.return.findUnique` (404 si no existe) +
   `tx.payment.aggregate({ where: { returnId, metodo:
   CREDITO_DEVOLUCION }, _sum: { monto: true } })` → si
   `consumido_previo + monto_de_este_pago > return.totalDevuelto`,
   400 ("El crédito de la devolución #N no alcanza — disponible: $X").
4. `paymentsData` persiste `returnId: p.returnId ?? null` tal cual en
   `tx.sale.create`'s `payments.create`.

Sin impacto en ningún test existente de `sales` (campo opcional,
default `null`, los pasos 1–3 solo corren cuando `returnId` está
presente). `sales.service.ts` consulta `tx.return`/`tx.payment`
directamente — **sin importar `ReturnsService` ni crear una
dependencia circular de módulos**, mismo patrón que `anularVenta` ya
usa contra `tx.return.findFirst` (Fase 04 de T4.7) sin que `sales`
dependa de un módulo `returns` que en ese momento ni existía.

**Números de devolución**: `numero` ya es
`@unique @default(autoincrement())` en el schema (secuencia de
Postgres, BLUEPRINT §9.4/§9.7) — sin ninguna decisión nueva acá, mismo
mecanismo que `sales.numero`.

## 6. Edge cases

- **Devolver cantidad 0**: rechazado — mismo criterio que `sale_items`
  (`cantidad > 0`, CHECK de base + `@Min(1)` del DTO).
- **Devolver toda una línea de una vez**: `neto_linea_devuelto` =
  remanente exacto (coincide con la fórmula normal cuando
  `cantidad_ya_devuelta_antes = 0`, no es un caso especial en la
  práctica, solo en la definición).
- **Devolver la misma línea en dos devoluciones parciales sucesivas**:
  la primera usa la fórmula proporcional; la segunda, si agota la
  línea, usa el remanente exacto — el test obligatorio de este
  comportamiento (AD-18) es de los dos que la sección 9 exige sin
  excepción.
- **Devolver más de lo vendido (considerando previas)**: 400
  (invariante 8/RN-4).
- **Fuera de plazo, sin autorización (`esOwner = false`)**: 400/403
  (RN-3) — mismo bloqueo simple que AMB-14 diferida de `sales`.
- **Fuera de plazo, con `esOwner = true`**: permitido,
  `autorizado_por_user_id` se completa con el id de quien opera (que
  YA es `OWNER` — no hay "otro" `OWNER` autorizando a un `SELLER`
  todavía, mismo motivo que AMB-14 diferida: la clienta hoy no tiene
  empleados).
- **Venta ya `ANULADA`**: 409 (RN-1/AD-19).
- **Venta con reintegro mixto original** (pagada mitad efectivo, mitad
  tarjeta): el reintegro NO tiene que respetar esa proporción — RN-7,
  el cliente decide.
- **Cambio, prenda nueva más cara**: la venta nueva lleva el pago
  `CREDITO_DEVOLUCION` más otro(s) pago(s) normal(es) por la
  diferencia — camino feliz de `crearVenta` sin ninguna regla nueva.
- **Cambio, prenda nueva más barata**: el excedente se reintegra por
  los medios habituales (`return_payments` además del
  `CREDITO_DEVOLUCION`) — sigue cumpliendo `SUM(return_payments) ==
  total_devuelto`.
- **Cambio, prenda nueva del mismo precio**: `creditoAplicado.monto ==
  total_devuelto`, sin ningún otro `return_payment` ni pago adicional
  en la venta nueva.
- **Doble click / reintento de red (RN-9 de §9.7)**: `Idempotency-Key`
  + `withIdempotency`, mismo patrón exacto que `sales`/`cash-registers`
  — el índice único de `returns.idempotency_key` ya existe desde la
  Fase 01.
- **`reingresaStock = false` en todas las líneas**: se devuelve el
  dinero, no se toca stock — camino explícitamente soportado, no un
  edge case raro (mercadería fallada es un caso real de mostrador).
- **Sin sesión de caja abierta**: 409, ANTES de leer nada más (RN-2).
- **`return_payments` todos por tarjeta**: no genera ningún
  `cash_movement` (RN-8) — a diferencia de una venta, que siempre
  necesita AL MENOS un pago, una devolución con reintegro 100% no
  efectivo es un camino válido y común.
- **Refresco de página a mitad de una devolución**: mismo mecanismo que
  T4.10 de `sales` (`sessionStorage` + `Idempotency-Key` persistida) —
  responsabilidad de T5.7, no de este documento resolver el detalle de
  UI, solo dejar constancia de que el mecanismo ya existe y se reusa.
- **Crédito diferido, gastado en una venta días después, sin relación
  con `returns.service.ts`** (AMB-16 resuelta): camino soportado a
  propósito — `POST /sales` con un pago `CREDITO_DEVOLUCION` +
  `returnId` de una devolución vieja, en una sesión de caja distinta a
  la que generó el crédito. El chequeo de invariante 14 corre igual
  (sección 5).
- **Crédito ya gastado completamente en una venta anterior, se intenta
  usar de nuevo**: 400, "no alcanza — disponible: $0".
- **Dos ventas simultáneas intentando gastar el mismo crédito
  (concurrencia real, mismo criterio que T4.9/T5.6)**: una pasa, la
  otra rechaza — nunca las dos, gracias al lock de la fila de `Return`
  (sección 5).
- **Crédito parcial**: una devolución de $1000 se gasta $600 en una
  venta y $400 en otra, separada — cada `POST /sales` valida contra el
  saldo restante en ese momento, no contra el `total_devuelto`
  original.
- **`GET /returns/:numero/credito` de una devolución que en realidad
  fue el resultado de un `CAMBIO` (no de una `DEVOLUCION` simple)**:
  responde igual (el crédito quedó completo o parcialmente consumido
  por la propia venta nueva del cambio, mismo cálculo en vivo) — no hay
  ninguna distinción especial por `tipo` en este endpoint.

## 7. Errores

| Situación | Status | Mensaje al usuario |
|---|---|---|
| Venta inexistente | 404 | "Venta no encontrada" |
| Venta `ANULADA` | 409 | "Esta venta está anulada, no admite devoluciones" |
| Sin sesión de caja abierta | 409 | "No hay una sesión de caja abierta" (mismo texto que `sales`/`cash-registers`) |
| Cantidad a devolver supera lo disponible en la línea | 400 | Identifica la línea y cuánto queda disponible |
| Fuera de plazo sin autorización | 400/403 | Indica el plazo vigente y que necesita autorización de un `OWNER` |
| `SUM(return_payments) != total_devuelto` | 400 | "Los reintegros no cubren el total de la devolución" (mismo criterio textual que `sales`) |
| `tipo = CAMBIO` sin `creditoAplicado`/`ventaNueva` | 400 | "Un cambio necesita la venta nueva y el crédito aplicado" |
| `tipo = DEVOLUCION` con `creditoAplicado`/`ventaNueva` presentes | 400 | "Una devolución simple no lleva venta nueva" |
| Crédito aplicado supera lo disponible de la devolución (invariante 14, `POST /sales`) | 400 | "El crédito de la devolución #N no alcanza — disponible: $X" |
| Pago `CREDITO_DEVOLUCION` sin `returnId` (`POST /sales`) | 400 | "Un pago con crédito de devolución necesita indicar cuál" |
| `returnId` en un pago que no es `CREDITO_DEVOLUCION` (`POST /sales`) | 400 | "El crédito de devolución solo aplica a ese método de pago" |
| `GET /returns/:numero/credito` con número inexistente | 404 | "Devolución no encontrada" |

## 8. Permisos

| Acción | `OWNER` | `SELLER` |
|---|---|---|
| Crear devolución/cambio dentro de plazo | ✅ | ✅ (RN-1, mismo criterio que crear venta) |
| Crear devolución/cambio fuera de plazo | ✅ (se autoriza a sí mismo, trivialmente) | ❌ hasta que exista el mecanismo de autorización (construcción diferida, mismo criterio que AMB-14 de `sales`) |
| Consultar cuánto crédito queda de una devolución (`GET /returns/:numero/credito`) | ✅ | ✅ (sin dato de costo/margen de por medio, nada que ocultar) |
| Aplicar crédito de una devolución a una venta nueva (T5.8) | ✅ | ✅ (mismo criterio que crear venta — es cobrar, no autorizar nada) |
| Ver devoluciones hechas por otro vendedor | ✅ | ✅ — sin restricción de "mis devoluciones" (blueprint no define ese límite, mismo criterio que RN-2 de `cash-registers` y sección 8 de `sales`) |
| Ver `costoUnitario` en `GET /returns/sales/:numero` | ✅ | ❌ (RN-10 de `sales`, mismo criterio) |
| Anular una devolución | — | — (no existe: "las devoluciones no se anulan", §5.4 literal) |

## 9. Tests necesarios

- **Unitarios (Jest, servicio mockeado)** — cubren cada RN de la
  sección 2 y cada invariante de la sección 3 por separado, mismo
  criterio de exhaustividad que `sales.service.spec.ts`.
- **Los dos tests obligatorios de AD-18, literales**: (a) una
  devolución parcial de una línea con descuento, verificando
  `neto_linea_devuelto` proporcional, no el precio de lista; (b) dos
  devoluciones sucesivas de la misma línea donde la segunda agota la
  cantidad, verificando que la SEGUNDA usa el remanente exacto (no la
  fórmula proporcional) y que `SUM` de las dos nunca difiere del
  `neto_linea` original ni por un centavo.
- **Concurrencia real (Postgres, T5.6 del roadmap explícito)**: dos
  devoluciones parciales simultáneas de la MISMA línea, cerca del
  tope — una pasa, la otra rechaza por invariante 8, nunca las dos.
  Mismo patrón que T4.9 de `sales` (repetido varias veces con datos
  frescos por iteración).
- **Integración (Postgres real)**:
  - Devolución simple, camino feliz: reingresa stock, mueve caja
    (parte efectivo), `total_devuelto` correcto.
  - Devolución con `reingresaStock = false`: dinero devuelto, stock
    intacto.
  - Cambio completo: devolución + venta nueva ligadas, crédito
    consumido, `sale_nueva_id` actualizado, verificado contra
    `payments.return_id` de la venta nueva.
  - Rechazos con rollback completo (mismo patrón que `sales`): venta
    anulada, sin sesión abierta, cantidad excede lo disponible, fuera
    de plazo sin autorización, suma de reintegros no coincide —
    verificando en cada caso que no quedó ninguna fila creada en
    `returns`/`return_items`/`return_payments`/`stock_movements`/
    `cash_movements`, y que `stock_actual` no cambió.
  - Idempotencia: doble click da la misma devolución, una sola fila.
- **Testing de mutación (Stryker, obligatorio — BLUEPRINT §9.8 lista
  `returns` literal)**: umbral 80%, mismo criterio que `sales`/
  `cash-registers`/`stock`.
- **Crédito diferido (AMB-16, T5.5 + T5.8) — en `sales.service.spec.ts`/
  `sales.integration.spec.ts`, no en los archivos de `returns`**: pago
  `CREDITO_DEVOLUCION` sin `returnId` → 400; con `returnId` de una
  devolución inexistente → 404; que excede el disponible → 400,
  mensaje con el saldo real; que coincide exacto con el disponible →
  201, saldo queda en $0; gastado parcialmente en dos ventas
  sucesivas, la segunda valida contra el saldo restante, no el
  original; **concurrencia real (Postgres)**: dos ventas simultáneas
  gastando el mismo crédito cerca del límite — una pasa, la otra
  rechaza, nunca las dos (mismo patrón que T4.9/T5.6, repetido con
  datos frescos por iteración).

## 10. Ambigüedades

**AMB-16 — ¿El crédito de una devolución se consume SOLO dentro del
mismo flujo atómico de cambio, o puede quedar disponible para usarse
en una venta separada, más adelante? RESUELTA (2026-08-25) —
diferido.**

**Descripción original:** el texto de §5.4 describe el `CAMBIO` como
una secuencia de 4 pasos, toda en una transacción — no menciona en
ningún lado la posibilidad de que el crédito quede "guardado" para
después. Pero el modelo de datos (`Payment.returnId`, campo general,
sin restricción de "solo dentro de la misma transacción") y el
invariante 14 (redactado sin acotar "dentro del mismo request")
dejaban la puerta abierta a un crédito diferido.

**Resolución:** el PO confirmó explícitamente lo opuesto a la
recomendación de esta sesión: **"debería permitir, sería como una nota
de crédito"** — el crédito de una devolución queda disponible para
aplicarse a una venta futura, sin relación con el momento ni la sesión
de caja que lo generó.

**Consecuencia de diseño, ya incorporada al resto de este documento**
(secciones 4, 5, 6, 7, 9, 11): la validación del invariante 14 no
puede vivir solo en `returns.service.ts` — vive en
`SalesService.crearVenta`, con su propio lock sobre la fila de
`Return` (sección 5), porque cualquier `POST /sales` futuro puede
intentar gastar un crédito viejo. Nuevo endpoint de consulta
(`GET /returns/:numero/credito`) y nueva forma de aplicar el crédito
desde la pantalla de cobro normal (T5.8, sección 11) — superficie real,
no un ajuste menor de T5.5.

Sin ambigüedades PENDIENTES al cierre de esta fase.

## 11. Tickets

Los 7 tickets de `state/ROADMAP.md` (T5.1–T5.7) siguen siendo
correctos en su objetivo y dependencias. **Un ticket nuevo, T5.8**
(agregado a `ROADMAP.md` como consecuencia directa de AMB-16 resuelta
como diferido): "Aplicar crédito de una devolución a una venta
posterior" — `GET /returns/:numero/credito` (nuevo endpoint, dueño
`returns`) + la quinta opción de medio de pago en `CobroPage.tsx`
(dueño `sales`, ya cerrado en su Fase 12 — extensión aditiva, mismo
criterio que cualquier ticket que ya tocó un módulo ajeno de forma
mínima y justificada). Depende de T5.5 (que construye el mecanismo
compartido de `sales.service.ts` que T5.8 reusa) y T5.1 (que genera
las primeras devoluciones reales con crédito para aplicar).

**Ajuste técnico dentro de T5.5** (no un ticket aparte, mismo criterio
que `sales` extendiendo `stock`/`cash-registers` sin que eso fuera un
ticket separado): el cambio en `sales.service.ts`/
`sales.service.spec.ts` descrito en la sección 5 (`returnId?` opcional
en `CrearVentaPaymentInput`, lock de `Return`, validación de invariante
14, persistido en `payments.create`). Sin tests existentes de `sales`
que se rompan (campo opcional, default implícito `null`).

**T5.1–T5.4, T5.6 y T5.8** son "plata y stock" (Etapa 5, excepción
literal de BLUEPRINT §9.8) — dos sesiones separadas cada uno
(`04a-tests-first.md` + `04-ticket-execution.md`), mismo criterio que
Etapa 4. **T5.5** también, por tocar `payments`/crédito. **T5.7**
(pantallas de devolución/cambio) es frontend — Fase 04a no aplica,
mismo criterio que T4.10/T4.11.

**Sin bloqueos pendientes** — los 8 tickets de la etapa pueden
construirse siguiendo el orden de dependencias ya declarado
(`ROADMAP.md`).
