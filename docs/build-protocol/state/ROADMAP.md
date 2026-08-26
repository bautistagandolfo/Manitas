# ROADMAP

Tickets de construcción del MVP, en orden de dependencias.

Estados: `PENDIENTE` · `EN CURSO` · `VERDE` · `BLOQUEADO`

**Regla:** no se empieza un ticket si sus dependencias no están VERDE.
Este archivo se actualiza al cerrar cada ticket, junto con `STATUS.md`.

> Este roadmap es la versión inicial derivada del `BLUEPRINT.md`. La Fase 02
> lo revisa y ajusta; las Fases 06 (spec de módulo) pueden agregar o dividir
> tickets dentro de su módulo.

---

## Hitos de entrega

El MVP no se entrega de una sola vez. Estos son los puntos donde tiene
sentido mostrarle algo a la clienta:

| Hito | Incluye | Qué puede hacer ella |
|---|---|---|
| **H1** | Etapas 0 + 1 + 2 | Cargar su catálogo y ver su stock. Todavía no vende con el sistema. |
| **H2** | + Etapas 3 + 4 | **Primera entrega real:** vender, cobrar y cerrar caja. Devoluciones a mano por ahora. |
| **H3** | + Etapa 5 | Devoluciones y cambios dentro del sistema. |
| **H4** | + Etapa 6 + Etapa 7 | Gastos y resultados. **Recién acá responde "¿gano o pierdo?"**, que es lo que pidió. |

**H2 es el hito que más importa:** es cuando el sistema empieza a producir
datos reales y a enseñar cosas que ninguna planificación anticipa. Conviene
llegar ahí lo antes posible y no esperar a H4 para mostrarle nada.

---

## Etapa 0 — Cimientos

Sin módulos de negocio. Es la base sobre la que se apoya todo.

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T0.1 | Bootstrap NestJS + TS estricto + estructura de carpetas + lint + Jest + CI | — | VERDE |
| T0.2 | Prisma + Postgres en docker-compose + config validada con zod + `/health` | T0.1 | VERDE |
| T0.3 | Esquema completo de Prisma (blueprint §3) + primera migración | T0.2 | VERDE |
| T0.4 | Constraints de base de datos + secuencias de numeración + seed (usuario OWNER + categorías de gasto) | T0.3 | VERDE |
| T0.5 | Frontend Vite + React + **Mantine** + routing + cliente HTTP con cookies | T0.1 | VERDE |
| T0.9 | `seed:dev` con datos realistas para desarrollo (nunca en producción) | T0.4 | PENDIENTE |
| T0.10 | **Stryker** (testing de mutación) + umbral de cobertura 80% en servicios, en CI | T0.1 | PENDIENTE |
| T0.6 | Backup diario: GitHub Action con `pg_dump` cifrado a almacenamiento externo | T0.3 | PENDIENTE |
| T0.7 | Zona horaria: helper de agrupación en hora argentina + test (AD-13) | T0.3 | PENDIENTE |
| T0.8 | Regla de lint que prohíba `number` para importes (AD-14) | T0.1 | VERDE |
| T0.11 | Helpers de formato es-AR (§12.3): moneda, fecha, número — prohibido formatear a mano en un componente | T0.5 | VERDE |
| T0.12 | Helpers de `Decimal` y redondeo comercial (AD-14): prorrateo a líneas, los dos tests obligatorios de §9.3 | T0.1 | VERDE |
| T0.13 | Tabla `settings` + servicio tipado de lectura/escritura + seed de los 4 parámetros de la sección 10 | T0.4 | VERDE |
| T0.14 | Interceptor común de idempotencia (`Idempotency-Key`, índice único — BLUEPRINT §9.7) | T0.1 | VERDE |

> T0.1–T0.5 y T0.8 corresponden a las Fases 00 y 01 del protocolo, ya en
> VERDE (T0.5 solo por el esqueleto: los helpers es-AR quedan en T0.11, y la
> regla de lint de T0.8 ya está pero los helpers de `Decimal`/redondeo
> quedan en T0.12 — ninguna de las dos fases tocó lógica de negocio, así
> que no correspondía implementarlos ahí).
> **T0.6 no se pospone**: sin backup andando, no se carga un solo dato real.
> **T0.11 a T0.14 son agregados de esta revisión (fase 02).** El roadmap
> original no tenía ticket para los helpers de dinero, para `settings`
> (blueprint §3.8 y §10 completos, sin dueño en ningún módulo) ni para el
> interceptor de idempotencia como pieza compartida — sin este último acá,
> T3.3, T4.5, T5.1 y T6.2 (que lo necesitan por BLUEPRINT §9.7) quedaban con
> una dependencia hacia adelante rota si el interceptor se construía recién
> dentro de T4.5, en la etapa 4.

---

## Etapa 1 — `auth`

Todos los módulos dependen de esto.

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T1.1 | Usuarios: hash argon2, alta, listado, edición, baja lógica — no permite desactivar ni bajar de rol al último `OWNER` activo | T0.4 | VERDE |
| T1.2 | Login + JWT en cookie httpOnly (**12 h** — BLUEPRINT §9.6) + logout | T1.1 | VERDE |
| T1.3 | Guard de autenticación + `RolesGuard` (OWNER / SELLER) — incluye `GET /auth/me` | T1.2 | VERDE |
| T1.4 | Pantalla de login + manejo de sesión + rutas protegidas en frontend | T1.3, T0.5 | VERDE |

**Cierre:** Fases 07 → 08 → 09 → 10 → 11 → 12.

---

## Etapa 2 — `products` / `variants` + stock

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T2.1 | ABM de marcas, categorías, **talles y colores** (listas, AD-15) | T1.3 | VERDE |
| T2.2 | ABM de productos | T2.1 | VERDE |
| T2.3 | ABM de variantes (SKU único, barcode único, precio, costo) | T2.2, **T0.12** | VERDE |
| T2.4 | **`stock.service`**: movimientos + contador, transaccional. Único punto que escribe stock | T2.3 | VERDE |
| T2.5 | Ingreso de mercadería con costo → actualiza `costo_actual` + `price_history` | T2.4, **T0.12** | VERDE |
| T2.6 | Ajuste de stock (solo OWNER, motivo obligatorio) | T2.4 | VERDE |
| T2.7 | Buscador unificado: nombre / SKU / código de barras | T2.3 | VERDE |
| T2.8 | Test de reconciliación del invariante 1 (`stock_actual == SUM(movimientos)`) | T2.4 | VERDE |
| T2.9 | **`price_history`**: registro de todo cambio de precio y costo (AD-16) | T2.3, **T0.12** | VERDE |
| T2.10 | **Actualización masiva de precios** con vista previa (blueprint §5.2) | T2.9, **T0.12** | VERDE |
| T2.11 | **Alta de variantes por grilla** (talles × colores, blueprint §12.2) | T2.3, **T0.12** | VERDE |
| T2.12 | Pantallas de catálogo, stock e ingreso de mercadería | T2.5, T2.6, T2.7, T2.11, **T0.11** | VERDE |
| T2.13 | **Importación de catálogo por CSV** (productos, variantes, stock inicial, costos), validación con reporte de errores línea por línea (`DECISIONES_PENDIENTES.md` C2) | T2.4, T2.9 | VERDE |

**T2.4 es el ticket más delicado de esta etapa.** Blueprint §9.4 y AD-4.
El costo solo lo ve `OWNER`.

**T2.10 y T2.11 no son adornos.** Sin actualización masiva, la clienta vuelve
a la planilla cuando tenga que remarcar. Sin alta por grilla, cargar la
tienda desde cero (hoy no tiene nada digitalizado) es inviable.

**T2.3, T2.5, T2.9, T2.10, T2.11 y T2.12 agregan dependencias de Etapa 0**
(fase 06 de este módulo, `state/reports/modulo-products-variants-spec.md`,
sección 11): T0.12 (helpers de `Decimal`/redondeo) y T0.11 (helpers de
formato es-AR) siguen `PENDIENTE` — hay que ejecutarlos antes de arrancar
los tickets que dependen de ellos. **T2.1 y T2.2 no dependen de ninguno de
los dos y pueden arrancar ya.**
>
> **T0.14 (interceptor de idempotencia): construido con el alcance
> literal de BLUEPRINT §9.7** — `sales`/`returns`/`cash_movements`/
> `expenses`, las cuatro tablas que ya tienen `idempotency_key` en el
> schema. Extenderlo a T2.5 (recomendación de la fase 06) hubiese
> exigido agregar esa columna a `stock_movements`, algo que el
> blueprint no pide — decisión explícita del PO (2026-08-23): **no**
> extenderlo, T2.5 queda sin esa dependencia. Ver
> `state/reports/modulo-products-variants-spec.md` sección 11 para el
> razonamiento original, y esta nota para la decisión final.

**T2.13 es nuevo (fase 06, `DECISIONES_PENDIENTES.md` C2 — "es un ticket
nuevo de la Etapa 2, no un extra").** Su formato exacto de columnas quedó
sujeto a AMB-12 — **RESUELTA** (2026-08-23, plantilla propia): T2.13
desbloqueado y ejecutado. **Etapa 2 completa (T2.1–T2.13, todos VERDE).**

**Cierre:** Fases 07 → 08 → 09 → 10 → 11 → 12.

---

## Etapa 3 — `cash-registers`

Va **antes** de ventas: no se puede vender sin caja abierta.

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T3.1 | Apertura de sesión con monto inicial + constraint de sesión única abierta | T1.3 | VERDE |
| T3.2 | Movimientos de caja (servicio base, solo efectivo — AD-8) | T3.1 | VERDE |
| T3.3 | Ingreso manual y retiro de efectivo, idempotente (BLUEPRINT §9.7 — es el ejemplo textual del doble click en un retiro) | T3.2, T0.14 | VERDE |
| T3.4 | Cierre con arqueo: monto declarado, monto sistema, diferencia y nota obligatoria si supera `umbral_diferencia_caja` | T3.2, T0.13 | VERDE |
| T3.5 | **Sesión olvidada abierta**: detección al entrar y cierre obligatorio | T3.4 | VERDE |
| T3.6 | Test del invariante 2 (arqueo) | T3.4 | VERDE |
| T3.7 | Pantallas de apertura, movimientos y cierre | T3.5 | VERDE |

> **T3.3 bloqueada por AMB-13 (fase 06 de este módulo, nueva):** el
> blueprint no dice quién puede hacer un ingreso manual o un retiro de
> efectivo — a diferencia de `products`/`variants` (AMB-11), acá no hay
> ningún texto que sugiera que es tarea típica de `SELLER`, y mover
> efectivo fuera del flujo normal de venta es el punto de mayor riesgo
> operativo del módulo. Recomendación: `OWNER`-only para ambas. Ver
> `state/AMBIGUITIES.md` AMB-13 y
> `state/reports/modulo-cash-registers-spec.md` sección 10.
>
> **AMB-13 RESUELTA (2026-08-24):** el PO aprobó la recomendación —
> `OWNER`-only para `INGRESO_MANUAL` y `RETIRO`. **T3.3 desbloqueada.**
>
> **T3.4 sigue esperando T0.13** (`settings`, todavía `PENDIENTE`) para
> el valor real de `umbral_diferencia_caja` — AMB-10 ya está
> **RESUELTA** ($500 fijo), así que T0.13 puede sembrar ese valor sin
> esperar nada más. Recomiendo ejecutar T0.13 antes de T3.4; T3.1, T3.2
> y T3.3 (una vez resuelta AMB-13) no dependen de T0.13 y pueden
> avanzar antes.
>
> **T0.13 en VERDE (2026-08-24).** `umbral_diferencia_caja` sembrado en
> $500 (`SettingsService.getDecimal('umbral_diferencia_caja')`).
> **T3.4 desbloqueada.**
>
> **T3.5, alcance real (2026-08-24):** el ticket dice "detección al
> entrar y cierre obligatorio", pero la spec del módulo (RN-7) ya
> explica que no hay ninguna lógica de "detección" del lado del
> backend — alcanza con exponer `GET /cash-registers/sessions/open`
> (nuevo en este ticket) con `fechaApertura` y `montoSistema`
> recalculado en vivo. La comparación contra "hoy" en hora argentina y
> el bloqueo real de la interfaz hasta cerrar ("obligatorio") son del
> lado del frontend — no existen pantallas de `cash-registers` todavía
> (son T3.7). Quedan explícitamente para T3.7, no resueltos acá.
>
> **Hallazgo técnico (fase 06 de este módulo): T4.4, T4.7 y T5.3 no
> listaban `T3.2` como dependencia**, a pesar de que BLUEPRINT §5.3
> (paso 7, y la regla de anulación) y §5.4 (reintegro en efectivo)
> dejan claro que ambos necesitan llamar al servicio base de
> `cash-registers` para registrar sus propios movimientos de caja —
> mismo servicio que `T6.3` (gastos) sí lista correctamente. Corregido
> acá agregando `T3.2` a las tres. Ver
> `state/reports/modulo-cash-registers-spec.md` sección 11 para el
> detalle.

**Cierre:** Fases 07 → 08 → 09 → 10 → 11 → 12.

---

## Etapa 4 — `sales`

El módulo más crítico del sistema.

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T4.1 | Servicio de venta transaccional con **bloqueo de filas ordenado por id** (blueprint §9.4), respeta `permitir_venta_sin_stock` | T2.4, T3.2, T0.13 | VERDE |
| T4.2 | Congelado de precio y costo en la línea (AD-5) + `descripcion_snapshot` | T4.1 | VERDE |
| T4.3 | Descuentos: N por venta, límite del vendedor (`max_descuento_vendedor_pct`) y autorización de OWNER | T4.1, T0.13 | VERDE (autorización por contraseña diferida, ver nota) |
| T4.4 | Pagos: N por venta, validación suma = total, impacto en caja solo si es efectivo | T4.1, **T3.2** | VERDE |
| T4.5 | Aplicar el interceptor de idempotencia (T0.14) a la venta | T4.1, T0.14 | VERDE (alcance recortado por falta de controller, ver nota) |
| T4.6 | **Ajuste de redondeo** + tests de las reglas de redondeo (§9.3) | T4.4, T0.12 | VERDE |
| T4.7 | Anulación de venta: revierte stock y caja con movimientos nuevos | T4.4, **T3.2** | VERDE |
| T4.8 | Tests de invariantes 3, 4, 5 y 7 | T4.6 | VERDE |
| T4.9 | Test de concurrencia: dos ventas simultáneas de la última unidad | T4.1 | VERDE |
| T4.10 | **Pantalla de venta con teclado y lector** (blueprint §12.1) | T4.5, T4.6 | VERDE |
| T4.11 | Pantalla de cobro: medios de pago, saldo pendiente, vuelto | T4.10 | VERDE |

**T4.10 es el ticket más importante del sistema en experiencia de uso.**
El flujo completo tiene que poder hacerse sin tocar el mouse. Especificación
completa en la sección 12.1 del blueprint.

> **Alcance real de T4.10 (2026-08-25):** §12.1 describe "venta" y "cobro"
> como un único flujo continuo, pero el `ROADMAP.md` los separa en dos
> tickets — T4.10 construye únicamente el armado del carrito (buscador,
> agregar/incrementar líneas, descuento F4, cancelar Esc), sin enviar
> nada al backend todavía: no existe `SalesController` (T4.1-T4.9 solo
> construyeron `SalesService`), así que no hay ruta HTTP donde confirmar
> una venta. `F2` ("ir a cobrar") muestra un aviso honesto de que la
> pantalla de cobro es T4.11, con el borrador (y su clave de
> idempotencia, generada al entrar a la pantalla) ya listos en
> `sessionStorage` para cuando exista. Mismo criterio que AMB-14 (T4.3) y
> el recorte de T4.5: se construye lo que depende solo de este ticket, se
> deja marcado explícitamente lo que falta, sin inventar mecánica de
> T4.11.
>
> **Bug real encontrado y corregido en este ticket, ajeno al código de
> `sales`:** el `Modal` de Mantine (v9.5.1) no reacciona al prop
> `opened` cuando el componente queda SIEMPRE montado y ese prop
> transiciona de `false` a `true` — confirmado empíricamente en el
> navegador real (con logs de estado de React, no solo inspección de
> código): el estado de React cambiaba correctamente, pero Mantine nunca
> montaba el contenido del modal. El modal de descuento (F4), montado
> recién cuando hace falta (`{flag && <Modal opened>...}`), sí
> funcionaba — ese patrón es el que se aplicó también a los otros dos
> modales de esta pantalla (confirmar cancelación, aviso de "ir a
> cobrar"). Vale la pena tenerlo presente para cualquier modal futuro de
> este proyecto que necesite abrirse por un cambio de estado en vez de
> por montaje condicional.
>
> **Alcance real de T4.11 (2026-08-25):** cierra lo que T4.10 dejó
> explícitamente pendiente — construye el primer `SalesController`/
> `SalesModule` (backend) y la pantalla de cobro (frontend) que lo
> consume. **Un solo endpoint por decisión de alcance: `POST /sales`.**
> `GET /sales`, `GET /sales/:id` y `POST /sales/:id/anular` siguen en la
> tabla de rutas de `modulo-sales-spec.md` sección 4.1, pero ningún
> ticket del roadmap los reserva todavía (no hay ticket de historial ni
> de anulación en la UI en la Etapa 4) y la pantalla de cobro no los
> necesita — la respuesta de `POST /sales` ya alcanza para confirmar el
> cobro. Quedan para cuando exista ese ticket futuro, mismo criterio que
> el recorte de T4.5.
>
> Idempotencia (RN-9, T0.14) wireada por primera vez para `sales`: mismo
> patrón que `POST /cash-registers/movements/ingreso` (T3.3) —
> `IdempotencyInterceptor` + `@IdempotencyKey()` + `withIdempotency`,
> reusando tal cual la clave que `SalePage` (T4.10) ya generaba y
> persistía sin consumir.
>
> **Hallazgo de fase 04a, corregido antes de implementar:** el `afterAll`
> del archivo de tests nuevo (`sales-controller.integration.spec.ts`)
> reabría todas las sesiones de caja de prueba en lote antes de borrarlas
> — mismo bug de "una sola sesión ABIERTA a la vez" ya corregido en
> `sales.integration.spec.ts` (T4.1) y `sales-anulacion.integration.spec.ts`
> (T4.7), reintroducido acá porque cada sesión aislada nueva parte de cero
> y no hereda el conocimiento de sesiones anteriores — reescrito para
> procesar una sesión por vez, de punta a punta.

> **T4.3 bloqueada por AMB-14 (fase 06 de este módulo, nueva):** el
> blueprint confirma el tope de descuento del vendedor (10%, AMB-3)
> pero no dice **cómo** un `OWNER` autoriza en el momento un descuento
> que lo supera, con la vendedora logueada en el mostrador y sin
> sesión de `OWNER` activa. Recomendación: contraseña de supervisor,
> verificada por el backend sin cambiar la sesión activa. Ver
> `state/AMBIGUITIES.md` AMB-14 y `state/reports/modulo-sales-spec.md`
> sección 10. **T4.1, T4.2, T4.4–T4.11 no dependen de esta respuesta y
> pueden avanzar ya.**
>
> **AMB-14 RESUELTA (2026-08-25):** el PO aprobó la recomendación —
> contraseña de un `OWNER` en el propio formulario, verificada por el
> backend sin emitir sesión nueva. **T4.3 desbloqueada.**
>
> **Alcance de T4.3 achicado a propósito (2026-08-25):** la clienta hoy
> no tiene empleados — es la única usuaria, siempre `OWNER`, que se
> autoriza a sí misma trivialmente. T4.3 construye el registro de
> descuentos (N por venta, prorrateo real vía `prorate()`) y el tope
> duro (`0 ≤ descuento_total ≤ subtotal`) siempre, más el tope del
> vendedor evaluado solo si quien vende no es `OWNER` — pero **sin** el
> mecanismo de autorización por contraseña: si un `SELLER` lo excede,
> la venta se rechaza sin vía de autorización todavía (bloqueo simple,
> no roto — nadie lo va a pisar hasta que exista un `SELLER` real). El
> mecanismo de AMB-14 queda como agregado chico para cuando haga falta,
> no como deuda técnica ni como bug. Ver `state/AMBIGUITIES.md` AMB-14,
> nota "Construcción diferida".
>
> **Alcance de T4.5 recortado por una limitación estructural real
> (2026-08-25):** `sales` todavía no tiene `SalesController` ni módulo
> Nest (T4.1–T4.4 construyeron únicamente `SalesService`, a propósito —
> los controllers son T4.10/T4.11), así que no existe ninguna ruta HTTP
> donde aplicar `IdempotencyInterceptor`/`@IdempotencyKey()` (T0.14) de
> verdad todavía. T4.5 construye lo que sí depende únicamente de
> `crearVenta`: acepta `idempotencyKey: string` obligatorio y lo
> persiste tal cual en `sales.idempotency_key` (`@unique` desde la fase
> 01) — `crearVenta` **no** se envuelve a sí mismo con `withIdempotency`
> (no es dueño de su propio `tx`, esa responsabilidad es de quien abre
> la transacción). El mecanismo de punta a punta (índice único +
> `withIdempotency`, ya VERDE desde T0.14) se prueba empíricamente
> contra Postgres real en
> `test/integration/sales-idempotency.integration.spec.ts`, armando
> manualmente `prisma.$transaction(tx => crearVenta(tx, input))`
> envuelto en `withIdempotency` — exactamente lo que hará el futuro
> `SalesController`. Aplicar el `IdempotencyInterceptor`/decorator real
> a una ruta HTTP queda para cuando ese controller se construya
> (T4.10/T4.11), mismo criterio que AMB-14 en T4.3: agregado chico y
> acotado cuando exista el punto real donde conectarlo, no deuda
> técnica.
>
> **Hallazgo técnico (fase 06 de este módulo): `stock.service.ts`
> (`products`/`stock`, ya VERDE) no expone lo que `sales` necesita
> para descontar/revertir stock.** Su propia spec (fase 06 de
> `products`/`variants`) había reservado `descontarPorVenta` y
> `revertirPorAnulacion`, pero nunca se construyeron — la fase 07 de
> ese módulo no lo detectó. No es una ambigüedad de negocio: agregar
> `descontarPorVenta` (tipo `VENTA`, referencia a la venta, sin lock
> propio — lo toma `sales.service` una sola vez por todas las
> variantes) pasa a ser requisito de **T4.1**; `revertirPorAnulacion`,
> de **T4.7**. Ver `state/reports/modulo-sales-spec.md` sección 4.2
> para las firmas exactas.
>
> **Hallazgos técnicos menores (fase 06 de este módulo), incorporados
> a sus tickets sin agregar tickets nuevos:** `total >= 0` no se sigue
> automáticamente de las otras reglas del invariante 4 (un
> `ajuste_redondeo` negativo puede dejarlo en negativo aunque
> `descuento_total` sea válido) — validación explícita + `CHECK` de
> base recomendado, asignado a **T4.6**. `0 ≤ descuento_total ≤
> subtotal` sin `CHECK` de base — asignado a **T4.3**. El chequeo de
> "hay sesión de caja abierta" (paso 1 del flujo, §5.3) no toma lock
> hoy, y el único lock real de la sesión ocurre recién al registrar el
> movimiento de caja — que no se ejecuta si la venta no tiene ningún
> pago en efectivo, dejando una ventana de concurrencia angosta para
> ventas 100% tarjeta. Recomendado que `sales.service` tome ese lock
> siempre, desde el paso 1 — asignado a **T4.1**. Ver
> `state/reports/modulo-sales-spec.md` secciones 3 y 5 para el detalle
> completo de los tres.
>
> **T4.8 construyó más que "solo tests" (2026-08-25):** el título
> ("Tests de invariantes 3, 4, 5 y 7") es engañoso — `BLUEPRINT.md` §6
> exige que las "tres primeras" invariantes (1 `stock`, 2 `cash-registers`,
> 3 `sales`) tengan además "un chequeo de reconciliación ejecutable", no
> solo un test. Mismo patrón de título ya usado dos veces en este roadmap
> para ese propósito exacto: **T2.8** ("Test de reconciliación del
> invariante 1") construyó `StockService.reconciliar()`; **T3.6** ("Test
> del invariante 2") construyó `CashRegisterService.reconciliar()`. T4.8
> sigue el mismo criterio y construye `SalesService.reconciliar()` para
> el invariante 3. Además, siguiendo la recomendación explícita de
> `state/reports/modulo-sales-spec.md` sección 9, se agregaron también
> tests dedicados de los invariantes 12 y 13/15 (no listados en la fila
> de arriba, pero "invariantes que este módulo sí garantiza").

**Cierre:** Fases 07 → 08 → 09 → 10 → 11 → 12.

---

## Etapa 5 — `returns`

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T5.1 | Devolución contra venta existente, con validación de plazo (`dias_plazo_devolucion`), cantidades e idempotencia (§9.7) | T4.4, T0.13, T0.14 | VERDE |
| T5.2 | Reingreso de stock condicional (`reingresa_stock`) | T5.1 | VERDE |
| T5.3 | Reintegro en efectivo → movimiento de caja negativo | T5.1, **T3.2** | PENDIENTE |
| T5.4 | Reversión del costo congelado (para que el CMV quede correcto) | T5.1 | PENDIENTE |
| T5.5 | Cambio: devolución + venta nueva ligadas | T5.3 | PENDIENTE |
| T5.6 | Test del invariante 8 (no devolver más de lo vendido) | T5.1 | PENDIENTE |
| T5.7 | Pantallas de devolución y cambio | T5.5 | PENDIENTE |
| T5.8 | Aplicar crédito de una devolución a una venta posterior (nota de crédito diferida, AMB-16) | T5.5, T5.1 | PENDIENTE |

**Cierre:** Fases 07 → 08 → 09 → 10 → 11 → 12.

> **Hallazgo técnico (Fase 06 de este módulo) + AMB-16 (RESUELTA
> 2026-08-25 — el PO confirmó crédito diferido, no solo atómico):**
> T5.5 (`CAMBIO`) reusa `SalesService.crearVenta` tal cual para crear
> la venta nueva (no reimplementa ninguna regla de venta) — pero
> `CrearVentaPaymentInput` hoy no tiene campo `returnId` en absoluto,
> así que `payments.return_id` nunca se persiste. Con el crédito
> confirmado como diferido, T5.5 construye, dentro de su propia sesión
> (no un ticket aparte, mismo criterio que `sales` extendiendo
> `stock`/`cash-registers` sin ticket separado), el mecanismo
> COMPLETO en `sales.service.ts`/`sales.service.spec.ts`: `returnId?:
> number` opcional en `CrearVentaPaymentInput`; lock de la fila de
> `Return` referenciada (`SELECT ... FOR UPDATE`, mismo patrón
> BLUEPRINT §9.4); validación activa de que el crédito consumido más
> este pago no supera `total_devuelto` (invariante 14); persistencia
> en `payments.create`. Sin romper ningún test existente (campo
> opcional, default `null`, los pasos nuevos solo corren cuando
> `returnId` está presente). **`sales` SÍ valida el invariante 14
> ella misma** (consulta `tx.return`/`tx.payment` directamente, sin
> importar `ReturnsService` — evita una dependencia circular de
> módulos, mismo patrón que `anularVenta` ya usa contra
> `tx.return.findFirst`). Ver `state/reports/modulo-returns-spec.md`
> secciones 4/5 para el detalle completo.
>
> **T5.8 (ticket nuevo)** reusa ese mismo mecanismo desde un punto de
> entrada distinto: `GET /returns/:numero/credito` (nuevo, dueño
> `returns`) + una quinta opción de medio de pago en `CobroPage.tsx`
> (dueño `sales`, ya cerrado en su Fase 12 — extensión aditiva) — sin
> tocar `sales.service.ts` de nuevo, solo el frontend y el nuevo
> endpoint de lectura.
>
> **Sin bloqueos pendientes** — los 8 tickets de la etapa pueden
> arrancar siguiendo el orden de dependencias de la tabla de arriba.

---

## Etapa 6 — `expenses` + `resultados`

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T6.1 | ABM de categorías de gasto (sin "Mercadería" — AD-7) | T1.3 | PENDIENTE |
| T6.2 | Registro de gastos con medio de pago, idempotente (§9.7) | T6.1, T0.14 | PENDIENTE |
| T6.3 | Gasto en efectivo → movimiento de caja vinculado | T6.2, T3.2 | PENDIENTE |
| T6.4 | Consulta de resultados: ingresos, CMV, margen, gastos, resultado neto | T4.4, T5.4, T6.2 | PENDIENTE |
| T6.5 | **Agrupación temporal en hora argentina** (AD-13) + test de venta a las 23:30 | T6.4, T0.7 | PENDIENTE |
| T6.6 | Rankings: productos por unidades vendidas y por margen; gastos por categoría | T6.4 | PENDIENTE |
| T6.7 | Tests de cálculo con casos armados a mano (incluyendo devoluciones) | T6.5 | PENDIENTE |
| T6.8 | Pantallas de gastos y de resultados (solo OWNER) | T6.6 | PENDIENTE |
| T6.9 | Pantalla de configuración (solo OWNER): editar los 4 parámetros de la sección 10 | T0.13, T1.3 | PENDIENTE |

**T6.4 y T6.6 son críticos**: es el número por el que la clienta compra el
sistema. Un cálculo mal hecho la hace tomar decisiones equivocadas sobre su
negocio.

**Cierre:** Fases 07 → 08 → 09 → 10 → 11 → 12.

---

## Etapa 7 — Cierre del MVP

| Fase | Qué | Estado |
|---|---|---|
| 13 | Integration audit | PENDIENTE |
| 14 | E2E realista (flujos completos de `MVP_SCOPE.md` §7) | PENDIENTE |
| 15 | Concurrencia y carga | PENDIENTE |
| 16 | Release Candidate | PENDIENTE |
| 17 | Backup restore drill + `ROLLBACK_PLAN.md` | PENDIENTE |
| 18 | Deploy checklist (autorización humana) | PENDIENTE |
| 19 | Production smoke test | PENDIENTE |

---

## Pendientes con la clienta

Ninguna bloquea el arranque. Se pueden resolver mientras se construyen los
cimientos.

- [x] ~~¿Fía / cuenta corriente?~~ **No fía.** Fuera del MVP (AD-17).
- [x] ~~¿Necesita facturar (AFIP)?~~ **Hoy no.** Reconfirmar con su contador,
      porque las ventas pasadas no se facturan retroactivamente.
- [ ] ¿Le da ticket impreso al cliente? (AMB-9 — aditivo, no bloquea)
- [ ] Umbral de diferencia de caja que obliga a dejar nota. (AMB-10)
- [ ] ¿Se le corta seguido internet en el local?
- [ ] Confirmar las decisiones de la sección 11 del `BLUEPRINT.md`
      (devoluciones, tope de descuento del vendedor, venta sin stock).

## Nota sobre la carga inicial

La clienta **no tiene nada digitalizado** (papel o nada). No hay archivo que
importar: lo que importa es que el alta por grilla (T2.11) sea rápida.

Recomendación operativa: arrancar cargando lo que más vende, no el
inventario completo. Usar el sistema con el 40% cargado es mejor que esperar
tres semanas al 100%.
