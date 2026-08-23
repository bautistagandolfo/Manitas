# Fase 06 — Especificación del módulo

Se ejecuta **antes** de empezar los tickets de cada módulo. Reemplaza a la
"auditoría de módulo" del protocolo de saneamiento: acá no hay código que
auditar todavía, hay que bajar el blueprint a detalle implementable.

> **Antes de empezar:** verificá en `state/STATUS.md` que los módulos de los
> que depende éste estén VERDE. Leé las secciones del `BLUEPRINT.md`
> correspondientes.

NO ESCRIBAS CÓDIGO.

Especificá en detalle el módulo **[NOMBRE]** antes de construirlo.

Producí:

## 1. Responsabilidad
Qué hace y qué **no** hace este módulo. Dónde termina su frontera.

## 2. Reglas de negocio
Todas las que aplican, tomadas de la sección 5 del blueprint, bajadas a
casos concretos y verificables.

## 3. Invariantes
Cuáles de la sección 6 del blueprint toca este módulo, y cómo se garantiza
cada uno.

## 4. Contratos de API
Endpoints con método, ruta, payload de entrada, respuesta, códigos de estado
y rol requerido.

## 5. Transacciones y concurrencia
Qué operaciones necesitan transacción, cuáles necesitan bloqueo de filas, y
en qué orden se toman los bloqueos.

## 6. Edge cases
Casos límite reales: cantidades en cero, stock justo, operaciones
simultáneas, valores extremos, datos faltantes, operación repetida.

## 7. Errores
Qué puede fallar, qué error se devuelve, y qué ve la persona en pantalla.

## 8. Permisos
Qué puede hacer `OWNER` y qué puede hacer `SELLER`, endpoint por endpoint.

## 9. Tests necesarios
Unitarios, de integración y E2E, incluyendo los de invariantes y los de
concurrencia si corresponde.

## 10. Ambigüedades
Cualquier regla que el blueprint no define con precisión. **Marcala en
`state/AMBIGUITIES.md` con una recomendación, y no la resuelvas por tu
cuenta** — la decide la clienta (fase 03).

## 11. Tickets
Confirmá o ajustá los tickets de este módulo en `state/ROADMAP.md`.

---

No asumas que algo es obvio porque está en el blueprint: el objetivo de esta
fase es que al empezar a implementar no queden decisiones por tomar.

NO IMPLEMENTES NADA.

---

> **Al finalizar:** guardá el resultado en
> `state/reports/modulo-<nombre>-spec.md` y agregá una fila a
> `state/STATUS.md`. Si quedaron ambigüedades PENDIENTES, el módulo queda
> BLOQUEADO hasta resolverlas.
