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
| T0.1 | Bootstrap NestJS + TS estricto + estructura de carpetas + lint + Jest + CI | — | PENDIENTE |
| T0.2 | Prisma + Postgres en docker-compose + config validada con zod + `/health` | T0.1 | PENDIENTE |
| T0.3 | Esquema completo de Prisma (blueprint §3) + primera migración | T0.2 | PENDIENTE |
| T0.4 | Constraints de base de datos + secuencias de numeración + seed | T0.3 | PENDIENTE |
| T0.5 | Frontend Vite + React + **Mantine** + routing + cliente HTTP con cookies + helpers de formato es-AR (§12.3) | T0.1 | PENDIENTE |
| T0.9 | `seed:dev` con datos realistas para desarrollo (nunca en producción) | T0.4 | PENDIENTE |
| T0.10 | **Stryker** (testing de mutación) + umbral de cobertura 80% en servicios, en CI | T0.1 | PENDIENTE |
| T0.6 | Backup diario: GitHub Action con `pg_dump` cifrado a almacenamiento externo | T0.3 | PENDIENTE |
| T0.7 | Zona horaria: helper de agrupación en hora argentina + test (AD-13) | T0.3 | PENDIENTE |
| T0.8 | Helpers de dinero y redondeo + regla de lint que prohíba `number` (AD-14) | T0.1 | PENDIENTE |

> T0.1–T0.4 corresponden a las Fases 00 y 01 del protocolo.
> **T0.6 no se pospone**: sin backup andando, no se carga un solo dato real.

---

## Etapa 1 — `auth`

Todos los módulos dependen de esto.

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T1.1 | Usuarios: hash argon2, alta, baja lógica | T0.4 | PENDIENTE |
| T1.2 | Login + JWT en cookie httpOnly (8 h) + logout | T1.1 | PENDIENTE |
| T1.3 | Guard de autenticación + `RolesGuard` (OWNER / SELLER) | T1.2 | PENDIENTE |
| T1.4 | Pantalla de login + manejo de sesión + rutas protegidas en frontend | T1.3, T0.5 | PENDIENTE |

**Cierre:** Fases 07 → 08 → 09 → 10 → 11 → 12.

---

## Etapa 2 — `products` / `variants` + stock

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T2.1 | ABM de marcas, categorías, **talles y colores** (listas, AD-15) | T1.3 | PENDIENTE |
| T2.2 | ABM de productos | T2.1 | PENDIENTE |
| T2.3 | ABM de variantes (SKU único, barcode único, precio, costo) | T2.2 | PENDIENTE |
| T2.4 | **`stock.service`**: movimientos + contador, transaccional. Único punto que escribe stock | T2.3 | PENDIENTE |
| T2.5 | Ingreso de mercadería con costo → actualiza `costo_actual` + `price_history` | T2.4 | PENDIENTE |
| T2.6 | Ajuste de stock (solo OWNER, motivo obligatorio) | T2.4 | PENDIENTE |
| T2.7 | Buscador unificado: nombre / SKU / código de barras | T2.3 | PENDIENTE |
| T2.8 | Test de reconciliación del invariante 1 (`stock_actual == SUM(movimientos)`) | T2.4 | PENDIENTE |
| T2.9 | **`price_history`**: registro de todo cambio de precio y costo (AD-16) | T2.3 | PENDIENTE |
| T2.10 | **Actualización masiva de precios** con vista previa (blueprint §5.2) | T2.9 | PENDIENTE |
| T2.11 | **Alta de variantes por grilla** (talles × colores, blueprint §12.2) | T2.3 | PENDIENTE |
| T2.12 | Pantallas de catálogo, stock e ingreso de mercadería | T2.5, T2.6, T2.7, T2.11 | PENDIENTE |

**T2.4 es el ticket más delicado de esta etapa.** Blueprint §9.4 y AD-4.
El costo solo lo ve `OWNER`.

**T2.10 y T2.11 no son adornos.** Sin actualización masiva, la clienta vuelve
a la planilla cuando tenga que remarcar. Sin alta por grilla, cargar la
tienda desde cero (hoy no tiene nada digitalizado) es inviable.

**Cierre:** Fases 07 → 08 → 09 → 10 → 11 → 12.

---

## Etapa 3 — `cash-registers`

Va **antes** de ventas: no se puede vender sin caja abierta.

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T3.1 | Apertura de sesión con monto inicial + constraint de sesión única abierta | T1.3 | PENDIENTE |
| T3.2 | Movimientos de caja (servicio base, solo efectivo — AD-8) | T3.1 | PENDIENTE |
| T3.3 | Ingreso manual y retiro de efectivo | T3.2 | PENDIENTE |
| T3.4 | Cierre con arqueo: monto declarado, monto sistema, diferencia y nota | T3.2 | PENDIENTE |
| T3.5 | **Sesión olvidada abierta**: detección al entrar y cierre obligatorio | T3.4 | PENDIENTE |
| T3.6 | Test del invariante 2 (arqueo) | T3.4 | PENDIENTE |
| T3.7 | Pantallas de apertura, movimientos y cierre | T3.5 | PENDIENTE |

**Cierre:** Fases 07 → 08 → 09 → 10 → 11 → 12.

---

## Etapa 4 — `sales`

El módulo más crítico del sistema.

| ID | Objetivo | Depende de | Estado |
|---|---|---|---|
| T4.1 | Servicio de venta transaccional con **bloqueo de filas ordenado por id** (blueprint §9.4) | T2.4, T3.2 | PENDIENTE |
| T4.2 | Congelado de precio y costo en la línea (AD-5) + `descripcion_snapshot` | T4.1 | PENDIENTE |
| T4.3 | Descuentos: N por venta, límite del vendedor y autorización de OWNER | T4.1 | PENDIENTE |
| T4.4 | Pagos: N por venta, validación suma = total, impacto en caja solo si es efectivo | T4.1 | PENDIENTE |
| T4.5 | Idempotencia por `Idempotency-Key` (interceptor común) | T4.1 | PENDIENTE |
| T4.6 | **Ajuste de redondeo** + tests de las reglas de redondeo (§9.3) | T4.4 | PENDIENTE |
| T4.7 | Anulación de venta: revierte stock y caja con movimientos nuevos | T4.4 | PENDIENTE |
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
| T5.1 | Devolución contra venta existente, con validación de plazo y cantidades | T4.4 | PENDIENTE |
| T5.2 | Reingreso de stock condicional (`reingresa_stock`) | T5.1 | PENDIENTE |
| T5.3 | Reintegro en efectivo → movimiento de caja negativo | T5.1 | PENDIENTE |
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
| T6.2 | Registro de gastos con medio de pago | T6.1 | PENDIENTE |
| T6.3 | Gasto en efectivo → movimiento de caja vinculado | T6.2, T3.2 | PENDIENTE |
| T6.4 | Consulta de resultados: ingresos, CMV, margen, gastos, resultado neto | T4.4, T5.4, T6.2 | PENDIENTE |
| T6.5 | **Agrupación temporal en hora argentina** (AD-13) + test de venta a las 23:30 | T6.4 | PENDIENTE |
| T6.6 | Rankings: productos por unidades vendidas y por margen; gastos por categoría | T6.4 | PENDIENTE |
| T6.7 | Tests de cálculo con casos armados a mano (incluyendo devoluciones) | T6.5 | PENDIENTE |
| T6.8 | Pantallas de gastos y de resultados (solo OWNER) | T6.6 | PENDIENTE |

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
