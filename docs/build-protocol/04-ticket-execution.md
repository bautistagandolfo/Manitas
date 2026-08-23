# Fase 04 — Ejecución de un ticket

Se reutiliza para cada ticket del `ROADMAP.md`.

> **Antes de empezar:** leé `state/STATUS.md` y `state/ROADMAP.md`. Si las
> dependencias de este ticket no están VERDE, o depende de una ambigüedad
> PENDIENTE en `state/AMBIGUITIES.md`, DETENÉTE e informá el bloqueo.

Implementá únicamente el ticket **[T#]** del roadmap.

### CONTEXTO OBLIGATORIO

Antes de escribir código, leé:

1. El ticket completo en `state/ROADMAP.md`.
2. Las secciones del `BLUEPRINT.md` que el ticket referencia.
3. Los **invariantes** (blueprint sección 6) que este ticket debe respetar.
4. `QUALITY_GATE.md`.

Si algo del blueprint es ambiguo o parece incompleto, **paralo y reportalo**.
No improvises una interpretación: el blueprint se corrige primero.

### ALCANCE

- Implementá **solo** este ticket. No avances al siguiente.
- Mantenete en los archivos previstos, salvo que el ticket indique otra cosa.
- No implementes funcionalidades de tickets futuros "ya que estoy".
- No refactorices código fuera del alcance.

### REGLAS NO NEGOCIABLES

Vienen del blueprint y aplican siempre:

- Toda operación que toque **stock, dinero o caja** va dentro de una
  transacción de base de datos.
- El descuento de stock **bloquea las filas de las variantes ordenadas por
  id** antes de leer el stock (blueprint 9.4). Nunca validar fuera de la
  transacción.
- **Solo `stock.service.ts`** escribe `stock_movements` y toca
  `stock_actual`.
- Los importes se operan con `Decimal`. **Prohibido convertir a `number`**
  para hacer cuentas.
- Precio y costo se **congelan** en la línea de venta (AD-5).
- La autorización se verifica **en el servidor**, siempre.
- La lógica de negocio vive en servicios, no en controllers ni en el
  frontend (AD-9).

### VALIDACIÓN

1. Escribí los tests **antes o junto** con la implementación.

   **Si el ticket pertenece a `sales`, `returns`, `cash-registers` o al
   servicio de stock:** los tests ya fueron escritos en la fase 04a, en una
   sesión aparte. **No los modifiques.** Tu trabajo es hacer que pasen
   implementando la funcionalidad, no ajustar la expectativa.

   Si un test te parece equivocado, **paralo y reportalo** — puede que la
   especificación esté mal, y eso se corrige en el blueprint, no en el test.
2. Si el ticket toca un invariante de la sección 6, escribí un test que lo
   verifique explícitamente.
3. Ejecutá los tests afectados.
4. Ejecutá la suite completa (regresión).
5. Ejecutá lint.
6. Ejecutá build.
7. Verificá con `git diff --stat` que no haya cambios fuera del alcance.

Si algo falla: investigá la causa raíz, corregila **solo si pertenece a este
ticket**, y repetí la validación. Si la causa está fuera del alcance,
reportala y detenete.

### GIT

- Rama `feat/T{n}-{slug}`.
- Commits chicos y descriptivos, revertibles de forma aislada.

### RESPUESTA — AHORRO DE TOKENS

Si todo sale bien:

`[T#] listo. Tests verde. Lint verde. Build verde.`

Si hay un error que no pudiste resolver:

`ERROR — [archivo]: [causa raíz]`

Si estás bloqueado por el blueprint o una ambigüedad:

`BLOQUEADO — [motivo]`

---

> **Al finalizar:** actualizá el estado del ticket en `state/ROADMAP.md` y
> agregá una fila a `state/STATUS.md` con el ID, resultado y hash del commit.
