# Fase 04a — Tests primero, en sesión aislada

**Obligatoria** para los tickets de `sales`, `returns`, `cash-registers` y el
servicio de stock. Opcional en el resto.

Esta fase se ejecuta en una **sesión propia**, distinta de la que después
implementa. Ese aislamiento es el punto: si la misma sesión escribe el
código y el test, el test verifica *lo que el código hace* en vez de *lo que
debería hacer*, y un malentendido queda confirmado en verde por partida
doble.

---

## Restricción central

**NO leas ninguna implementación.** No abras archivos de `src/modules/`
salvo interfaces o tipos estrictamente necesarios para compilar. Si la
implementación existe, no la mires.

Tu única fuente de verdad es:

1. El ticket en `state/ROADMAP.md`.
2. Las secciones del `BLUEPRINT.md` que el ticket referencia.
3. `state/reports/modulo-<nombre>-spec.md` (fase 06).
4. Los invariantes de la sección 6 del blueprint.

Si algo de esas fuentes es ambiguo o insuficiente, **paralo y reportalo**.
No lo resuelvas mirando el código: eso es exactamente lo que esta fase
existe para evitar.

---

## Qué escribir

Los tests que describen el comportamiento esperado del ticket:

- **Camino feliz**, derivado de la regla de negocio del blueprint.
- **Casos borde** listados en la especificación del módulo.
- **Invariantes** que el ticket toca (sección 6), verificados
  explícitamente.
- **Errores esperados**: qué debe rechazarse y con qué error.
- **Concurrencia**, cuando el ticket toca stock o caja: tests de
  integración contra Postgres real, nunca mockeado.

Escribí las aserciones desde la especificación, en lenguaje de negocio:
*"vender 3 unidades de una variante con stock 2 debe rechazarse y no debe
generar ningún movimiento de stock"* — no desde la forma que tendría una
implementación.

---

## Validación

1. Ejecutá los tests.
2. **Tienen que fallar todos.** Un test que pasa antes de existir la
   implementación está mal escrito: no está verificando nada.
3. Confirmá que fallan por la razón correcta (falta la funcionalidad), no
   por un error de compilación o de importación.

---

## Restricciones

- No implementes **nada** de la funcionalidad.
- No modifiques archivos fuera de la carpeta de tests.
- No debilites un test para que compile más fácil.

---

## Respuesta

```
[T#] tests escritos: N casos. Todos en rojo, por ausencia de implementación.
```

O bien:

```
BLOQUEADO — el blueprint no define [X]. Necesita resolverse antes.
```

---

> **Al finalizar:** commit solo con los tests (en rojo), y una fila en
> `state/STATUS.md`.
>
> **Antes de implementar (fase 04):** commiteá los tests en rojo. Si la
> sesión que implementa modifica un test, va a aparecer en el `git diff` y
> vas a saber que aflojó la expectativa en vez de arreglar el código.
