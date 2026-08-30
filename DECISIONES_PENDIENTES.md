# Decisiones a cerrar antes de escribir código

Checklist de todo lo que conviene dejar resuelto antes de la primera línea.
Organizado por **quién decide** y por **qué tan caro es cambiarlo después**.

Leyenda de costo de cambio tardío:

- 🔴 **Toca el modelo de datos** — cambiarlo después implica migrar datos.
- 🟡 **Toca la construcción** — cambiarlo después implica rehacer trabajo.
- 🟢 **Aditivo** — se puede agregar más adelante sin dolor.

---

## BLOQUE A — Las decide el equipo técnico (ya propuestas)

No necesitan a la clienta. Están resueltas con un criterio y solo hace falta
que las valides.

### A1 🔴 Zona horaria

**Decisión:** toda agrupación por día, mes o período se hace en
`America/Argentina/Buenos_Aires`, no en UTC.

**Por qué importa:** los timestamps se guardan en UTC. Sin esta regla, una
venta de las 22:00 cae en el día siguiente y los totales diarios quedan mal
todas las noches, peleados con el cierre de caja.

**Implementación:** las consultas de reportes convierten explícitamente
(`fecha AT TIME ZONE 'America/Argentina/Buenos_Aires'`). Un test verifica
que una venta a las 23:30 pertenece al día correcto.

### A2 🔴 Redondeo

**Decisión:**

- Todos los importes se redondean a **2 decimales** con redondeo comercial
  (medio hacia arriba).
- El descuento porcentual se calcula y **se redondea antes** de restarse, de
  modo que `total = subtotal − descuento_total` siempre cierre exacto.
- Se admite una línea de ajuste **"redondeo"** en la venta (por defecto
  desactivada) para cuando en el mostrador se cobra la cifra redondeada.

**Por qué importa:** un 15% sobre $2.999 da $449,85 y el total $2.549,15. Si
se cobran $2.549, la suma de pagos deja de igualar al total y el sistema
rechaza una venta normal (rompe el invariante 3).

### A3 🔴 Talles y colores con lista predefinida

**Decisión:** `talle` y `color` salen de listas administrables, no de texto
libre.

**Por qué importa:** con texto libre, en un mes el catálogo tiene "M", "m",
"Mediano" y "MED" como cosas distintas. El stock deja de ser confiable y los
reportes por talle no sirven.

### A4 🔴 Registro de cambios de precio y costo

**Decisión:** tabla `price_history` que registra variante, precio o costo
anterior, nuevo, usuario y fecha.

**Por qué importa:** con dos usuarios y plata de por medio, "¿quién cambió
este precio y cuándo?" aparece sí o sí. Reconstruirlo después es imposible.

### A5 🟡 Actualización masiva de precios

**Decisión:** entra al MVP. Permite subir un porcentaje a un conjunto de
variantes (por marca, categoría o selección), con vista previa antes de
aplicar y registro en `price_history`.

**Por qué importa:** en Argentina los precios se actualizan seguido. Hacerlo
variante por variante sobre cientos de artículos es inviable: si no está,
vuelve a la planilla.

### A6 🟡 Precios finales, con IVA incluido

**Decisión:** `precio_venta` es el precio final al consumidor. No se
discrimina IVA en el MVP.

**Consecuencia:** compatible con factura B a futuro. Si alguna vez necesita
**factura A**, hay que discriminar IVA por ítem y eso no se puede
reconstruir hacia atrás (ver B1).

### A7 🟡 Sesión de caja olvidada abierta

**Decisión:** al abrir el sistema, si hay una sesión abierta de un día
anterior, se avisa y se obliga a cerrarla antes de operar. No se cierra
sola: el arqueo lo tiene que hacer una persona.

**Por qué importa:** si no, las ventas de hoy caen en el turno de ayer y
ningún arqueo cierra nunca.

### A8 🟡 Venta con producto no catalogado

**Decisión:** **no** se permite. Todo lo que se vende tiene que existir como
variante.

**Por qué importa:** una "venta libre" sin producto rompe el control de
stock y ensucia el cálculo de costo — justo las dos cosas que la clienta
quiere. Si aparece la necesidad, se carga el producto en el momento.

### A9 🟢 Monitoreo

**Decisión:** Sentry (plan gratuito) para errores + UptimeRobot para caída
del servicio, con alerta por mail. Se configura antes de salir a producción.

**Por qué importa:** hoy, si se cae un sábado a la tarde, te enterás porque
te llama tu clienta.

### A10 🟢 Riesgo del módulo `resultados`

**Decisión:** baja de ALTO a **MEDIO** en el tiering del protocolo. Es solo
lectura y solo lo ve la dueña: su riesgo real son los cálculos equivocados,
no la seguridad. Se refuerza el QA de cálculo y se aligeran la auditoría de
seguridad y su re-auditoría.

**Por qué importa:** ahorra dos fases completas sin resignar nada relevante.

---

## BLOQUE B — Necesitan a la clienta

Estas no las puede decidir nadie más. Ordenadas por impacto.

### B1 🔴 ¿Necesita facturar legalmente? (AFIP)

**Preguntar también al contador.**

- Si **hoy no** pero **en 6 meses sí**: se agrega como módulo aparte, es
  limpio. Pero las ventas de esos meses **no se pueden facturar
  retroactivamente**.
- Si alguna vez necesita **factura A** (vender a empresas), hay que
  discriminar IVA por ítem **desde el principio** — hacia atrás no se
  reconstruye.

**Resuelto (2026-08-30):** por el momento no se necesita. No bloquea
la salida a producción del MVP tal como está. Si la clienta empieza a
facturar más adelante, revisar esta decisión antes de agregar ese
módulo (ver la advertencia de arriba sobre retroactividad).

### B2 🔴 ¿Fía? ¿Vende en cuenta corriente?

**Es la que más puede cambiar el alcance.**

Si le vende a clientas que pagan después, el MVP necesita `customers` y
cuenta corriente. Si no está, va a seguir anotando en un cuaderno y el
sistema no le va a cerrar la caja nunca.

Si la respuesta es sí, hay que decidir si entra al MVP o si se acepta
conscientemente que esas ventas queden fuera del sistema al principio.

### B3 🟡 ¿Le da ticket impreso al cliente?

Determina si hay que soportar impresora térmica (58 u 80 mm) o alcanza con
mostrar el detalle en pantalla.

**Resuelto (diferida, AMB-9 en `docs/build-protocol/state/AMBIGUITIES.md`):**
no se construye soporte de impresora térmica para tickets de venta en el
MVP — queda en pantalla. Es aditivo, se agrega después si hace falta.
Nota aparte, distinta de esto: sí está en conversación un módulo de
**etiquetas de código de barras** (para tagear mercadería, no para el
ticket de venta) — en pausa hasta confirmar qué impresora compra la
clienta.

### B4 🟡 ¿Con qué maneja hoy el catálogo y el stock?

Excel, papel, otro sistema, o nada. Define el formato de la importación
inicial y cuánto trabajo va a ser cargar todo.

### B5 🟢 Umbral de diferencia de caja

A partir de qué diferencia entre lo contado y lo del sistema se exige
justificar por escrito.

### B6 🟢 Confirmar las decisiones de la sección 11 del `BLUEPRINT.md`

Devoluciones (plazo, con ticket), descuentos del vendedor (tope del 10%),
venta sin stock (bloqueada), diferencia de caja.

---

## BLOQUE C — A definir juntos antes de llegar ahí

### C1 🟡 Flujo de la pantalla de venta

Hoy el blueprint es exhaustivo en datos y mudo en interfaz. En un punto de
venta, la pantalla de cobrar **es** el producto.

Hay que definir el flujo pensado para **teclado y lector, sin mouse**:
escanear o buscar, agregar, escanear el siguiente, cobrar, listo. Incluye
qué pasa al escanear algo inexistente, cómo se cambia una cantidad, cómo se
aplica un descuento y cómo se elige el medio de pago, todo sin soltar el
lector.

**Se puede cerrar mientras se construyen los cimientos**, pero tiene que
estar definido antes del ticket T4.9.

### C2 🟡 Carga inicial de datos

El sistema arranca vacío y hay que cargar cientos de variantes con stock y
costo. Sin una importación cómoda, el lanzamiento se cae por agotamiento, no
por un error.

Hace falta: importación por CSV (productos, variantes, stock inicial,
costos), validación con reporte de errores línea por línea, y una forma
práctica de hacer el conteo inicial de stock.

**Es un ticket nuevo de la Etapa 2**, no un extra.

---

## Resumen de qué hacer ahora

1. **Validar el Bloque A** (10 decisiones ya propuestas). Si estás de
   acuerdo, se actualizan `BLUEPRINT.md` y `ROADMAP.md`.
2. **Llevarle el Bloque B a la clienta.** Son seis preguntas y se responden
   en una charla. **B1 y B2 son las que pueden cambiar el alcance**, así que
   idealmente antes de escribir código.
3. **El Bloque C se cierra durante la Etapa 0/1**, mientras se construyen
   los cimientos.

**Solo B1 y B2 justifican frenar el arranque.** El resto se puede resolver
en paralelo a las primeras etapas sin costo.
