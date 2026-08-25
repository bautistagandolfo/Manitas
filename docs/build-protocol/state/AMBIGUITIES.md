# AMBIGUITIES

Reglas de negocio o comportamientos que no se pueden resolver solo con el
código o la documentación existente. El agente propone una recomendación
razonada para acelerar la decisión, pero **la resuelve el Product Owner**,
no el agente. Ver `docs/build-protocol/03-ambiguity-resolution.md`.

Las ambigüedades marcadas ⚠️ ALTO RIESGO (dinero, stock, auth, datos
irreversibles) no deberían aprobarse en bloque — léelas una por una antes
de aceptar la recomendación. **Un "sí, dale con todas las recomendadas"
sin leerlas es, en la práctica, dejar que decida el agente — que es
justo lo que esta fase existe para evitar.**

Todas provienen de `BLUEPRINT.md` sección 11 (única fuente por ahora: no
corrieron todavía las fases 06 de spec de módulo ni hay construcción en
curso que haya generado ambigüedades propias).

## Tabla de estado

| ID | Riesgo | Ubicación / módulo | Pregunta | Recomendación | Bloquea a | Estado | ¿Coincidió? |
|---|---|---|---|---|---|---|---|
| AMB-1 | BAJO | `layaways` (fuera de alcance) | ¿Señas / apartados en el MVP? | Ya confirmado: fuera del MVP | ninguno | RESUELTA | — |
| AMB-2 | ⚠️ ALTO | `returns` | Política de devolución | Confirmar el default del blueprint | Etapa 5 completa (T5.1–T5.7), Fase 06 de `returns` | RESUELTA | Sí |
| AMB-3 | ⚠️ ALTO | `sales` | Tope de descuento del vendedor | Confirmar 10% + autorización OWNER | T4.3, Fase 06 de `sales` | RESUELTA | Sí |
| AMB-4 | ⚠️ ALTO | `sales` / `products` | ¿Vender sin stock? | Confirmar bloqueado por defecto, activable | T4.1, Fase 06 de `sales` | RESUELTA | Sí |
| AMB-5 | ⚠️ ALTO | `cash-registers` | Diferencia en cierre de caja | Confirmar: no bloquea, exige nota si supera umbral | T3.4, Fase 06 de `cash-registers` | RESUELTA | Sí |
| AMB-6 | ⚠️ ALTO | `products` / `variants` | Método de costeo | Confirmar último costo (AD-6) | ninguno nuevo — ya implementado en el schema | RESUELTA | Sí (confirmado explícito, no en bloque) |
| AMB-7 | ⚠️ ALTO | Alcance general / legal | Facturación fiscal (AFIP) | Ya confirmado para el MVP; falta reconfirmar con contador | Fase 18 (deploy checklist) | RESUELTA (con caveat) | — |
| AMB-8 | BAJO | `customers` (fuera de alcance) | ¿Cuenta corriente / fiado? | Ya confirmado: no fía | ninguno | RESUELTA | — |
| AMB-9 | MEDIO | `sales` (impresión) | ¿Ticket impreso? | Diferir: no soportar impresora térmica en el MVP | ninguno (aditivo, no bloquea el arranque) | RESUELTA (diferida) | Sí |
| AMB-10 | ⚠️ ALTO | `cash-registers` / `settings` | Umbral de diferencia de caja | Sin recomendación por defecto — necesita un número real | T0.13 (seed de `settings`), T3.4, Fase 06 de `cash-registers` | RESUELTA — **$500** (monto fijo, no %) | No había recomendación |
| AMB-11 | ⚠️ ALTO | `products` / `variants` | ¿`SELLER` puede editar `precioVenta` manual, cargar costo en la grilla, o hacer ingreso de mercadería? | `OWNER`-only para las tres | Etapa 2 completa (T2.3, T2.5, T2.11), Fase 06 de `products`/`variants` | RESUELTA — `OWNER`-only las tres | Sí |
| AMB-12 | MEDIO | `products` / `variants` (carga inicial) | Formato de columnas del CSV de importación | Plantilla propia, ajustable si B4 revela un formato existente | T2.13 (nuevo) | RESUELTA — plantilla propia | Sí |
| AMB-13 | ⚠️ ALTO | `cash-registers` | ¿`SELLER` puede hacer ingreso manual o retiro de efectivo? | `OWNER`-only para ambas | T3.3, Fase 06 de `cash-registers` | RESUELTA — `OWNER`-only las dos | Sí |
| AMB-14 | ⚠️ ALTO | `sales` | Mecanismo de autorización de `OWNER` para un descuento por encima del tope, en el momento de la venta | Campo de contraseña de `OWNER` en el formulario, verificado por el backend sin cambiar la sesión activa | T4.3, Fase 06 de `sales` | PENDIENTE | — |

---

## AMB-1 — ¿Señas / apartados?

**Ubicación:** módulo `layaways`, fuera de alcance del MVP.

**Descripción:** el blueprint deja previsto un punto de extensión para
señas (reserva de stock + pago parcial), pero no lo construye ahora.

**Por qué no se resuelve solo con el código:** es una decisión de alcance
comercial, no técnica.

**Estado: RESUELTA.** `MVP_SCOPE.md` §4 y `BLUEPRINT.md` AMB-1 ya lo marcan
"Confirmado. Fuera del MVP." No requiere una nueva pregunta al PO.

---

## AMB-2 — Política de devolución ⚠️ ALTO RIESGO

**Ubicación:** módulo `returns` (BLUEPRINT §3.5, §5.4, invariante 8).

**Descripción:** el blueprint propone una política completa por defecto,
pero el propio documento aclara en la cabecera de la sección 11 que estas
decisiones "están tomadas por defecto, no confirmadas" con la clienta real.

**Por qué no se resuelve solo con el código:** son reglas de negocio de la
tienda (plazo, forma de reintegro, qué hacer con mercadería fallada), no
algo que se derive de la arquitectura.

**Pregunta para el PO** (responder cada punto):

1. ¿El plazo para aceptar una devolución es siempre **30 días**, o varía?
   (el sistema lo deja configurable — `dias_plazo_devolucion` — así que
   cualquier número sirve, la pregunta es cuál poner por defecto)
2. ¿El reintegro es **siempre en efectivo**, incluso si la venta original
   se cobró con tarjeta? (el blueprint lo asume así — AMB-2 original)
3. ¿Debe poder aceptarse una devolución **fuera de plazo** con autorización
   de `OWNER`, o el plazo es un límite duro sin excepciones?

**RECOMENDACIÓN:** confirmar el default del blueprint tal cual — 30 días
configurable, reintegro siempre en efectivo, y sí permitir excepción fuera
de plazo con autorización de `OWNER` (el modelo ya tiene
`autorizado_por_user_id` en `returns` para esto exacto). Es la práctica más
común en indumentaria y ya está modelada en el schema.

**RIESGO DE LA RECOMENDACIÓN:** si la tienda en la práctica reintegra con
el mismo medio que se cobró (por ejemplo, nota de crédito para tarjeta en
vez de efectivo), aprobar esto tal cual generaría **movimientos de caja
incorrectos** — el "reintegro en efectivo" mueve el cajón aunque la venta
original no haya sido en efectivo.

**Bloquea a:** toda la Etapa 5 (`returns`: T5.1–T5.7) y su Fase 06.

**Resolución (Paso 2):** RESUELTA. El PO aprobó la recomendación: 30 días
configurable, reintegro siempre en efectivo, excepción fuera de plazo con
autorización de `OWNER`. Etapa 5 desbloqueada.

---

## AMB-3 — Tope de descuento del vendedor ⚠️ ALTO RIESGO

**Ubicación:** módulo `sales` (BLUEPRINT §3.4 `sale_discounts`, §5.3, AMB-3).

**Descripción:** el blueprint propone 10% como tope que un `SELLER` puede
aplicar sin autorización, configurable vía `max_descuento_vendedor_pct`.

**Por qué no se resuelve solo con el código:** es una política comercial
de la dueña sobre cuánto margen delega en el personal de venta.

**Pregunta para el PO:** ¿el tope sin autorización es **10%**, otro
número, o no debería haber descuentos sin autorización de `OWNER` en
absoluto (tope 0%)?

**RECOMENDACIÓN:** confirmar 10% como default de `max_descuento_vendedor_pct`
(configurable, se puede cambiar después sin tocar código). Es el punto
medio estándar del rubro entre "no delega nada" y "delega demasiado".

**RIESGO DE LA RECOMENDACIÓN:** si el margen real de la tienda es más
ajustado que el promedio del rubro, un 10% delegado a cada vendedor sin
supervisión puede erosionar el margen sin que la dueña se entere hasta el
cierre de resultados (Etapa 6).

**Bloquea a:** T4.3 (`sales`) y su Fase 06.

**Resolución (Paso 2):** RESUELTA. El PO aprobó la recomendación: 10% como
default de `max_descuento_vendedor_pct`. T4.3 desbloqueado.

---

## AMB-4 — ¿Vender sin stock? ⚠️ ALTO RIESGO

**Ubicación:** módulos `sales` / `products` (BLUEPRINT invariante 5, AMB-4).

**Descripción:** el blueprint propone bloquear la venta cuando no hay
stock, con una bandera `permitir_venta_sin_stock` para desactivarlo.

**Por qué no se resuelve solo con el código:** depende de si la tienda
maneja stock justo (donde vender de más es un problema real de
cumplimiento) o si prefiere nunca perder una venta en el mostrador.

**Pregunta para el PO:** ¿el sistema **bloquea** la venta si no hay stock
suficiente (default), o la **permite** dejando el `stock_actual` en
negativo?

**RECOMENDACIÓN:** bloquear por defecto (`permitir_venta_sin_stock = false`).
Vender algo que después no se puede entregar es un problema peor que
perder la venta en el momento — y queda configurable si la dueña prefiere
lo contrario.

**RIESGO DE LA RECOMENDACIÓN:** si en la práctica el conteo de stock no es
100% confiable al principio (típico en la carga inicial, ver nota de
`ROADMAP.md`), bloquear ventas por un stock mal cargado frena ventas
reales en el mostrador — riesgo operativo, no solo de datos.

**Bloquea a:** T4.1 (`sales`) y su Fase 06.

**Resolución (Paso 2):** RESUELTA. El PO aprobó la recomendación: bloqueado
por defecto (`permitir_venta_sin_stock = false`), configurable. T4.1
desbloqueado.

---

## AMB-5 — Diferencia en el cierre de caja ⚠️ ALTO RIESGO

**Ubicación:** módulo `cash-registers` (BLUEPRINT §3.6, invariante 2, AMB-5).

**Descripción:** el blueprint propone que una diferencia entre lo contado
y lo que dice el sistema **no impida cerrar la caja**, pero exija una nota
si supera un umbral (ver AMB-10, el número en sí).

**Por qué no se resuelve solo con el código:** es una decisión operativa
sobre qué tan estricto es el proceso de cierre diario.

**Pregunta para el PO:** cuando hay una diferencia en el arqueo, ¿el
sistema **permite cerrar igual** dejando la diferencia registrada
(recomendado), o debería **bloquear el cierre** hasta que alguien lo
resuelva?

**RECOMENDACIÓN:** no bloquear. Un cierre de caja que no se puede cerrar
nunca es peor que uno con una diferencia registrada y explicada — la
dueña necesita el dato, no un sistema trabado a las 21:00.

**RIESGO DE LA RECOMENDACIÓN:** si no bloquea, un vendedor deshonesto
podría cerrar con una diferencia grande sistemáticamente sin que nadie lo
note hasta que alguien revise los cierres — la mitigación es la nota
obligatoria (AMB-10) y que solo la vea `OWNER`, pero no hay bloqueo duro.

**Bloquea a:** T3.4 (`cash-registers`) y su Fase 06. Relacionada con AMB-10.

**Resolución (Paso 2):** RESUELTA. El PO aprobó la recomendación: no
bloquea el cierre, exige nota si supera el umbral (ver AMB-10 para el
número). T3.4 desbloqueado en este punto.

---

## AMB-6 — Método de costeo ⚠️ ALTO RIESGO

**Ubicación:** módulos `products` / `variants` (BLUEPRINT AD-6, AMB-6).

**Descripción:** el blueprint ya tomó esta decisión a nivel arquitectura
(AD-6, "está tomada: cambiarla implica revisar el blueprint, no
improvisar en un ticket") — último costo, no promedio ponderado.

**Por qué no se resuelve solo con el código:** aunque la decisión técnica
ya está tomada, es una decisión de negocio (cómo se calcula el margen) y
el blueprint pide confirmarla con la clienta antes de construir el módulo.

**Pregunta para el PO:** cuando compran el mismo artículo a precios
distintos en momentos distintos, ¿el costo para calcular el margen es
**el último precio de compra** (recomendado, ya implementado), o
necesitan el **promedio ponderado** de todas las compras?

**RECOMENDACIÓN:** confirmar último costo. Es más simple de entender para
la dueña ("cuánto pagué la última vez"), y el promedio ponderado ya está
previsto como extensión futura (BLUEPRINT §8.6) sin rehacer el modelo
actual.

**RIESGO DE LA RECOMENDACIÓN:** ⚠️ el `costo_actual` de `variants` es un
campo único, no una estructura que promedie compras — **si el PO
responde que necesita promedio ponderado, no es un ajuste de config: es
una reapertura de la Fase 01** (modelo de datos) para modelar el costeo
distinto. Cuanto más tarde se confirme, más caro sale cambiarlo.

**Bloquea a:** ningún ticket nuevo (ya implementado en `schema.prisma`
como último costo). Si la respuesta es "promedio ponderado", bloquea toda
la Etapa 2 y reabre la Fase 01.

**Resolución (Paso 2):** RESUELTA. Confirmado explícitamente (pregunta
aparte, no en bloque con el resto): **último costo**, tal como ya está
implementado. No se reabre la Fase 01.

---

## AMB-7 — Facturación fiscal (AFIP)

**Ubicación:** alcance general / riesgo legal-impositivo (BLUEPRINT AD-11,
AMB-7).

**Descripción:** el sistema no emite comprobantes fiscales en el MVP.
Blueprint ya lo marca "Confirmado: hoy no la necesita", pero agrega
"Reconfirmar con su contador, porque las ventas pasadas no se facturan
retroactivamente."

**Estado: RESUELTA para el alcance del MVP** — no se construye
facturación electrónica ahora (§8.7 la deja como extensión futura).

**Caveat que queda abierto (no bloquea código, sí bloquea el deploy a
producción):** la reconfirmación con el contador de la clienta. Si la
respuesta cambia después de cargar ventas reales, esas ventas **no se
pueden facturar retroactivamente** — es información que se pierde, no un
bug que se arregla con una migración.

**RIESGO:** ⚠️ ALTO si se omite la reconfirmación. Recomiendo que la Fase
18 (deploy checklist) no autorice producción sin una confirmación
explícita y fechada del contador, aunque para construir el MVP esto no
bloquea nada.

**Bloquea a:** ningún ticket de construcción. Sí debería bloquear la Fase
18 (deploy checklist) sin la reconfirmación del contador.

---

## AMB-8 — ¿Cuenta corriente / fiado?

**Ubicación:** módulo `customers`, fuera de alcance del MVP (BLUEPRINT
AD-17, AMB-8).

**Descripción:** confirmar que la tienda no vende fiado.

**Estado: RESUELTA.** `MVP_SCOPE.md` §4 y `BLUEPRINT.md` AMB-8 ya lo
marcan "Confirmado: no fía." No requiere una nueva pregunta al PO.

---

## AMB-9 — ¿Ticket impreso?

**Ubicación:** módulo `sales`, capa de presentación (BLUEPRINT AMB-9).

**Descripción:** no está definido si la venta se cierra con un ticket
impreso para la clienta final. Si la respuesta es sí, hace falta soportar
una impresora térmica — una integración de hardware que el MVP no
contempla hoy.

**Por qué no se resuelve solo con el código:** depende de si la tienda
usa o piensa usar impresora térmica en el mostrador, algo que el blueprint
no puede saber.

**Pregunta para el PO:** ¿la clienta necesita imprimir un ticket físico en
cada venta, o alcanza con la pantalla (y eventualmente poder ver/reimprimir
una venta pasada)?

**RECOMENDACIÓN:** diferir. No construir soporte de impresora térmica en
el MVP — es aditivo y no bloquea el criterio de entrega de
`MVP_SCOPE.md` §7. Si la respuesta es "sí, la necesito", se agrega como
ticket nuevo sin tocar el resto del sistema (la venta ya tiene todos los
datos que un ticket necesitaría).

**RIESGO DE LA RECOMENDACIÓN:** riesgo bajo — es aditivo por diseño. El
único costo de diferir es que, si la respuesta termina siendo "sí, la
necesito desde el día uno", el H2 (primera entrega real, ver
`ROADMAP.md`) no seria utilizable en el mostrador sin ese ticket impreso.

**Bloquea a:** ningún ticket del MVP definido en `ROADMAP.md`.

**Resolución (Paso 2):** RESUELTA (diferida). El PO aprobó diferir: no se
construye soporte de impresora térmica en el MVP.

---

## AMB-10 — Umbral de diferencia de caja ⚠️ ALTO RIESGO

**Ubicación:** módulo `cash-registers` / tabla `settings` (BLUEPRINT §10,
AMB-10).

**Descripción:** el blueprint deja el parámetro `umbral_diferencia_caja`
explícitamente como **"a definir con ella"** — a diferencia de las demás
ambigüedades, acá no hay ni siquiera un default razonable propuesto.

**Por qué no se resuelve solo con el código:** no es una decisión de
diseño con un estándar del rubro claro — depende de cuánto margen de
error en el conteo manual de efectivo la dueña considera "normal" en su
propio local.

**Pregunta para el PO:** ¿a partir de qué monto de diferencia entre lo
contado y lo que dice el sistema el cierre de caja debería exigir una
nota explicando qué pasó? (por ejemplo: $500, $1.000, un % del monto
inicial — la respuesta puede ser cualquier número o regla que prefiera).

**RECOMENDACIÓN:** sin recomendación por defecto — es la única ambigüedad
del blueprint sin un valor propuesto, y proponer un número a ciegas sin
conocer el volumen de venta diario real de la tienda sería inventar un
dato, exactamente lo que esta fase existe para evitar.

**RIESGO DE LA RECOMENDACIÓN:** no aplica (no hay recomendación). El
riesgo de **no** resolver esto es que T3.4 no se puede dar por terminado
sin un valor real para sembrar en `settings` (T0.13).

**Bloquea a:** T0.13 (valor de seed de `settings`), T3.4
(`cash-registers`) y su Fase 06. Relacionada con AMB-5.

**Resolución (Paso 2):** RESUELTA. El PO definió **$500**: cualquier
diferencia de $500 o más (a favor o en contra) exige nota al cerrar la
caja. Es un monto fijo, no un porcentaje — así que `settings.tipo` para
`umbral_diferencia_caja` es `DECIMAL` con valor `500.00`. T0.13 y T3.4
desbloqueados.

---

## AMB-11 — ¿`SELLER` puede tocar precio/costo en `products`/`variants`? ⚠️ ALTO RIESGO

**Ubicación:** módulo `products`/`variants` (BLUEPRINT §5.2;
`state/reports/modulo-products-variants-spec.md`, sección 8 y 10).

**Descripción:** el blueprint dice explícitamente que **el costo**
(`costo_actual`, `costo_unitario`, historial de costos) es exclusivo
de `OWNER` (§5.2, literal). No dice nada sobre tres cosas relacionadas
que aparecieron al especificar el módulo:

1. ¿`SELLER` puede editar `precio_venta` **manualmente**, variante por
   variante (fuera de la actualización masiva, que ya es `OWNER`-only
   por RN-9/A5)?
2. Al cargar una grilla de alta (T2.11), la tabla tiene una columna de
   costo por variante — ¿`SELLER` puede completarla, o queda
   deshabilitada/oculta para ese rol?
3. El ingreso de mercadería (T2.5) **siempre** requiere `costoUnitario`
   — ¿puede un `SELLER` hacerlo, o es también `OWNER`-only?

**Por qué no se resuelve solo con el código:** es una decisión sobre
cuánto delega la dueña en el personal de venta respecto de precios y
costos — la misma clase de decisión que AMB-3 (tope de descuento), no
algo que se derive de la arquitectura.

**Pregunta para el PO:** de las tres acciones de arriba, ¿cuáles puede
hacer un `SELLER` y cuáles son exclusivas de `OWNER`?

**RECOMENDACIÓN:** las tres, `OWNER`-only. Es más simple explicar una
sola regla ("todo lo que decide cuánto cuesta o cuánto vale algo es
del dueño") que separar precio de costo en la práctica diaria de un
local chico, y es consistente con que el resto de las operaciones
"con plata de por medio" del módulo (ajuste de stock, actualización
masiva) ya son `OWNER`-only en el blueprint.

**RIESGO DE LA RECOMENDACIÓN:** si en la práctica la dueña necesita
que sus vendedoras puedan recibir mercadería del proveedor (ingreso)
sin que ella esté presente —típico si no está todos los días en el
local—, esta recomendación se lo impide y puede generar fricción
operativa real (mercadería que llega y no se puede cargar hasta que
vuelva el `OWNER`).

**Bloquea a:** T2.3, T2.5, T2.11 y el resto del cierre de la Etapa 2
(Fases 07→12 de `products`/`variants`) — los guards de esos endpoints
dependen de esta respuesta.

**Resolución:** RESUELTA. El PO aprobó la recomendación tal cual:
`OWNER`-only para las tres — editar `precioVenta` manualmente, completar
la columna de costo en la grilla de alta, y el ingreso de mercadería.
T2.3, T2.5 y T2.11 desbloqueados.

---

## AMB-12 — Formato de columnas del CSV de importación

**Ubicación:** módulo `products`/`variants`, carga inicial
(`DECISIONES_PENDIENTES.md` C2; `state/reports/modulo-products-variants-spec.md`,
sección 10-11).

**Descripción:** C2 ya decidió que la importación por CSV **es un
ticket** ("no un extra") — lo que falta es el formato exacto de
columnas. Depende de B4 (`DECISIONES_PENDIENTES.md`, "¿con qué maneja
hoy el catálogo y el stock?"), todavía sin responder.

**Por qué no se resuelve solo con el código:** si la clienta ya lleva
una planilla propia con sus propias columnas, forzarla a adaptarse a
un formato inventado por el sistema anula el propósito del ticket
("sin esto el lanzamiento se cae por agotamiento").

**Pregunta para el PO:** ¿la clienta ya usa alguna planilla/Excel para
su catálogo o stock hoy? Si es así, ¿cuáles son sus columnas?

**RECOMENDACIÓN:** no esperar la respuesta para arrancar T2.13 —
definir una plantilla propia razonable (nombre, marca, categoría,
talle, color, SKU, barcode, precio, costo, stock inicial) que se le
entrega a la clienta para completar, con validación y reporte de
errores línea por línea. Si B4 revela un formato existente, se ajusta
el mapeo de columnas del importador — cambio acotado, no reapertura
del ticket.

**RIESGO DE LA RECOMENDACIÓN:** si la clienta tiene cientos de filas
ya cargadas en su propio formato, pedirle que las pase a mano a la
plantilla del sistema puede ser tan lento como cargarlas una por una
en la grilla — el ahorro de tiempo que motiva el ticket se pierde en
la práctica si el mapeo no se ajusta rápido después de conocer B4.

**Bloquea a:** T2.13 únicamente. No bloquea T2.1–T2.12.

**RESUELTA (2026-08-23):** el PO aprobó la recomendación — plantilla
propia (nombre, marca, categoría, talle, color, SKU, barcode, precio,
costo, stock inicial), sin esperar B4. Si B4 revela un formato
existente más adelante, se ajusta el mapeo de columnas del importador
como cambio acotado, no como reapertura del ticket. **T2.13
desbloqueado.**

---

## AMB-13 — ¿`SELLER` puede hacer ingreso manual o retiro de efectivo? ⚠️ ALTO RIESGO

**Ubicación:** módulo `cash-registers` (BLUEPRINT §5.5, §3.6;
`state/reports/modulo-cash-registers-spec.md`, secciones 8 y 10).

**Descripción:** el blueprint es explícito sobre quién puede *abrir*
una sesión (cualquiera — necesario para que una vendedora sola pueda
arrancar el día) y quién puede *cerrarla* ("cierre a ciegas": cualquiera
declara el efectivo contado, pero solo `OWNER` ve `monto_sistema` y
`diferencia`, §5.5). No dice una palabra sobre quién puede hacer un
`INGRESO_MANUAL` o un `RETIRO` — los dos tipos de movimiento de caja
que no vienen de una venta/devolución/gasto, sino que alguien los carga
a mano, sin ningún ítem ni comprobante detrás que los explique.

**Por qué no se resuelve solo con el código:** a diferencia de
`products`/`variants` (AMB-11), acá no hay ningún texto en el blueprint
que sugiera que es una tarea típica de `SELLER` (como sí lo es cargar
catálogo) — y un `RETIRO` es, literalmente, sacar plata del cajón sin
que ninguna otra regla del sistema lo valide contra un ticket o una
cantidad esperada. Es la operación de mayor riesgo de mal uso —error u
otra cosa— de todo el módulo.

**Pregunta para el PO:** ¿un `SELLER` puede registrar un ingreso manual
o un retiro de efectivo por su cuenta, o son exclusivos de `OWNER`?

**RECOMENDACIÓN:** `OWNER`-only para las dos. Es consistente con que el
resto de las acciones "con plata de por medio y sin comprobante
automático detrás" del sistema (ajuste de stock con motivo, ingreso de
mercadería, edición de precio/costo) ya son `OWNER`-only por decisión
explícita del blueprint o por AMB-11. La apertura y el cierre quedan
abiertos a cualquiera porque el blueprint mismo lo exige para que el
local pueda operar sin que la dueña esté físicamente presente todos los
días — pero un ingreso/retiro no tiene esa misma necesidad operativa
tan clara: no bloquea la posibilidad de vender.

**RIESGO DE LA RECOMENDACIÓN:** si en la práctica la dueña no está
presente todo el día y necesita que su vendedora pueda, por ejemplo,
sacar cambio del cajón para ir a comprar algo puntual, esta
recomendación se lo impide y puede generar la misma fricción operativa
que ya se señaló en AMB-11 para el ingreso de mercadería.

**Bloquea a:** T3.3 y su Fase 06 (`cash-registers`) — el guard de esos
dos endpoints depende de esta respuesta.

**Resolución (2026-08-24):** RESUELTA. El PO aprobó la recomendación:
`OWNER`-only para `INGRESO_MANUAL` y `RETIRO`. **T3.3 desbloqueado.**

## AMB-14 — Mecanismo de autorización de `OWNER` para un descuento por encima del tope ⚠️ ALTO RIESGO

**Ubicación:** módulo `sales` (BLUEPRINT §5.3, AMB-3;
`state/reports/modulo-sales-spec.md`, secciones 4.1, 8 y 10).

**Descripción:** AMB-3 ya confirmó el **número** — hasta 10%
(`max_descuento_vendedor_pct`) lo aplica cualquier vendedor, por
encima requiere autorización de un `OWNER`, registrada en
`sale_discounts.autorizado_por_user_id`. Lo que el blueprint nunca
especifica es **cómo** ocurre esa autorización en el momento real de
la venta: quien está cobrando en el mostrador es la `SELLER`, logueada
con su propia sesión — no hay una sesión de `OWNER` activa a la que
"pedirle permiso" con un clic.

**Por qué no se resuelve solo con el código:** es una decisión de
producto sobre el flujo físico del mostrador, no una regla derivable
del modelo de datos. La columna `autorizado_por_user_id` ya existe
(fase 01) y acepta cualquier `user_id` de un `OWNER` — pero *cómo* se
llena ese campo de forma segura (sin que una `SELLER` pueda mandar el
id de un `OWNER` real sin que ese `OWNER` haya hecho nada) es
enteramente una decisión de UX + seguridad que el blueprint no toma.

**Pregunta para el PO:** cuando una vendedora necesita aplicar un
descuento mayor al 10%, ¿cómo se espera que la dueña lo autorice en el
momento? Opciones típicas de punto de venta:

1. **Contraseña de supervisor:** un campo de contraseña aparece en el
   formulario de descuento; la vendedora le pide a la dueña que la
   tipee ahí mismo (sin cerrar la sesión de la vendedora). El backend
   verifica esa contraseña contra un usuario `OWNER` real (mismo
   mecanismo de hash que el login, sin emitir un JWT nuevo ni cambiar
   la cookie de sesión activa) y, si coincide, completa
   `autorizado_por_user_id` con el id de ese `OWNER`.
2. **La dueña hace el descuento ella misma:** la vendedora le pasa el
   mostrador o pide que la dueña se loguee un momento en esa
   estación. Sin desarrollo extra, pero interrumpe la venta y no
   funciona si la dueña no está físicamente presente.
3. **Aprobación asincrónica:** la venta queda en un estado
   "pendiente de autorización" y la dueña la aprueba después, desde su
   propio dispositivo. Mucho más desarrollo (estado nuevo, notificación,
   pantalla de aprobación) para un caso que en una tienda chica es
   probablemente raro.

**RECOMENDACIÓN:** opción 1 (contraseña de supervisor). Es el patrón
estándar de la industria retail para este problema exacto, no agrega
un estado nuevo a la venta (sigue siendo una operación atómica de un
solo paso), y no depende de que la dueña esté físicamente disponible
para loguearse — solo de que sepa su contraseña, que ya tiene que
saber para todo lo demás del sistema.

**RIESGO DE LA RECOMENDACIÓN:** requiere que el backend exponga un
mecanismo de verificación de contraseña que no es un login completo
(no emite cookie, no cambia `req.user`) — una superficie nueva, chica
pero real, que la fase 09 de este módulo va a tener que auditar con
cuidado (por ejemplo, que no sea vulnerable a fuerza bruta sin rate
limiting, ya que a diferencia de `/auth/login` hoy no tiene uno).

**Bloquea a:** T4.3 y la parte de la Fase 06 de `sales` que depende de
esta respuesta — el resto del módulo (T4.1, T4.2, T4.4–T4.11) no.
