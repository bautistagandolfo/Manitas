# Fase 07 — Cierre de implementación del módulo `expenses` + `resultados`

2026-08-29. Los 9 tickets de la Etapa 6 (T6.1–T6.9) están VERDE en
`state/ROADMAP.md`.

## 1. Contraste contra `state/reports/modulo-expenses-resultados-spec.md`

Todo lo especificado en la sección 4 (Contratos de API) está
implementado:

| Contrato | Implementado en |
|---|---|
| `GET`/`POST /expense-categories`, `PATCH /expense-categories/:id` | T6.1 |
| `POST`/`GET /expenses` | T6.2/T6.3 |
| `GET /resultados` | T6.4/T6.5 |
| `GET /resultados/ranking-productos`, `GET /resultados/gastos-por-categoria` | T6.6 |
| Pantallas de gastos, resultados, configuración | T6.8/T6.9 |

**Explícitamente fuera de esta fase** (sección 4, spec): `DELETE`/baja
física de gastos o categorías — confirmado que no existe ninguna ruta
de borrado físico, correcto.

Nada de la spec quedó sin implementar.

## 2. Invariantes (sección 3 de la spec)

- **7** (solo `EFECTIVO` genera `cash_movement`; `GASTO` tiene su
  propio origen): implementado en `ExpensesService.registrarGasto`
  (T6.3), probado en unitarios (`registrarMovimiento` se llama
  exactamente para `EFECTIVO`, nunca para `TRANSFERENCIA`/`OTRO`) e
  integración (`cash_movement` real creado/ausente según el medio).
- **9** (nunca más de una sesión `ABIERTA`): no es responsabilidad de
  este módulo — delegado íntegro a `cash-register.service.ts`, sin
  lógica propia acá que pudiera romperlo.
- **10** (sesión de caja obligatoria solo si `EFECTIVO`): implementado
  y probado extensamente en T6.3 (unitario y de punta a punta,
  incluido el caso "sin ninguna sesión en el sistema, ni abierta ni
  cerrada" para `TRANSFERENCIA`/`OTRO`).

Ningún invariante de `sales`/`returns`/`stock` se toca desde este
módulo — confirmado: `resultados` solo lee, `expenses` nunca escribe
`stock_movements` ni `sale_items`/`return_items`.

## 3. Coherencia entre tickets

- **`@Roles`** consistente exacto con la tabla de permisos (spec,
  sección 8): `expense-categories` sin `@Roles` (los 3 métodos),
  `expenses` y `resultados` con `@Roles(UserRole.OWNER)` en todas sus
  rutas — verificado con un grep de los tres controllers.
- **Mensajes de error** verbatim contra la tabla de la spec (sección
  7): las 6 strings ("Categoría de gasto no encontrada", "Esta
  categoría de gasto está desactivada", "Comprar mercadería no es un
  gasto...", "Esta categoría no se puede modificar", "No hay una
  sesión de caja abierta", "El rango de fechas no es válido")
  coinciden literal entre el código y la spec.
- **Convenciones**: los tres servicios (`ExpenseCategoriesService`,
  `ExpensesService`, `ResultadosService`) siguen el mismo estilo de
  comentario ("T6.X — ..."), el mismo criterio de `Decimal` para
  dinero, el mismo patrón de `$transaction`/`RepeatableRead` para
  lecturas puras (`ResultadosService`, igual que `reconciliar()` de
  otros módulos).

## 4. Duplicación — 1 hallazgo real, corregido

`ResultadosService` repetía, idéntica, la resolución de límites +
validación de rango en sus tres métodos (`consultar`,
`rankingProductos`, `gastosPorCategoria`):

```ts
const desde = argentinaDayRangeToUtc(query.desde).desde;
const hasta = argentinaDayRangeToUtc(query.hasta).hasta;
if (desde.getTime() > hasta.getTime()) {
  throw new BadRequestException('El rango de fechas no es válido');
}
```

Unificado en un método privado `resolverRango(desdeStr, hastaStr)` que
devuelve directo el objeto `{ gte, lte }` que las tres consultas ya
armaban después. Sin cambio de comportamiento — confirmado corriendo
los 82 tests unitarios de los 4 servicios del módulo antes y después
del refactor, todos en verde sin tocar ninguna aserción.

## 5. Código muerto / `TODO`

Ninguno — `grep` de `TODO|FIXME|XXX|console\.log` sobre
`backend/src/modules/expenses/`, `backend/src/common/settings/`,
`frontend/src/features/expenses/` y `frontend/src/features/settings/`
no encontró nada.

## 6. Cobertura de tests

Exhaustiva sobre las reglas de negocio, no solo caminos felices —
construida ticket por ticket con Fase04a en los tickets de plata
(T6.2/T6.3/T6.4/T6.5/T6.6) y verificación independiente de casos
armados a mano (T6.7, sin hallazgos). Suite completa del módulo:
82 unitarios (los 4 servicios) dentro de los 496 unitarios totales del
backend; los archivos de integración del módulo (`expense-categories`,
`expenses`, `resultados`, `resultados-escenario-completo`,
`settings-controller`) dentro de los 430 de integración totales.

## Verificación

- `npx tsc --noEmit`: limpio.
- `npx jest` (suite completa): 496/496.
- `npx jest --config test/jest-integration.json` (suite completa,
  Postgres real): 430/430.
- `npx eslint "{src,apps,libs,test}/**/*.ts"`: limpio.
- `npm run build`: limpio.

## Problemas pendientes

Ninguno dentro del alcance de este módulo. **No se declara el módulo
terminado acá** — eso lo decide la Fase 12, después de QA adversarial
(Fase 08) y seguridad (Fases 09–11).
