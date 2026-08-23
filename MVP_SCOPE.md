# MVP_SCOPE.md

Documento de alcance del MVP. Define **qué** se construye. El **cómo** está
en `BLUEPRINT.md`.

Si algo no está en este documento, no se construye en la v1.

---

## 1. Qué es el producto

Sistema de gestión y punto de venta para **tiendas de indumentaria y calzado
independientes de Argentina**, de un solo local.

La primera clienta es el primer usuario real, no un caso aparte: el producto
se valida poniéndola a operar en producción. Cada funcionalidad que se
construya sin una tienda real que la necesite es una apuesta.

**Fuera del mercado objetivo:** cadenas grandes con ERP propio o
integraciones corporativas. Diseñar para ese rango empeora el producto para
el segmento real.

---

## 2. El problema que resuelve

La dueña no pidió un sistema de ventas. Pidió **saber si gana plata y
cuánto**. El punto de venta es el medio para capturar los datos que
responden esa pregunta.

Las tres cosas que necesita:

1. **Control del movimiento de dinero** — qué entró, qué salió, cuánto hay.
2. **Control de stock** — qué tiene y qué se vendió.
3. **Resultados** — si gana o pierde, y cuánto.

Si hay que elegir entre una funcionalidad linda de venta y la precisión del
cálculo de resultado, gana el resultado.

---

## 3. Alcance del MVP (v1)

Seis módulos. Criterio de corte: *¿puede operar un día completo sin planilla,
cuaderno ni papel, y saber al final del mes si ganó?*

### 3.1 `auth`
Login. Dos roles: **dueño** (`OWNER`) y **vendedor** (`SELLER`). El vendedor
no ve costos, resultados, totales de cierre ni gestión de usuarios.

### 3.2 `products` / `variants`
Producto con **variantes** (talle / color) — en indumentaria la variante es
la unidad real de venta y de stock. Stock por variante. **Precio de costo**
además del precio de venta. Marca y categoría para poder filtrar. Código de
barras buscable; el mismo buscador acepta texto tipeado y lectura de
scanner. Incluye ingreso de mercadería con costo y ajuste manual de stock.

### 3.3 `sales`
Venta con N ítems, N descuentos y N pagos. Descuenta stock generando
movimientos con motivo. Congela precio y costo en cada línea.

### 3.4 `cash-registers`
Apertura y cierre de caja con arqueo. Movimientos de efectivo. Solo el
efectivo mueve la caja: una venta con tarjeta no entra al cajón.

### 3.5 `returns`
Devolución y cambio contra una venta existente, con reingreso de stock
(salvo mercadería fallada) y reintegro en efectivo.

### 3.6 `resultados`
Ingresos − costo de la mercadería vendida − gastos, por período. Incluye el
registro de **gastos**, que pueden pagarse en efectivo desde la caja o por
fuera (transferencia), porque el alquiler también resta aunque no pase por
el cajón.

---

## 4. Fuera de alcance de la v1

Nada de esto se construye ahora. Se agrega cuando **un cliente real lo
pida**, con el modelo ya preparado para recibirlo (ver sección 8 del
`BLUEPRINT.md`).

| Módulo | Motivo |
|---|---|
| `layaways` (señas) | Reserva de stock, pagos parciales y política de abandono. Confirmado fuera. |
| `gift-cards` | Es un método de pago más — el modelo de venta ya lo contempla. |
| `discount-codes` | Es un descuento más — el modelo de venta ya lo contempla. |
| `customers` y cuenta corriente | **Confirmado: la clienta no fía**, siempre cobra en el momento (AD-17). |
| Multi-sucursal | Un solo local. Agregarlo después es una migración mecánica. |
| Multi-tenant | Una instancia por cliente. Se revisa a los ~10-15 clientes. |
| `tags`, `materials`, `seasons` | Metadata de catálogo. No impide vender ni un día. |
| Facturación fiscal (AFIP) | Proyecto propio. **Verificar si la clienta la necesita legalmente antes de entregar.** |
| Operación offline | Requiere conexión para vender. Riesgo aceptado. |
| E-commerce | Previsto como extensión, no construido. |

---

## 5. Clasificación de riesgo (para el protocolo)

| Módulo | Riesgo | Motivo |
|---|---|---|
| `auth` | **ALTO** | Autenticación y autorización. |
| `products` / `variants` | **ALTO** | En retail el stock **es** plata. |
| `sales` | **ALTO** | Dinero. |
| `cash-registers` | **ALTO** | Dinero. |
| `returns` | **ALTO** | Dinero + stock. |
| `resultados` | **MEDIO** | Es solo lectura y solo lo ve la dueña: su riesgo real son los **cálculos equivocados**, no la seguridad. |

Cinco módulos corren el pipeline completo del protocolo, sin atajos.

**`resultados` es la excepción:** se refuerza el QA de cálculo (fase 08) y se
aligeran la auditoría de seguridad y su re-auditoría (fases 09 y 11), que
sobre un módulo de lectura con una sola verificación de rol aportan poco.
Ahorra dos fases completas sin resignar nada relevante.

---

## 6. Decisiones de negocio tomadas por defecto

Están resueltas en el `BLUEPRINT.md` (sección 11) con el criterio más
conservador del rubro, para no frenar el desarrollo. **Conviene validarlas
con la clienta antes de construir cada módulo.**

Las dos que más urge confirmar:

- **¿Necesita facturar legalmente?** Si la respuesta es sí, el MVP no le
  sirve tal como está definido.
- **¿Se corta seguido internet en el local?** Si la respuesta es sí, no va a
  poder cobrar durante los cortes.

---

## 7. Criterio de MVP entregable

El MVP está listo cuando la clienta puede:

1. Abrir caja al empezar el día.
2. Cargar un producto nuevo con variantes, stock y **costo**.
3. Vender (buscando o escaneando), cobrando por uno o más medios de pago,
   con el stock descontándose correctamente.
4. Procesar una devolución o cambio, con el stock volviendo.
5. Registrar un gasto, se haya pagado de la caja o por transferencia.
6. Cerrar caja y ver el arqueo cuadrado.
7. **Ver, para un mes, cuánto vendió, cuánto le costó esa mercadería, cuánto
   gastó y cuánto ganó.**

...y hacerlo un día completo sin recurrir a papel ni planilla.

Además, dos capacidades sin las cuales el sistema se abandona aunque
funcione:

8. **Cargar la tienda rápido**: alta de variantes por grilla (talles ×
   colores generadas de una vez), porque hoy no tiene nada digitalizado.
9. **Remarcar precios en bloque**: aplicar un porcentaje a un conjunto de
   productos con vista previa. Sin esto vuelve a la planilla en el primer
   ajuste de precios.

---

## 8. Nota sobre el protocolo

El proyecto arranca **de cero**, no saneando un sistema existente:

- Las fases de auditoría inicial (00 a 07 de
  `docs/development-protocol/`) **no aplican**: no hay código heredado que
  auditar.
- Este documento y el `BLUEPRINT.md` cumplen el rol de la Fase 0.1
  (arquitectura objetivo).
- El sistema anterior queda como **banco de repuestos**: sirve para reusar
  reglas de negocio ya resueltas, no para heredar su estructura.
- El trabajo arranca construyendo los cimientos (`auth` + modelo de datos
  base) y sigue con los módulos de negocio, cada uno con su ciclo completo.
