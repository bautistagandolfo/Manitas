# BLUEPRINT — Sistema de gestión para tienda de indumentaria

Plano técnico del MVP. De este documento salen los tickets de desarrollo.
Complementa a `MVP_SCOPE.md` (qué se construye) explicando **cómo** se
construye.

> **Nota sobre el stack:** este blueprint define modelo de datos, reglas de
> negocio, invariantes y responsabilidades de cada capa — todo eso es válido
> sin importar el stack. La sección 9 (estructura de carpetas, ORM,
> librerías) queda pendiente de que confirmes backend, base de datos y
> frontend.

---

## 1. El problema real

La dueña de la tienda no quiere un sistema de ventas. Quiere **saber si gana
plata y cuánto**. El punto de venta es el medio para capturar los datos que
responden esa pregunta.

Eso ordena todas las prioridades del diseño: si hay que elegir entre una
funcionalidad linda de venta y la precisión del cálculo de resultado, gana
el resultado.

**Las tres preguntas que el sistema tiene que responder bien:**

1. ¿Cuánto entró y cuánto salió de plata? (caja)
2. ¿Qué tengo y qué se vendió? (stock)
3. ¿Estoy ganando o perdiendo, y cuánto? (resultados)

---

## 2. Decisiones de arquitectura

Cada una con su motivo y su costo. Están tomadas: cambiarlas implica
revisar este documento, no improvisar en un ticket.

### AD-1 — Una instancia por cliente, sin multi-tenant

Cada tienda cliente tiene su propio deploy y su propia base de datos.

**Motivo:** el aislamiento multi-tenant es crítico en seguridad (una falla
expone los datos de un cliente a otro) y no se necesita hasta tener varios
clientes reales.

**Costo:** operar N instancias (deploys, backups, monitoreo). Aceptable
hasta ~10-15 clientes.

### AD-2 — Un solo local, sin `store_id`

El modelo no contempla sucursales.

**Motivo:** agregar una dimensión a un modelo de stock basado en movimientos
es una migración mecánica de relleno, no una reescritura. No justifica pagar
complejidad hoy.

### AD-3 — La venta: N ítems, N descuentos, N pagos

Una venta tiene una **lista** de pagos y una **lista** de descuentos, aunque
en el MVP haya un solo pago y a lo sumo un descuento manual.

**Motivo:** gift cards son un método de pago más; los códigos de descuento
son un descuento más; las señas son pagos parciales. Con esta forma se
agregan sin tocar la venta. Con la forma ingenua (`metodo_pago` + `monto` en
la venta) hay que rehacer el núcleo y el histórico viejo no se puede migrar,
porque no se sabe cómo se dividió una venta pasada.

### AD-4 — El stock: libro de movimientos + contador denormalizado

Todo cambio de stock escribe un registro en `stock_movements`. Además, cada
variante mantiene `stock_actual` como contador, actualizado **en la misma
transacción** que el movimiento.

**Motivo:** el libro de movimientos permite auditar y reconstruir; el
contador permite vender rápido sin sumar el histórico en cada consulta.

**Invariante:** `stock_actual == SUM(stock_movements.delta)`. Debe existir
un chequeo de reconciliación que lo verifique (ver sección 6).

### AD-5 — Los costos se congelan en la línea de venta

Al vender, `sale_items` guarda una copia del costo y del precio de ese
momento. No se referencia el costo actual de la variante.

**Motivo:** si se guardara solo la referencia, cambiar el costo de reposición
recalcularía todos los márgenes históricos y los números del mes pasado
dejarían de ser ciertos.

### AD-6 — Costeo por último costo

`variants.costo_actual` se actualiza con cada ingreso de mercadería. Es ese
valor el que se congela al vender.

**Motivo:** es el método más simple de implementar y de explicar a la dueña.

**Límite conocido:** si el mismo artículo se compró a precios muy distintos,
el margen queda distorsionado. El costo promedio ponderado es más preciso y
está previsto como extensión (ver 8.6).

### AD-7 — La compra de mercadería NO es un gasto

Comprar stock es inversión en inventario, no gasto del período. El costo
impacta el resultado **cuando se vende**, vía el costo congelado en la línea.

**Motivo:** contarlo como gasto al comprar y además como costo al vender
duplica el costo y da un resultado falso. Es el error más común en sistemas
caseros de gestión.

### AD-8 — Solo los pagos en efectivo mueven la caja

Un cobro con tarjeta o transferencia registra un pago en la venta, pero
**no** genera movimiento de caja: esa plata no entra al cajón.

**Motivo:** si todo cobro moviera la caja, el arqueo nunca cerraría contra
el efectivo real.

### AD-9 — La lógica de negocio vive en servicios, no en controllers ni UI

Los controllers validan la forma del request y delegan. Toda regla,
transacción e invariante vive en la capa de servicios.

**Motivo:** es lo que permite que una futura integración de e-commerce
llame a los mismos servicios en vez de reimplementar las reglas por su
cuenta y desincronizar el stock.

### AD-10 — Operaciones de escritura idempotentes

Crear una venta, una devolución o un movimiento de caja acepta una **clave
de idempotencia** del cliente. Repetir la operación con la misma clave
devuelve el resultado original en vez de duplicar.

**Motivo:** doble click en el mostrador, reintento por conexión lenta, y a
futuro webhooks de e-commerce que se disparan dos veces.

### AD-11 — Sin facturación fiscal (AFIP) en el MVP

El sistema registra ventas internas. **No emite comprobantes fiscales.**

**Motivo:** la facturación electrónica es un proyecto propio, con
certificados, homologación y modos de contingencia.

**Riesgo declarado:** según la situación fiscal de la clienta, puede
necesitar facturar legalmente. Hay que confirmarlo con ella antes de
entregar. Está previsto como extensión (ver 8.7).

### AD-12 — Nube, sin operación offline

La aplicación corre en la nube y requiere conexión para vender.

**Riesgo declarado:** si se corta internet en el local, no se puede cobrar.
Aceptado conscientemente. Resolverlo (venta offline + sincronización) es un
proyecto propio, no un ajuste.

### AD-13 — Zona horaria: toda agrupación temporal en hora argentina

Los timestamps se guardan en UTC, pero **toda** agrupación por día, mes o
período se calcula en `America/Argentina/Buenos_Aires`
(`fecha AT TIME ZONE 'America/Argentina/Buenos_Aires'`).

**Motivo:** sin esto, una venta de las 22:00 cae en el día siguiente en UTC.
Los totales diarios quedarían mal todas las noches y el reporte pelearía con
el cierre de caja. Es un error silencioso: nadie lo nota hasta que los
números no cierran.

### AD-14 — Redondeo comercial a 2 decimales

- Todo importe se redondea a **2 decimales**, medio hacia arriba.
- El descuento porcentual **se calcula y se redondea antes** de restarse, de
  modo que `subtotal − descuento_total` cierre exacto.
- La venta admite un **ajuste de redondeo** explícito (`ajuste_redondeo`,
  puede ser positivo o negativo) para cuando en el mostrador se cobra la
  cifra redondeada.

**Motivo:** un 15% sobre $2.999 da $449,85 y el total $2.549,15. Si se
cobran $2.549 sin un ajuste explícito, la suma de pagos deja de igualar al
total y el sistema rechaza una venta perfectamente normal.

### AD-15 — Talles y colores desde listas administrables

`talle` y `color` son referencias a tablas propias, no texto libre.

**Motivo:** con texto libre, en un mes conviven "M", "m", "Mediano" y "MED"
como valores distintos. El stock deja de ser confiable y los reportes por
talle no sirven.

### AD-16 — Historial de cambios de precio y costo

Todo cambio de `precio_venta` o `costo_actual` queda registrado con valor
anterior, nuevo, usuario y fecha.

**Motivo:** con dos usuarios y plata de por medio, "¿quién cambió este
precio y cuándo?" es una pregunta que aparece sí o sí, y hacia atrás no se
reconstruye.

### AD-17 — Sin cuenta corriente ni fiado

Confirmado con la clienta: siempre cobra en el momento. No hay clientes ni
saldos deudores en el MVP.

**Si cambiara:** clientes es una tabla nueva con referencia opcional en la
venta, y cuenta corriente un método de pago más. Lo único que se revisa es
la definición de ingresos en `resultados` (devengado vs. percibido).

### AD-18 — Los descuentos se prorratean a las líneas

Cada línea de venta guarda, además del precio de lista, el **neto que se
cobró de verdad**: el descuento total y el ajuste de redondeo repartidos
proporcionalmente entre las líneas.

**El valor autoritativo es `neto_linea`, no el unitario.** Es a nivel línea
porque el resto del prorrateo son centavos que no se pueden repartir entre
unidades: si el residuo es $0,01 y la línea tiene 3 unidades, no existe un
`neto_unitario` de 2 decimales que multiplicado por 3 lo represente. El
`neto_unitario` queda como dato informativo (`neto_linea / cantidad`).

Algoritmo, sin excepciones:

1. Para cada línea: `neto_linea = round(subtotal_linea × total / subtotal)`.
2. El residuo (`total − SUM(neto_linea)`) se suma a la **línea de mayor
   `neto_linea`**; si hay empate, a la de menor `id`.
3. **Devolución parcial:**
   `neto_linea_devuelto = round(neto_linea_original × cantidad_devuelta / cantidad_vendida)`.
   En la última devolución que agota la línea se asigna el remanente exacto,
   para que la suma de todas las devoluciones de esa línea nunca difiera del
   `neto_linea` original.

**Motivo:** sin esto, una devolución reintegra el precio de lista y no lo que
la clienta pagó. En una venta de $2.999 con 15% de descuento, cobrada $2.549,
devolver todo saldría $2.999 — la tienda pierde $450 en cada devolución de
una venta con descuento, y en el reporte de resultados esa operación deja un
ingreso **negativo** de $450 cuando en realidad fue neutra.

### AD-19 — Anulación y devolución son excluyentes

Una venta con devoluciones **no se puede anular**, y una venta anulada **no
admite devoluciones**.

**Motivo:** las dos operaciones revierten stock y caja. Si se permiten sobre
la misma venta, la revierten dos veces: el stock queda de más y del cajón
sale plata que nadie recibió. Y el invariante 1 no lo detecta, porque el
movimiento fantasma y el contador coinciden entre sí.

---

## 3. Modelo de datos

Tipos genéricos; se traducen al ORM elegido. Todas las tablas llevan
`created_at` y `updated_at` salvo aclaración.

> **Regla general de dinero:** todos los importes son enteros en centavos o
> decimales de precisión fija (por ejemplo `DECIMAL(12,2)`). **Nunca punto
> flotante.**
>
> **Excepción a `updated_at`:** `stock_movements` y `price_history` son
> tablas de solo inserción. No llevan `updated_at` ni se editan jamás.
>
> **Sobre la numeración:** `sales.numero` y `returns.numero` usan secuencias
> de Postgres. Son **crecientes pero pueden tener huecos** (una transacción
> que se revierte consume el número igual). Es correcto y esperable; la
> numeración fiscal correlativa sin huecos, si alguna vez hace falta, es un
> sistema aparte (ver 8.7).

### 3.1 Usuarios y acceso

**`users`**

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| email | string, único | login |
| password_hash | string | nunca la contraseña en claro |
| nombre | string | |
| rol | enum | `OWNER` \| `SELLER` |
| activo | bool | baja lógica, nunca borrado físico |

### 3.2 Catálogo

**`brands`** — id, nombre (único), activo
**`categories`** — id, nombre (único), activo
**`sizes`** — id, nombre (único), orden (para listar S, M, L, XL en orden
lógico y no alfabético), activo
**`colors`** — id, nombre (único), activo

**`products`**

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| nombre | string | |
| descripcion | text, nullable | |
| brand_id | FK → brands, nullable | |
| category_id | FK → categories, nullable | |
| activo | bool | |

**`variants`** — la unidad real de venta y de stock

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| product_id | FK → products | |
| size_id | FK → sizes, nullable | lista administrable (AD-15) |
| color_id | FK → colors, nullable | lista administrable (AD-15) |
| sku | string, único | identificador estable |
| barcode | string, único, nullable | buscable |
| precio_venta | decimal | |
| costo_actual | decimal | se actualiza en cada ingreso (AD-6) |
| stock_actual | integer | contador denormalizado (AD-4) |
| activo | bool | |

Índices: `sku`, `barcode`, `product_id`.

Restricción: única combinación (`product_id`, `size_id`, `color_id`), con
**`UNIQUE NULLS NOT DISTINCT`** (Postgres 15+). Sin eso, un artículo sin
talle ni color —un cinturón, una cartera— puede cargarse dos veces, porque
en Postgres dos `NULL` se consideran distintos: quedarían dos filas con dos
contadores de stock separados para el mismo artículo.

**`price_history`** — auditoría de cambios de precio y costo (AD-16)

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| variant_id | FK → variants | |
| campo | enum | `PRECIO_VENTA` \| `COSTO` |
| valor_anterior | decimal, **nullable** | vacío cuando `origen = ALTA` |
| valor_nuevo | decimal | |
| origen | enum | `ALTA` \| `MANUAL` \| `MASIVO` \| `INGRESO_MERCADERIA` |
| user_id | FK → users | |

Solo se inserta: nunca se edita ni se borra.

### 3.3 Stock

**`stock_movements`** — libro de movimientos, solo se inserta, nunca se
edita ni se borra

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| variant_id | FK → variants | |
| delta | integer | positivo o negativo |
| tipo | enum | `ENTRADA` \| `VENTA` \| `DEVOLUCION` \| `ANULACION` \| `AJUSTE` |
| costo_unitario | decimal, nullable | obligatorio si `tipo = ENTRADA` |
| referencia_tipo | enum, nullable | `SALE` \| `RETURN` |
| referencia_id | integer, nullable | id de la venta/devolución |
| motivo | text, nullable | obligatorio si `tipo = AJUSTE` |
| user_id | FK → users | quién lo hizo |

Índices: `variant_id`, (`referencia_tipo`, `referencia_id`), `created_at`.

### 3.4 Ventas

**`sales`**

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| numero | integer, único, secuencial | legible para el ticket |
| fecha | timestamp | |
| user_id | FK → users | vendedor |
| cash_register_session_id | FK → cash_register_sessions | turno en que se hizo |
| subtotal | decimal | suma de líneas antes de descuentos |
| descuento_total | decimal | suma de `sale_discounts` |
| ajuste_redondeo | decimal, default 0 | positivo o negativo (AD-14) |
| total | decimal | `subtotal − descuento_total + ajuste_redondeo` |
| estado | enum | `COMPLETADA` \| `ANULADA` |
| idempotency_key | string, único, nullable | AD-10 |

**`sale_items`**

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| sale_id | FK → sales | |
| variant_id | FK → variants | |
| descripcion_snapshot | string | nombre + talle + color al momento de vender |
| cantidad | integer | > 0 |
| precio_unitario | decimal | **copia** del precio de lista al vender (AD-5) |
| costo_unitario | decimal | **copia** del costo al vender (AD-5) |
| subtotal | decimal | `cantidad × precio_unitario` (bruto, antes de descuentos) |
| neto_linea | decimal | **valor autoritativo**: lo efectivamente cobrado por esta línea, con descuento y redondeo prorrateados (AD-18) |
| neto_unitario | decimal | `neto_linea / cantidad`, informativo — puede no ser exacto |

**`sale_discounts`** — punto de extensión para códigos de descuento

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| sale_id | FK → sales | |
| tipo | enum | `MANUAL` (único en el MVP) |
| descripcion | string | |
| porcentaje | decimal, nullable | si se cargó como porcentaje |
| monto | decimal | importe efectivamente descontado |
| autorizado_por_user_id | FK → users, nullable | si superó el límite del vendedor |

**`payments`** — punto de extensión para gift cards

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| sale_id | FK → sales | |
| metodo | enum | `EFECTIVO` \| `TARJETA_DEBITO` \| `TARJETA_CREDITO` \| `TRANSFERENCIA` \| `CREDITO_DEVOLUCION` |
| monto | decimal | > 0 |
| referencia | string, nullable | últimos dígitos, nº de operación |
| return_id | FK → returns, nullable | obligatorio si `metodo = CREDITO_DEVOLUCION` |

`CREDITO_DEVOLUCION` es el saldo a favor que genera una devolución cuando se
usa para pagar la venta nueva de un **cambio**. Sin este método, un cambio
sin diferencia de dinero es imposible de registrar (ver 5.4).

### 3.5 Devoluciones

**`returns`**

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| numero | integer, único, secuencial | |
| sale_id | FK → sales | **obligatorio**: siempre contra una venta |
| fecha | timestamp | |
| user_id | FK → users | |
| cash_register_session_id | FK → cash_register_sessions | |
| tipo | enum | `DEVOLUCION` (reintegro) \| `CAMBIO` |
| total_devuelto | decimal | `SUM(return_items.neto_linea)` — ver invariante 11 |
| sale_nueva_id | FK → sales, nullable | la venta del cambio, si `tipo = CAMBIO` |
| autorizado_por_user_id | FK → users, nullable | si se aceptó fuera de plazo |
| idempotency_key | string, único, nullable | |

**`return_items`**

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| return_id | FK → returns | |
| sale_item_id | FK → sale_items | contra qué línea original |
| cantidad | integer | ≤ lo vendido y no devuelto antes |
| neto_linea | decimal | parte proporcional del `neto_linea` original que corresponde a la cantidad devuelta — **lo que la clienta pagó de verdad**, no el precio de lista. Ver AD-18. |
| costo_unitario | decimal | copia de la línea original |
| reingresa_stock | bool | `false` si la prenda vuelve fallada |

**`return_payments`** — cómo se reintegró el dinero

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| return_id | FK → returns | |
| metodo | enum | mismos valores que `payments.metodo` |
| monto | decimal | > 0 |
| referencia | string, nullable | |

Sin esta tabla, una venta cobrada mitad en efectivo y mitad con tarjeta no
se puede devolver correctamente: el sistema no sabría cuánto sale del cajón
y el arqueo nunca cerraría.

### 3.6 Caja

**`cash_register_sessions`** — un turno de caja

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| fecha_apertura | timestamp | |
| user_id_apertura | FK → users | |
| monto_inicial | decimal | |
| fecha_cierre | timestamp, nullable | |
| user_id_cierre | FK → users, nullable | |
| monto_declarado | decimal, nullable | lo que contó la persona |
| monto_sistema | decimal, nullable | lo que dice el sistema |
| diferencia | decimal, nullable | `declarado - sistema` |
| nota_cierre | text, nullable | obligatoria si hay diferencia relevante |
| estado | enum | `ABIERTA` \| `CERRADA` |

Restricción: **no puede haber dos sesiones `ABIERTA` a la vez.**

**`cash_movements`** — solo efectivo (AD-8)

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| session_id | FK → cash_register_sessions | |
| fecha | timestamp | |
| tipo | enum | `VENTA` \| `DEVOLUCION` \| `ANULACION` \| `GASTO` \| `INGRESO_MANUAL` \| `RETIRO` |
| monto | decimal | con signo — ver convención abajo |
| referencia_tipo | enum, nullable | `SALE` \| `RETURN` \| `EXPENSE` |
| referencia_id | integer, nullable | |
| descripcion | string | |
| idempotency_key | string, único, nullable | evita duplicar por doble click (AD-10) |
| user_id | FK → users | |

**Convención de signo (obligatoria, con CHECK en la base):**

- `VENTA` e `INGRESO_MANUAL` → siempre **positivo**.
- `DEVOLUCION`, `ANULACION`, `GASTO` y `RETIRO` → siempre **negativo**.

Sin este CHECK, un desarrollador puede guardar magnitudes y aplicar el signo
según el tipo al sumar: el arqueo daría mal por el doble de cada egreso, y el
invariante 2 pasaría igual porque valida contra su propia aritmética errónea.

### 3.7 Gastos

**`expense_categories`** — id, nombre, activo, **`bloqueada` (bool)**

Semilla: Alquiler, Sueldos, Servicios, Impuestos, Mantenimiento, Otros —
**nunca "Mercadería"** (AD-7). Las de semilla van con `bloqueada = true`.

`bloqueada = true` significa: **no se puede renombrar ni desactivar**. Sí se
puede usar normalmente. Existe para que nadie renombre "Otros" como
"Mercadería" y esquive la validación de abajo.

Al **crear o renombrar** una categoría se **rechaza** cualquier nombre que
refiera a compra de mercadería ("mercadería", "compra de ropa",
"proveedores"), con un mensaje que explique por qué: la compra de stock no
es gasto, su costo entra al resultado cuando se vende. Sin esta validación,
el error contable que AD-7 declara "el más común" queda a un clic de
distancia.

**`expenses`**

| Campo | Tipo | Notas |
|---|---|---|
| id | PK | |
| fecha | timestamp | timestamp, no `date`: se agrupa con AD-13 igual que todo lo demás |
| idempotency_key | string, único, nullable | |
| expense_category_id | FK → expense_categories | |
| descripcion | string | |
| monto | decimal | > 0 |
| medio_pago | enum | `EFECTIVO` \| `TRANSFERENCIA` \| `OTRO` |
| user_id | FK → users | |

El vínculo con la caja lo lleva **solo** `cash_movements`
(`referencia_tipo = EXPENSE`), en una sola dirección. Guardarlo también en
`expenses` crearía dos fuentes de verdad que pueden discrepar.

### 3.8 Configuración

**`settings`** — los parámetros de la sección 10 necesitan dónde vivir

| Campo | Tipo | Notas |
|---|---|---|
| clave | PK, string | `permitir_venta_sin_stock`, etc. |
| valor | string | |
| tipo | enum | `BOOL` \| `INT` \| `DECIMAL` |
| updated_by_user_id | FK → users, nullable | |

Sin esta tabla, los cuatro parámetros configurables quedan hardcodeados —y
el invariante 5, que depende de `permitir_venta_sin_stock`, no se puede ni
evaluar. Solo `OWNER` los modifica.

### 3.9 Resultados

**No tiene tabla propia.** Es una consulta sobre las tablas anteriores, en
un rango de fechas. Ver sección 5.6.

---

## 4. Capas y responsabilidades

```
   Frontend  ──HTTP──▶  Controllers  ──▶  Services  ──▶  Repositorios/ORM  ──▶  DB
                             │               │
                     valida forma      reglas, transacciones,
                     del request         invariantes
```

**Controllers / rutas.** Reciben el request, validan que la *forma* de los
datos sea correcta (tipos, campos obligatorios, rangos), llaman a un
servicio y traducen el resultado a HTTP. **Cero lógica de negocio.**

**Services.** Toda la lógica: reglas, cálculos, invariantes y control de
transacciones. Una operación de negocio = un método de servicio = una
transacción. Es la única puerta de entrada a la lógica, y por eso una futura
integración de e-commerce entra por acá (AD-9).

**Repositorios / ORM.** Acceso a datos. Sin reglas de negocio.

**Frontend.** Interfaz y experiencia. Puede validar para dar feedback
rápido, pero **nunca es la única validación**: toda regla se revalida en el
servicio.

**Regla dura:** ninguna operación que toque stock, dinero o caja se ejecuta
fuera de una transacción de base de datos.

---

## 5. Módulos: reglas de negocio

### 5.1 `auth`

- Login con email y contraseña. Contraseñas con hash fuerte (bcrypt/argon2),
  nunca reversible.
- Dos roles: `OWNER` y `SELLER`.
- `SELLER` **no** accede a: módulo de resultados, gestión de usuarios,
  costos de productos, ni cierre de caja con totales.
- Toda ruta protegida verifica rol en el **servidor**. Ocultar un botón en
  el frontend no es autorización.
- Baja lógica de usuarios (`activo = false`), nunca borrado.

### 5.2 `products` / `variants`

- La venta y el stock operan **siempre** sobre variantes, nunca sobre
  productos.
- `sku` obligatorio y único; `barcode` opcional pero único si existe.
- El buscador acepta nombre, SKU y código de barras en un solo campo (un
  lector de código de barras es un teclado que escribe rápido y manda enter,
  así que el mismo input cubre ambos casos).
- El costo solo lo ve y edita `OWNER`.
- **Ingreso de mercadería:** genera `stock_movements` con `tipo = ENTRADA` y
  `costo_unitario`, y actualiza `variants.costo_actual` (AD-6). No genera
  gasto (AD-7).
- **Si se le paga al proveedor en efectivo de la caja**, eso es un
  `cash_movements` de tipo `RETIRO`, **nunca un `expense`**. Registrarlo como
  gasto contaría la mercadería dos veces: al comprarla y otra vez como costo
  al venderla.
- **Ajuste de stock:** permitido solo a `OWNER`, con motivo obligatorio.
- Productos y variantes se dan de baja lógicamente: si tienen ventas
  asociadas, jamás se borran. **Una variante dada de baja con stock > 0 sigue
  contando** en el valor de inventario y en la reconciliación del invariante
  1; lo único que cambia es que no aparece en el buscador de venta.
- **Alta por grilla:** al crear un producto se eligen los talles y los
  colores, y el sistema genera todas las combinaciones de una sola vez, con
  una tabla para completar stock, precio y costo (ver sección 12.2).
  **El stock inicial cargado en la grilla pasa por `stock.service` como
  movimiento `ENTRADA` con su `costo_unitario`**, uno por variante. Nunca se
  escribe `stock_actual` directo: si se hiciera, el invariante 1 fallaría en
  todas las variantes del sistema desde el primer día.
- **Actualización masiva de precios** (decisión A5 de
  `DECISIONES_PENDIENTES.md`; no confundir con AD-5 de este documento):
  permite aplicar un
  porcentaje a un conjunto de variantes filtrado por marca, categoría o
  selección manual. **Obligatorio: vista previa** con precio actual y precio
  resultante antes de confirmar. Cada cambio escribe en `price_history` con
  `origen = MASIVO`. Solo `OWNER`.
- Todo cambio de precio o costo —manual, masivo o por ingreso de
  mercadería— escribe en `price_history` (AD-16).

### 5.3 `sales`

Flujo, todo dentro de **una transacción**:

1. Validar que haya una sesión de caja `ABIERTA`. Sin caja abierta no se
   vende.
2. Validar stock suficiente de cada variante.
3. Crear `sales` + `sale_items` copiando precio y costo actuales (AD-5).
4. Registrar `sale_discounts` si corresponde.
5. Registrar `payments`. **La suma de pagos debe igualar el total.**
6. Descontar stock: un `stock_movements` con `delta` negativo por línea, más
   la actualización de `stock_actual` (AD-4).
7. Si algún pago es `EFECTIVO`, crear un `cash_movements` por ese importe
   (AD-8).

Reglas:

- **No se vende con stock insuficiente.** Configurable
  (`permitir_venta_sin_stock`, por defecto `false`).
- **No se vende nada que no esté catalogado.** No existe la "venta libre"
  con precio a mano: rompería el control de stock y ensuciaría el costo, que
  son justamente las dos cosas que el sistema tiene que responder bien. Si
  aparece la necesidad, se carga el producto en el momento.
- **Ajuste de redondeo** (AD-14): la venta puede llevar un ajuste de
  centavos, siempre menor a $1 en valor absoluto.
- **Descuentos:** el tope del `SELLER` se evalúa sobre el **total**
  (`descuento_total / subtotal`), no sobre cada descuento por separado —si no,
  dos descuentos del 8% pasarían el control y darían 16%. Por defecto
  `max_descuento_vendedor_pct = 10`. Por encima requiere autorización de un
  `OWNER`, registrada en `sale_discounts.autorizado_por_user_id`.
- **Tope duro:** `0 ≤ descuento_total ≤ subtotal`. Un descuento mayor al
  subtotal dejaría el total en negativo y la venta sería imposible de guardar,
  con un error que nadie entiende.
- **Prorrateo (AD-18):** al cerrar la venta se calcula el `neto_linea` de
  cada línea repartiendo `descuento_total` y `ajuste_redondeo`, con el
  residuo a la línea de mayor importe. La suma de `neto_linea` debe dar
  **exactamente** `total`.
- **Anulación:** una venta no se borra; pasa a `ANULADA`, revierte stock y
  caja con movimientos nuevos de tipo `ANULACION` (no borra los viejos ni los
  registra como `DEVOLUCION`, para que en el libro se distingan). Solo
  `OWNER`, solo dentro de la misma sesión de caja, y **solo si la venta no
  tiene ninguna devolución** (AD-19). Después de cerrada la caja, se resuelve
  por devolución.
- **El movimiento de caja de la anulación se crea solo por el importe que se
  había cobrado en `EFECTIVO`.** Anular una venta con tarjeta no saca nada
  del cajón, porque nunca entró: si se revirtiera el total, el arqueo
  mostraría un faltante fantasma y el invariante 2 pasaría igual, porque
  valida contra su propia suma.
- **No se anula una venta pagada con `CREDITO_DEVOLUCION`** (invariante 15).
- Idempotencia obligatoria (AD-10): dos envíos con la misma clave generan
  una sola venta.

### 5.4 `returns`

- **Siempre contra una venta existente** (`sale_id` obligatorio). Sin ticket
  no hay devolución en el MVP.
- **La venta no puede estar `ANULADA`** (AD-19).
- **Siempre requiere sesión de caja abierta**, haya o no reintegro en
  efectivo (`cash_register_session_id` es obligatorio en la tabla).
- Plazo máximo configurable (`dias_plazo_devolucion`, por defecto **30
  días**). Superado el plazo, requiere autorización de `OWNER`, que queda
  registrada en `returns.autorizado_por_user_id`.
- No se puede devolver más cantidad de la vendida, descontando devoluciones
  previas de esa misma línea.
- **Se reintegra la parte proporcional del `neto_linea`**, no el precio de
  lista: lo que la clienta pagó realmente después de descuentos y redondeo.
  La fórmula de la devolución parcial está en AD-18.
- **El reintegro se registra en `return_payments`**, con sus medios de pago.
  Regla: se devuelve por el mismo medio en que se cobró; si la venta fue
  mixta, se reintegra en la misma proporción salvo que se indique otra cosa.
  **Solo la parte en efectivo genera `cash_movements` negativo** (AD-8).
- `reingresa_stock` por línea: si la prenda vuelve fallada, se devuelve la
  plata pero **no** vuelve al stock vendible.
- **Reversión del costo, condicional:** el `costo_unitario` se resta del CMV
  **solo si `reingresa_stock = true`**. Si la prenda se descarta, la
  mercadería se perdió de verdad: ese costo tiene que quedar como pérdida del
  período. Revertirlo siempre haría desaparecer del resultado el costo de
  cada prenda fallada y el sistema informaría una ganancia mayor a la real.
- **`CAMBIO`:** genera la devolución y una venta nueva, vinculadas por
  `returns.sale_nueva_id`. **Sin este mecanismo, un cambio de talle por el
  mismo precio —la operación más común del mostrador— sería imposible de
  registrar**, porque la venta nueva exigiría pagos que nadie entregó.

  Secuencia exacta, toda en **una transacción** (el orden importa: las
  referencias son circulares):

  1. Crear la devolución con `sale_nueva_id` en null y sus `return_items`.
  2. Registrar en `return_payments` un reintegro de método
     **`CREDITO_DEVOLUCION`** por el importe que se aplica al cambio. **No
     se devuelve en efectivo la parte que se reutiliza**: si se hiciera,
     saldría plata del cajón que en realidad nunca salió. Solo el excedente,
     si la prenda nueva es más barata, se reintegra por los medios
     habituales.
  3. Crear la venta nueva con un `payments` de método `CREDITO_DEVOLUCION`,
     con `return_id` apuntando a la devolución, por ese mismo importe. Si la
     prenda nueva es más cara, la diferencia se cobra normalmente.
  4. Actualizar `returns.sale_nueva_id`.

- **El crédito de una devolución se usa una sola vez.** La suma de los pagos
  `CREDITO_DEVOLUCION` de una misma devolución nunca puede superar su
  `total_devuelto` (invariante 14). Sin ese tope, dos ventas distintas
  podrían pagarse con el mismo crédito y la tienda entregaría mercadería dos
  veces por un solo reintegro.
- **Una venta pagada con `CREDITO_DEVOLUCION` no se puede anular.** Habría
  que devolver un crédito que ya se consumió y las devoluciones no se anulan.
  Se corrige con una devolución de esa venta nueva.

### 5.5 `cash-registers`

- **Apertura:** monto inicial declarado. No puede haber dos sesiones
  abiertas simultáneas.
- **Sesión olvidada abierta:** si al entrar al sistema hay una sesión abierta
  de un día anterior, se avisa y se **obliga a cerrarla** antes de operar. No
  se cierra automáticamente: el arqueo lo hace una persona. Sin esto, las
  ventas de hoy caen en el turno de ayer y ningún arqueo cierra nunca.
- Varios vendedores comparten la misma sesión de caja (hay una sola caja
  física). Cada venta igual registra qué usuario la hizo.
- Durante el turno, todo movimiento de efectivo queda en `cash_movements`.
- **Cierre:** la persona declara el efectivo contado. El sistema calcula
  `monto_sistema = monto_inicial + SUM(cash_movements.monto)` y registra la
  `diferencia`.
- **La diferencia no bloquea el cierre**, pero queda registrada. Si supera
  el umbral configurable, la nota es obligatoria **cuando cierra un
  `OWNER`**. Cuando cierra un `SELLER`, no se le puede exigir justificar una
  diferencia que tiene prohibido ver —y el pedido mismo le revelaría que
  existe—: se le ofrece un campo neutral ("¿algo para comentar del turno?"),
  la sesión cierra igual y la nota la completa después el `OWNER`.
- Cerrada una sesión, **sus movimientos son inmutables**. Se bloquea a nivel
  de base de datos toda escritura de `cash_movements` con `session_id` de una
  sesión `CERRADA`.
- **Cierre a ciegas:** un `SELLER` **puede** cerrar la caja —declara el
  efectivo contado— pero **nunca ve** `monto_sistema` ni `diferencia`. Solo
  `OWNER` los ve. Si cerrar fuera exclusivo de `OWNER`, una vendedora que
  llega sola el lunes a una sesión abierta del sábado no podría vender hasta
  que aparezca la dueña.

### 5.6 `resultados`

Consulta por rango de fechas (día, mes, rango libre):

```
Ingresos       = SUM(sales.total)            WHERE sales.estado = 'COMPLETADA'
               − SUM(returns.total_devuelto)

CMV            = SUM(sale_items.cantidad × sale_items.costo_unitario)
                   JOIN sales, WHERE sales.estado = 'COMPLETADA'
               − SUM(return_items.cantidad × return_items.costo_unitario)
                   WHERE return_items.reingresa_stock = true

Margen bruto   = Ingresos − CMV

Gastos         = SUM(expenses.monto)         WHERE expenses.fecha en el período
                 (nunca incluye compra de mercadería — AD-7)

Resultado neto = Margen bruto − Gastos
```

**Tres filtros que parecen detalles y no lo son:**

1. **El CMV filtra por `COMPLETADA` igual que los ingresos.** Si no, al
   anular una venta se descuenta el ingreso pero queda el costo, y cada
   anulación inventa una pérdida del monto completo de la venta.
2. **La reversión del costo solo aplica si la prenda volvió al stock.** Una
   devolución de mercadería fallada resta ingreso pero el costo debe quedar:
   esa ropa se perdió (ver 5.4).
3. **El período se filtra siempre por `sales.fecha`, `returns.fecha` y
   `expenses.fecha`** (haciendo join desde las tablas de ítems, que no
   tienen fecha propia), las tres convertidas a hora argentina según AD-13.
   Filtrar los ítems por su `created_at` haría que ingresos y costos cayeran
   en meses distintos; olvidar el filtro en gastos haría que el resultado
   sumara todos los gastos de la historia.

También expone: margen bruto en porcentaje, ranking de productos más
vendidos y por margen, y gastos agrupados por categoría.

**Agrupación temporal:** siempre en hora argentina (AD-13). Un test debe
verificar que una venta de las 23:30 pertenece al día correcto.

**Los resultados son "al día de hoy", no fotos inmutables.** Una anulación
puede modificar un período ya consultado. La pantalla muestra siempre la
fecha y hora del cálculo, para que un número impreso ayer y otro de hoy se
puedan explicar.

**Las devoluciones no se anulan.** A diferencia de las ventas, una
devolución mal cargada es definitiva y consume el cupo del invariante 8. Si
hace falta corregir, se hace con un ajuste de stock y un movimiento de caja
manual, ambos con motivo. Es una limitación consciente del MVP.

Regla: **usa siempre los costos congelados** de las líneas, nunca
`variants.costo_actual` (AD-5).

Acceso: **solo `OWNER`**.

---

## 6. Invariantes del sistema

Reglas que deben cumplirse siempre. Cada una merece un test automatizado, y
las tres primeras además un chequeo de reconciliación ejecutable.

1. `variants.stock_actual == SUM(stock_movements.delta)` para cada variante.
2. Al cerrar,
   `monto_sistema == monto_inicial + SUM(cash_movements.monto)`; y el valor
   debe poder recalcularse en cualquier momento, también con la sesión
   abierta.
3. Toda venta cumple `SUM(payments.monto) == sales.total`.
4. Toda venta cumple
   `total == subtotal − descuento_total + ajuste_redondeo`, con
   `|ajuste_redondeo| < 1`, `0 ≤ descuento_total ≤ subtotal` y `total ≥ 0`.
5. `stock_actual >= 0`, salvo que `permitir_venta_sin_stock` esté activo.
6. Ningún `stock_movements` existe sin `tipo`; si es `AJUSTE` tiene `motivo`;
   si es `VENTA`, `DEVOLUCION` o `ANULACION` tiene referencia.
7. De los cobros de una venta (`payments`) y de los reintegros de una
   devolución (`return_payments`), **solo los de método `EFECTIVO` generan
   `cash_movements`**; las tarjetas, las transferencias y el
   `CREDITO_DEVOLUCION` no tocan el cajón. Los movimientos de caja de tipo
   `GASTO`, `RETIRO`, `INGRESO_MANUAL` y `ANULACION` tienen su propio origen
   y no dependen de esta regla.
8. La suma de `return_items.cantidad` por `sale_item_id` nunca supera la
   `cantidad` vendida en esa línea.
9. Nunca hay más de una `cash_register_sessions` en estado `ABIERTA`.
10. Ninguna venta ni devolución se registra sin sesión de caja abierta. Los
    gastos solo requieren sesión abierta **si se pagan en efectivo desde la
    caja**: uno pagado por transferencia no la necesita, porque la dueña
    puede pagar el alquiler un domingo desde su casa.
11. Toda devolución cumple
    `total_devuelto == SUM(return_items.neto_linea)` y
    `SUM(return_payments.monto) == total_devuelto`.
12. Toda venta cumple `subtotal == SUM(sale_items.subtotal)`,
    `descuento_total == SUM(sale_discounts.monto)` y
    `SUM(sale_items.neto_linea) == total`.
13. Ninguna venta tiene a la vez estado `ANULADA` y devoluciones asociadas
    **por `returns.sale_id`** (AD-19). La venta nueva de un cambio —vinculada
    por `returns.sale_nueva_id`— no cuenta para este invariante; su
    restricción es la 15.
14. Por cada devolución, la suma de los pagos de método `CREDITO_DEVOLUCION`
    que la referencian nunca supera su `total_devuelto`.
15. Ninguna venta con un pago de método `CREDITO_DEVOLUCION` puede quedar en
    estado `ANULADA`.

---

## 7. Concurrencia y consistencia

El punto delicado del sistema es el stock: dos ventas simultáneas de la
última unidad no pueden pasar las dos.

- Toda venta que descuenta stock **bloquea la fila de la variante** dentro
  de la transacción (`SELECT ... FOR UPDATE` o el equivalente del ORM) antes
  de validar y descontar.
- La validación de stock y el descuento ocurren **dentro de la misma
  transacción**. Validar antes de abrir la transacción no sirve.
- Los números de venta y devolución se generan de forma segura ante
  concurrencia (secuencia de base de datos, no `MAX(numero) + 1`).
- La clave de idempotencia tiene índice único: dos requests simultáneos con
  la misma clave, uno gana y el otro recibe el resultado del primero.

Estos escenarios se prueban explícitamente (es la Fase 15 del protocolo, no
alcanza con revisar el código).

---

## 8. Puntos de extensión

Cómo entra cada cosa que hoy queda afuera, **sin rehacer lo existente**.

### 8.1 Gift cards
Se agrega `GIFT_CARD` al enum de `payments.metodo`, una tabla `gift_cards`
(código, saldo, estado) y un FK opcional desde `payments`. La venta no se
toca: ya acepta N pagos (AD-3).

### 8.2 Códigos de descuento
Se agrega `CODIGO` al enum de `sale_discounts.tipo` y una tabla
`discount_codes`. La venta no se toca: ya acepta N descuentos (AD-3).

### 8.3 Señas / apartados
Entidad nueva que agrupa pagos parciales contra una reserva de stock, más un
tipo de movimiento `RESERVA`. Requiere definir política de vencimiento y
abandono — es una decisión de negocio, no técnica.

### 8.4 Clientes
Tabla `customers` y un FK opcional en `sales`. Es aditivo, sin migración de
datos.

### 8.5 Multi-sucursal
Se agrega `store_id` a stock, sesiones de caja y ventas. La migración
rellena todo con el local existente. Mecánica, pero hay que revisar cada
consulta de stock y de resultados.

### 8.6 Costo promedio ponderado
Se reemplaza el cálculo de `costo_actual` en el ingreso de mercadería. **El
histórico no se ve afectado**, precisamente porque los costos están
congelados en las líneas (AD-5).

### 8.7 Facturación electrónica (AFIP)
Servicio separado que consume ventas `COMPLETADA` y emite el comprobante,
guardando CAE y número fiscal en una tabla propia. No modifica la venta.
Requiere certificados, homologación y modo de contingencia.

### 8.8 E-commerce
Es la extensión que más se apoya en las decisiones ya tomadas:

- La sincronización llama a **los mismos servicios** que el mostrador
  (AD-9), no reimplementa reglas.
- El stock sigue siendo **una sola fuente de verdad** con movimientos
  transaccionales (AD-4, sección 7): es lo que evita vender la misma prenda
  en el local y en la web a la vez.
- Los webhooks entrantes usan **claves de idempotencia** (AD-10): un webhook
  duplicado no descuenta stock dos veces.
- El `sku` es el identificador estable para mapear productos con la tienda
  online.

**Advertencia honesta:** esto hace que la integración sea posible sin
reescribir, no que sea gratis. Sincronizar stock entre dos canales en tiempo
real tiene una parte genuinamente difícil (latencia, reservas, ventas
simultáneas en ambos canales) que ninguna arquitectura resuelve sola.

---

## 9. Stack y estructura

### 9.1 Stack elegido

| Pieza | Elección | Motivo |
|---|---|---|
| Lenguaje | **TypeScript** | Manejamos plata y stock: que el compilador avise de un campo faltante o un tipo mal usado vale más que el tiempo de tipar. |
| Backend | **NestJS** | Su estructura por defecto (controllers finos → services con la lógica) **es** la arquitectura de AD-9. Además su inyección de dependencias hace los tests mucho más simples, y el protocolo exige muchos tests. |
| Base de datos | **PostgreSQL** | Transacciones serias, bloqueo de filas (`FOR UPDATE`) y tipo `NUMERIC` para dinero. El modelo es profundamente relacional: una base documental sería el error de diseño más caro posible acá. |
| ORM | **Prisma** | Las mejores migraciones del ecosistema (el protocolo tiene gates de verificación de migraciones), tipos generados desde el esquema, y muchísimo material — importante porque vas a desarrollar con un agente. |
| Frontend | **React + Vite** | Es una app interna: no necesita SSR ni SEO. Vite da builds y recarga rápidos. |
| Componentes UI | **Mantine** | Trae tablas, formularios, modales y notificaciones ya resueltos y **coherentes entre sí**. Sin una librería, 20 pantallas construidas por separado terminan pareciendo 20 sistemas distintos — y acá no hay diseñador. Alternativa razonable: shadcn/ui + Tailwind. |
| Tests | **Jest** (incluido en Nest) + **Supertest** (integración) + **Playwright** (E2E) | |
| Hosting frontend | **Cloudflare Pages** / Vercel / Netlify (gratis) | El build de Vite son archivos estáticos. Acá el plan gratuito no tiene contras reales. |
| Hosting backend | **Render** (plan gratuito) + keep-alive | Deploy desde git, 750 h/mes — alcanzan para tenerlo despierto 24/7. Ver 9.10. |
| Hosting de base de datos | **Neon** (plan gratuito) | Postgres administrado, ~3 GiB, despertar rápido. Alcanza de sobra para una tienda. |

**Sobre e-commerce y Next.js:** no lo usamos acá. Cuando llegue el momento,
la tienda online será una app aparte que consume esta misma API — más limpio
que acoplar el mostrador a un framework por una necesidad futura.

**Limitación conocida de Prisma:** hay cuatro lugares donde hace falta SQL
crudo, no tres: el bloqueo de filas en venta, devolución y ajuste de stock
(patrón resuelto en 9.4), **más el índice único de variantes**, porque
Prisma no sabe expresar `NULLS NOT DISTINCT` y hay que escribir esa
migración a mano. Ojo con esto último: una migración posterior puede
regenerar el índice sin la cláusula y reponer en silencio el bug del
artículo sin talle duplicado. Va acompañado de un test de integración que
inserte dos veces `(product_id, NULL, NULL)` y espere el rechazo.

### 9.2 Estructura de carpetas

```
prisma/
  schema.prisma              # fuente de verdad del modelo (sección 3)
  migrations/
  seed.ts                    # usuario OWNER inicial, categorías de gasto

src/
  main.ts
  app.module.ts

  config/                    # validación de env, falla al arrancar si falta algo
  common/
    auth/                    # guards de autenticación y de rol
    idempotency/             # interceptor de clave de idempotencia
    money/                   # helpers de Decimal
    filters/                 # manejo uniforme de errores

  prisma/
    prisma.service.ts

  modules/
    auth/
      auth.controller.ts
      auth.service.ts
      dto/
    products/
      products.controller.ts
      products.service.ts
      variants.service.ts
      dto/
    stock/
      stock.controller.ts
      stock.service.ts       # ÚNICO lugar que escribe stock_movements
      dto/
    sales/
    returns/
    cash-registers/
    expenses/
    results/

test/
  integration/               # contra Postgres real
  e2e/
```

**Regla:** `stock.service.ts` es el **único** punto del sistema que escribe
en `stock_movements` y toca `stock_actual`. Vive en su propio módulo,
justamente para que ninguna otra parte lo trate como código interno suyo.

Todos lo llaman, nadie lo esquiva: ventas, devoluciones, **anulaciones**,
ingreso de mercadería, ajustes y **el alta por grilla**. Es lo que mantiene
viable el invariante 1.

### 9.3 Manejo de dinero

En el esquema, todo importe es `Decimal`:

```prisma
precio_venta  Decimal @db.Decimal(12, 2)
costo_actual  Decimal @db.Decimal(12, 2)
```

En el código se opera con el `Decimal` de Prisma (decimal.js).

**Prohibido:** convertir a `number` para hacer cuentas. `0.1 + 0.2` en punto
flotante no da `0.3`, y en un arqueo de caja eso aparece como una diferencia
fantasma imposible de explicar. Debe haber una regla de lint o un test que
lo detecte.

**Reglas de redondeo (AD-14).** Orden de operaciones, sin excepciones:

1. Cada línea: `subtotal_linea = cantidad × precio_unitario`, redondeado a 2
   decimales.
2. `subtotal` = suma de las líneas.
3. Cada descuento porcentual se calcula sobre el subtotal y **se redondea a
   2 decimales antes** de acumularse en `descuento_total`.
4. `total = subtotal − descuento_total + ajuste_redondeo`.
5. **Prorrateo a las líneas (AD-18):**
   `neto_linea = round(subtotal_linea × total / subtotal)` por línea, y el
   residuo (`total − SUM(neto_linea)`) se suma a la línea de mayor
   `neto_linea` — con desempate por menor `id`. Es el paso donde se pierde o
   se inventa un centavo si dos personas lo implementan distinto.

Redondeo comercial (medio hacia arriba). El `ajuste_redondeo` lo ingresa
quien cobra, nunca lo calcula el sistema solo, y siempre es menor a $1.

Dos tests obligatorios: 15% sobre $2.999 con cobro de $2.549; y una venta de
tres líneas con descuento donde el prorrateo deje residuo, verificando que
`SUM(neto_linea) == total` exacto.

### 9.4 Transacciones y bloqueo de filas

El punto más delicado del sistema. Patrón obligatorio para toda operación
que descuente stock:

```ts
await this.prisma.$transaction(async (tx) => {
  // 1. Bloquear las variantes ANTES de leer el stock.
  //    Ordenadas por id: si dos ventas simultáneas involucran las mismas
  //    variantes en distinto orden, sin esto se produce un deadlock.
  const ids = [...new Set(items.map(i => i.variantId))].sort((a, b) => a - b);

  // El ORDER BY es imprescindible: sin él, Postgres bloquea en el orden
  // que decida el plan de ejecución, no en el orden de la lista. Dos ventas
  // simultáneas podrían tomar los bloqueos en orden inverso y trabarse.
  await tx.$queryRaw`
    SELECT id FROM variants WHERE id IN (${Prisma.join(ids)})
    ORDER BY id FOR UPDATE
  `;

  // 2. Recién ahora: leer stock, validar, descontar, crear la venta.
  //    Todo lo demás va acá adentro.
});
```

Dos errores que este patrón evita y que son fáciles de cometer:

- **Validar el stock fuera de la transacción.** Entre la validación y el
  descuento entra otra venta y las dos pasan.
- **Bloquear en orden distinto.** Dos transacciones que bloquean A→B y B→A
  se traban mutuamente.

Los números de venta y devolución se generan con una **secuencia de
Postgres**, nunca con `MAX(numero) + 1` (que bajo concurrencia da números
repetidos).

### 9.5 Migraciones

- `prisma migrate dev` en desarrollo, `prisma migrate deploy` en producción.
- **Una migración por ticket**, con nombre descriptivo.
- Toda migración se prueba contra una copia de datos reales antes de ir a
  producción.
- Si una migración no es reversible (borra una columna con datos), se
  documenta en el ticket junto con su mitigación — lo exige la Fase 9.5.

### 9.6 Autenticación

- `@nestjs/passport` con estrategia JWT.
- El token viaja en una **cookie httpOnly + secure + sameSite**, no en
  `localStorage`: así un XSS no puede robarlo.
- Expiración de **12 horas**, para cubrir una jornada completa de local con
  margen. Que se corte la sesión en medio de una venta es inaceptable.
- Contraseñas con **argon2** (o bcrypt).
- Un `RolesGuard` protege las rutas de `OWNER`. **La autorización se
  verifica siempre en el servidor** — ocultar un botón en el frontend no es
  autorización (regla de 5.1).

### 9.7 Idempotencia

- El cliente manda una cabecera `Idempotency-Key` (un UUID que genera al
  abrir el formulario, no al enviarlo).
- **La clave se guarda junto con el borrador en `sessionStorage`** (ver
  12.1). Si se restaura el borrador tras un refresco y se genera una clave
  nueva, la protección desaparece: el caso clásico es que el POST se haya
  confirmado, se pierda la respuesta, la persona refresque y reenvíe — venta
  duplicada, stock descontado dos veces y caja contada dos veces.
- Índice único sobre `idempotency_key` en `sales`, `returns`,
  `cash_movements` y `expenses`. Un doble click en un retiro de $50.000 lo
  registra dos veces y el arqueo muestra un faltante fantasma.
- Si al insertar salta violación de unicidad, **no es un error**: se devuelve
  la operación original con `200`.
- Un interceptor común lo maneja para todas las rutas de escritura.

### 9.8 Testing

- **Unitarios (Jest):** servicios con dependencias mockeadas. Cubren reglas
  de negocio y cálculos, sobre todo los de `results`.
- **Integración (Supertest + Postgres real):** nunca con SQLite ni con la
  base mockeada — justamente lo que hay que probar (transacciones, bloqueos,
  constraints) es lo que un mock no reproduce.
- **E2E (Playwright):** los flujos de la sección 7 de `MVP_SCOPE.md`.
- **Chequeo de invariantes:** un test dedicado por cada invariante de la
  sección 6.
- **Concurrencia:** tests que disparan ventas simultáneas de la última
  unidad (Fase 15 del protocolo).

**Testing de mutación (Stryker).** Responde objetivamente la pregunta "¿mis
tests sirven?": introduce fallas deliberadas en el código y verifica que
algún test las detecte. Un test que sigue en verde con el código roto no
sirve, por más cobertura que reporte.

- Se corre **una vez por módulo**, en la fase de QA adversarial.
- Solo sobre los servicios críticos: `sales`, `stock`, `cash-registers`,
  `returns`, `results`. Correrlo sobre todo el proyecto es lento y no aporta.
- Umbral sugerido: **80% de mutantes detectados** en esos servicios. Por
  debajo, hay tests decorativos.

**Cobertura mínima en CI:** 80% en `src/modules/**/*.service.ts`. No mide
calidad —para eso está la mutación— pero detecta el archivo que quedó sin
ningún test.

**Cuándo se escriben:** los tests unitarios y de integración se escriben
**junto con el código, en el mismo ticket**. Un ticket no cierra en verde sin
ellos.

**Excepción para plata y stock:** en los tickets de `sales`, `returns`,
`cash-registers` y el servicio de stock, los tests se escriben **primero**,
derivados de la sección del blueprint que aplica, y se verifica que **fallen**
antes de implementar. El motivo es preciso: si el test se escribe después,
hereda la interpretación que hizo quien programó. Escrito antes, la
referencia es la especificación. El QA adversarial se hace por módulo, cuando sus tickets están
terminados. Solo los tests de integración entre módulos, E2E y concurrencia
quedan para el final. Dejar todo el testing para después es precisamente el
modo de fallar que este protocolo evita.

**Datos de desarrollo:** un seed opcional (`seed:dev`) con datos realistas —
unos 50 productos con variantes, stock, algunas ventas y gastos — para poder
construir y probar pantallas sin cargar todo a mano cada vez. Nunca se
ejecuta en producción.

### 9.9 Configuración y secretos

- `@nestjs/config` con un esquema de validación (zod): si falta una variable
  de entorno, **la app no arranca**. Es preferible fallar al desplegar que
  descubrirlo cuando alguien intenta cobrar.
- Ningún secreto en el repositorio. `.env.example` con las claves y sin
  valores.
- Secretos distintos por entorno; los de producción solo en el proveedor de
  hosting.

### 9.10 Deploy y backups (con hosting gratuito)

**Restricción:** el hosting debe ser gratuito. Es viable, pero tiene dos
consecuencias concretas que hay que mitigar a propósito.

#### Deploy

- Frontend: build estático de Vite en Cloudflare Pages (o Vercel/Netlify).
  Sin contras en el plan gratuito.
- Backend: Render, deploy automático desde la rama principal, con
  `prisma migrate deploy` como paso previo al arranque.
- Base de datos: Neon.
- Healthcheck en `/health` que verifique conexión a base de datos.

#### Monitoreo (obligatorio antes de producción)

- **Sentry** (plan gratuito) para errores del backend y del frontend.
- **UptimeRobot** (gratuito) golpeando `/health`: cumple doble función —
  alerta si el servicio se cae **y** evita que Render lo duerma.
- Alertas por mail. Sin esto, si el sistema se rompe un sábado a la tarde te
  enterás porque te llama la clienta.

#### Problema 1 — El servicio se duerme

Render suspende el servicio gratuito tras ~15 minutos sin tráfico, y
despertarlo tarda entre 30 y 50 segundos.

**En un mostrador eso es inaceptable:** la primera venta después de una hora
tranquila dejaría a la clienta esperando casi un minuto frente al cliente.

**Mitigación:** un pinger externo (UptimeRobot o similar, gratis) golpea
`/health` cada 10 minutos para que nunca se duerma. El plan gratuito son
750 h/mes y el mes tiene ~730 h, así que da para tenerlo despierto siempre —
pero **solo alcanza para un servicio**. No se puede tener staging siempre
despierto con la misma cuenta.

#### Problema 2 — Los backups del plan gratuito no son confiables

Los planes gratuitos ofrecen retención mínima o nula, y no se puede depender
de eso: acá se guardan **las ventas, la caja y el stock de un negocio real**.
Perder esa base no es un contratiempo, es perder la contabilidad de la
clienta.

**Mitigación obligatoria — backup propio:**

- Una GitHub Action programada, **una vez por día**, corre `pg_dump` contra
  la base de producción.
- El dump se sube cifrado a un almacenamiento externo (Cloudflare R2 tiene
  10 GB gratis; también sirve Backblaze B2).
- Retención mínima de **30 días**.
- Las credenciales viven en los secrets del repositorio, nunca en el código.
- **La restauración se prueba de verdad antes de salir a producción** (Fase
  9.5 del protocolo). Un backup que nunca se restauró no es un backup.

#### Cuándo dejar de estirar el plan gratuito

El gratuito es una etapa, no un destino. Conviene pasar a un plan pago
cuando pase cualquiera de estas cosas:

- La clienta ya paga por el sistema (el hosting es un costo operativo
  legítimo y ronda los USD 5-10 por mes: menos que un café por semana).
- Aparece un segundo cliente (un servicio despierto por cuenta no alcanza).
- El keep-alive falla y alguien se queda esperando en el mostrador.

Mientras tanto, el gratuito es perfectamente válido para desarrollar y para
la primera etapa en producción — siempre que el backup propio esté andando.

> **Nota:** los límites de los planes gratuitos cambian seguido. Verificá las
> condiciones vigentes de Render y Neon antes de configurar, y ajustá esta
> sección si cambiaron.

---

## 10. Configuración del sistema

Parámetros que la dueña puede cambiar sin tocar código:

| Parámetro | Default | Módulo |
|---|---|---|
| `permitir_venta_sin_stock` | `false` | sales |
| `max_descuento_vendedor_pct` | `10` | sales |
| `dias_plazo_devolucion` | `30` | returns |
| `umbral_diferencia_caja` | a definir con ella | cash-registers |

---

## 11. Decisiones tomadas sobre las ambigüedades

Resueltas con el criterio más conservador y estándar del rubro. **Conviene
validarlas con la clienta antes de construir cada módulo** — son decisiones
de negocio, y acá están tomadas por defecto, no confirmadas.

| ID | Pregunta | Decisión tomada |
|---|---|---|
| AMB-1 | ¿Señas? | **Fuera del MVP.** Confirmado. |
| AMB-2 | Política de devolución | Siempre contra venta existente; 30 días configurable; reintegro en efectivo; opción de no reingresar stock si vuelve fallada. |
| AMB-3 | ¿Descuentos del vendedor? | Hasta 10% configurable; por encima requiere autorización de `OWNER`, registrada. |
| AMB-4 | ¿Vender sin stock? | **Bloqueado** por defecto; activable por configuración. |
| AMB-5 | Diferencia en cierre de caja | No bloquea el cierre; se registra la diferencia y exige nota si supera el umbral. |
| AMB-6 | ¿Método de costeo? | Último costo (AD-6). |
| AMB-7 | ¿Facturación fiscal? | Fuera del MVP (AD-11). Confirmado: hoy no la necesita. **Reconfirmar con su contador**, porque las ventas pasadas no se facturan retroactivamente. |
| AMB-8 | ¿Fía / cuenta corriente? | **Confirmado: no fía.** Fuera del MVP (AD-17). |
| AMB-9 | ¿Ticket impreso? | **PENDIENTE.** Si lo da, hay que soportar impresora térmica. Es aditivo: no bloquea el arranque. |
| AMB-10 | Umbral de diferencia de caja | **PENDIENTE.** Definir con la clienta a partir de qué monto se exige nota. |

---

## 12. Interfaz — flujos críticos

El blueprint es exhaustivo en datos y reglas. Esta sección cubre lo único de
interfaz que no puede improvisarse: en un punto de venta, **la pantalla de
cobrar es el producto**. Si vender toma ocho clics y hay que soltar el lector
para agarrar el mouse, el sistema no se usa por más impecables que sean los
invariantes.

### 12.1 Pantalla de venta — diseñada para teclado y lector

**Principio rector:** el foco vive **siempre** en el campo de búsqueda.
Después de cada acción, vuelve ahí solo. Una venta completa se hace sin tocar
el mouse.

Un lector de código de barras es un teclado que escribe rápido y manda
`Enter`. Si el flujo funciona con teclado, funciona con lector — no hace
falta soportarlo aparte.

**Flujo normal:**

1. El foco arranca en el buscador.
2. Se escanea o se tipea. Si hay **coincidencia exacta de código de barras o
   SKU**, el ítem se agrega solo, sin confirmación.
3. Si es búsqueda por texto, aparece una lista navegable con flechas;
   `Enter` agrega el resaltado. **Mientras la lista de resultados está
   abierta, las flechas navegan la lista; con la lista cerrada, navegan las
   líneas ya cargadas.** Es la única lectura que no obliga a soltar el
   teclado.
4. El foco vuelve al buscador. Listo para el siguiente.
5. Escanear **el mismo artículo otra vez incrementa la cantidad** de esa
   línea; no crea una línea nueva.

**Atajos:**

| Tecla | Acción |
|---|---|
| `F2` | Ir a cobrar |
| `F4` | Aplicar descuento |
| `↑` `↓` | Navegar las líneas cargadas |
| `Ctrl` + `+` / `−` | Cambiar cantidad de la línea seleccionada |
| `Ctrl` + `Supr` | Quitar la línea seleccionada |
| `Esc` | Cancelar la venta (con confirmación) |

**Los atajos de línea llevan modificador a propósito.** Sin él, tipear un
SKU que contenga un guion en el buscador —que siempre tiene el foco—
modificaría el carrito en vez de escribir. Lo mismo en la pantalla de cobro:
las teclas `1` a `4` eligen medio de pago **solo** cuando el foco no está en
un campo de importe.

**Pantalla de cobro:**

- **El foco entra en el selector de medio de pago**, no en el importe. Ahí
  las teclas `1` a `4` eligen (efectivo, débito, crédito, transferencia).
- `Enter` o `Tab` pasa al importe, que viene precargado con **lo que falta
  cobrar**; otro `Enter` confirma. Con el foco en el importe, las teclas
  numéricas escriben el número, no cambian el medio de pago.
- Si se cobra en varios medios, siempre se muestra el saldo pendiente.
- En efectivo, se puede ingresar cuánto entregó el cliente y la pantalla
  muestra **el vuelto** (es un cálculo de pantalla, no se guarda).
- El botón de confirmar **se deshabilita apenas se aprieta**, además de la
  idempotencia del backend (AD-10).

**Casos que hay que resolver bien, no como excepción:**

- **Código escaneado inexistente:** mensaje claro, el foco no se mueve y la
  venta en curso **no se pierde**.
- **Stock insuficiente:** se bloquea con un mensaje que diga cuánto hay.
- **Refresco accidental del navegador:** el borrador de la venta se conserva
  (en `sessionStorage`), **junto con su clave de idempotencia** — si al
  restaurar se generara una clave nueva, un reenvío duplicaría la venta.
  Perder diez ítems cargados por un F5 es de las cosas que hacen abandonar un
  sistema.
- **Producto sin código de barras:** tiene que poder encontrarse rápido por
  nombre. No todo el catálogo va a estar etiquetado.

### 12.2 Alta de productos por grilla

La clienta **hoy no tiene nada digitalizado**: hay que cargar la tienda
entera a mano. Cargar variante por variante es lo que hace que un
lanzamiento se abandone a la mitad.

**Flujo:**

1. Se crean el producto y sus datos generales una sola vez (nombre, marca,
   categoría).
2. Se eligen los **talles** (S, M, L, XL) y los **colores** (negro, blanco,
   rojo) de las listas.
3. El sistema **genera las 12 combinaciones** y las muestra como tabla.
4. Se completan stock, precio y costo, con la opción de **aplicar el mismo
   precio y costo a todas** de una vez.
5. Los SKU se generan automáticamente con un patrón, editables.

Doce formularios contra uno. En una tienda con cientos de artículos, esa
diferencia decide si el sistema arranca o no.

**Recomendación operativa:** que empiece cargando lo que más vende, no el
inventario completo. Usarlo con el 40% cargado es mejor que esperar tres
semanas al 100%.

### 12.3 Formatos y localización

Se define una sola vez y se usa en todas las pantallas. Sin esto, cada
pantalla inventa el suyo.

- **Moneda:** formato argentino — `$ 12.500,50` (punto para miles, coma para
  decimales). Nunca el formato estadounidense.
- **Fechas:** `dd/mm/aaaa`. Con hora: `dd/mm/aaaa HH:mm` en 24 horas.
- **Idioma:** todo en español, incluidos los mensajes de error.
- Existe un único helper de formato de moneda y otro de fecha. **Prohibido
  formatear a mano en un componente.**

### 12.4 Listados y volumen

La tienda puede tener cientos de variantes. Los listados no pueden traer
todo.

- Todo listado (catálogo, ventas, movimientos de stock, gastos) es
  **paginado en el servidor**. Nunca se trae la tabla completa al frontend.
- El buscador de la pantalla de venta usa *debounce* (~250 ms) y limita los
  resultados. Una coincidencia exacta de código de barras o SKU **no espera
  el debounce**: resuelve al instante.
- Los listados largos ordenan por fecha descendente por defecto: lo último
  siempre arriba.

### 12.5 Fotos de producto — fuera del MVP

**No hay imágenes de producto en la v1.** Es una decisión deliberada:
subirlas y almacenarlas cientos de veces no aporta al objetivo del sistema
(saber si gana plata) y consume el almacenamiento gratuito.

**Extensión:** un campo de URL en `products` más un almacenamiento externo.
Es puramente aditivo, no migra nada.

### 12.6 Reglas generales de interfaz

- Toda acción destructiva (anular venta, cerrar caja, aplicar precios
  masivos) pide confirmación explícita.
- Los errores del servidor se muestran en un lenguaje que entienda alguien
  que no programa: "No hay stock suficiente: quedan 2 unidades", no
  "Error 409".
- Todo lo que espera al servidor muestra un estado de carga y bloquea el
  botón que lo disparó.
- El vendedor nunca ve, en ninguna pantalla, costos ni resultados.
