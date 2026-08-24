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
| T3.5 | **Sesión olvidada abierta**: detección al entrar y cierre obligatorio | T3.4 | PENDIENTE |
| T3.6 | Test del invariante 2 (arqueo) | T3.4 | PENDIENTE |
| T3.7 | Pantallas de apertura, movimientos y cierre | T3.5 | PENDIENTE |

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
| T4.1 | Servicio de venta transaccional con **bloqueo de filas ordenado por id** (blueprint §9.4), respeta `permitir_venta_sin_stock` | T2.4, T3.2, T0.13 | PENDIENTE |
| T4.2 | Congelado de precio y costo en la línea (AD-5) + `descripcion_snapshot` | T4.1 | PENDIENTE |
| T4.3 | Descuentos: N por venta, límite del vendedor (`max_descuento_vendedor_pct`) y autorización de OWNER | T4.1, T0.13 | PENDIENTE |
| T4.4 | Pagos: N por venta, validación suma = total, impacto en caja solo si es efectivo | T4.1, **T3.2** | PENDIENTE |
| T4.5 | Aplicar el interceptor de idempotencia (T0.14) a la venta | T4.1, T0.14 | PENDIENTE |
| T4.6 | **Ajuste de redondeo** + tests de las reglas de redondeo (§9.3) | T4.4, T0.12 | PENDIENTE |
| T4.7 | Anulación de venta: revierte stock y caja con movimientos nuevos | T4.4, **T3.2** | PENDIENTE |
| T4.8 | Tests de invariantes 3, 4, 5 y 7 | T4.6 | PENDIENTE |
| T4.9 | Test de concurrencia: dos ventas simultáneas de la última unidad | T4.1 | PENDIENTE |
| T4.10 | **Pantalla de venta con teclado y lector** (blueprint §12.1) | T4.5, T4.6 | PENDIENTE |
| T4.11 | Pantalla de cobro: medios de pago, saldo pendiente, vuelto | T4.10 | PENDIENTE |

**T4.10 es el ticket más importante del sistema en experiencia de uso.**
El flujo completo tiene que poder hacerse sin tocar el mouse. Especificación
completa en la sección 12.1 del blueprint.

**Cierre:** Fases 07 → 08 → 09 → 10 → 11 → 12.

---

## Etapa 5 — `returns`

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T5.1 | Devolución contra venta existente, con validación de plazo (`dias_plazo_devolucion`), cantidades e idempotencia (§9.7) | T4.4, T0.13, T0.14 | PENDIENTE |
| T5.2 | Reingreso de stock condicional (`reingresa_stock`) | T5.1 | PENDIENTE |
| T5.3 | Reintegro en efectivo → movimiento de caja negativo | T5.1, **T3.2** | PENDIENTE |
| T5.4 | Reversión del costo congelado (para que el CMV quede correcto) | T5.1 | PENDIENTE |
| T5.5 | Cambio: devolución + venta nueva ligadas | T5.3 | PENDIENTE |
| T5.6 | Test del invariante 8 (no devolver más de lo vendido) | T5.1 | PENDIENTE |
| T5.7 | Pantallas de devolución y cambio | T5.5 | PENDIENTE |

**Cierre:** Fases 07 → 08 → 09 → 10 → 11 → 12.

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
