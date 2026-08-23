# Fase 02 — Plan de construcción

Genera o actualiza `state/ROADMAP.md`. Se ejecuta una vez al principio, y se
vuelve a correr si el alcance cambia.

> **Antes de empezar:** leé `MVP_SCOPE.md` y `BLUEPRINT.md` completos.

NO MODIFIQUES CÓDIGO.

Descomponé la construcción del MVP en tickets pequeños, en orden de
dependencias.

## Reglas de descomposición

Cada ticket debe ser:

- **pequeño** — idealmente una sesión de trabajo
- **aislable** — no depende de que otro ticket esté a medio hacer
- **verificable** — tiene un criterio de aceptación objetivo
- **reversible** — se puede revertir con `git revert` sin arrastrar otros

Para cada ticket indicá:

- **ID** (T{etapa}.{n})
- **objetivo** en una línea
- **módulo** al que pertenece
- **archivos que se espera tocar**
- **dependencias** (qué tickets deben estar VERDE antes)
- **reglas del blueprint que aplica** (referencia a la sección)
- **invariantes que debe respetar** (referencia a la sección 6)
- **tests necesarios**
- **criterio de aceptación**
- **qué NO debe hacerse en este ticket**

## Orden

Respetá las dependencias reales del sistema:

1. Cimientos (setup, modelo de datos) antes que cualquier módulo.
2. `auth` antes que todo lo demás: todos los módulos necesitan usuario y rol.
3. `products`/`variants` y el servicio de stock antes que ventas.
4. `cash-registers` **antes** que `sales`: no se puede vender sin caja
   abierta.
5. `sales` antes que `returns`: una devolución es siempre contra una venta.
6. `expenses` y `resultados` al final: consumen datos de todo lo anterior.

No combines cambios independientes en un mismo ticket.

Un ticket que toque stock, dinero o caja **nunca** se mezcla con cambios de
interfaz: van separados.

## Salida

Escribí `state/ROADMAP.md` con los tickets agrupados por etapa, cada uno con
su estado (`PENDIENTE` / `EN CURSO` / `VERDE`).

NO IMPLEMENTES NADA.

---

> **Al finalizar:** agregá una fila a `state/STATUS.md` (Fase 02, VERDE,
> referencia a `state/ROADMAP.md`).
