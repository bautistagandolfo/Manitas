# QA adversarial — módulo `sales` (2026-08-25)

Fase 08 del protocolo. Objetivo: romper el módulo, no confirmar que
funciona. Alcance: T4.1–T4.11 (`SalesService`, `SalesController`,
`SalePage.tsx`/`CobroPage.tsx` y sus componentes), ya en VERDE desde la
fase 07 (`fase07-cierre-sales`).

El hallazgo de severidad real que se encontró abajo **ya está corregido y
probado** en este mismo pase, confirmado empíricamente contra Postgres
real (no solo contra el mock unitario) antes de escribir ningún test —
se reprodujo el 500 crudo primero, deshabilitando el chequeo a propósito,
después se restauró el fix y se confirmó el 400 limpio.

---

## Hallazgo — un monto/cantidad que excede la precisión de una columna tiraba 500 crudo

```
SEVERITY: MEDIUM
REPRODUCTION: POST /sales con un pago de monto "99999999999999.00", o
  con una línea de cantidad "200000000" sobre una variante de
  precioVenta "100.00" (el desborde no depende de un solo campo de
  entrada: cantidad × precioVenta, cada uno válido por separado, se
  multiplican en el subtotal de línea).
EXPECTED: 400 — un input inválido nunca debería producir un 500.
ACTUAL: 500 "Error interno del servidor", confirmado deshabilitando a
  propósito el chequeo (`return;` al principio de
  `assertDentroDePrecision`) y corriendo el test de integración contra
  Postgres real: el error crudo subyacente es
  `PostgresError { code: "22003", message: "numeric field overflow",
  detail: "A field with precision 12, scale 2 must round to an
  absolute value less than 10^10." }`, envuelto por Prisma sin ningún
  `.code` P2002/P2003 traducible — el `GlobalExceptionFilter` no puede
  distinguirlo de cualquier otro fallo interno.
ROOT CAUSE: todas las columnas de plata de `sales` son `Decimal(12, 2)`
  (`sale_items.subtotal`/`neto_linea`/`neto_unitario`,
  `sales.subtotal`/`descuento_total`/`total`, `sale_discounts.monto`,
  `payments.monto`) salvo `sale_discounts.porcentaje`, que es
  `Decimal(5, 2)`. Ningún DTO valida MAGNITUD (`@IsDecimal` valida
  formato, no rango), y a diferencia del hallazgo análogo ya corregido
  en `cash-registers` (Fase 08 de ese módulo), acá el riesgo no se
  limita a un campo de entrada gigante: un `subtotal` de línea puede
  desbordar por una `cantidad` enorme multiplicada por un
  `precioVenta` perfectamente válido, sin que ningún campo por
  separado esté fuera de rango — y la SUMA de varios valores ya
  válidos individualmente (`descuentoTotal`, `total` con un
  `ajusteRedondeo` positivo empujándolo) también puede desbordar sin
  que ninguna parte lo esté.
  Alcanzable desde la UI real: el campo "Monto" de `DiscountModal.tsx`
  (modo "Monto fijo") tiene `min={0.01}` pero ningún `max` — un valor
  absurdo se puede tipear directo. El campo "Porcentaje" sí tiene
  `max={100}`, así que ESE vector específico está bloqueado del lado
  del cliente (igual se corrigió del lado del servidor, por el mismo
  principio que el resto del sistema: la validación real vive siempre
  ahí).
FIX: nueva función local `assertDentroDePrecision()` en
  `sales.service.ts` (no se tocó `cash-register.service.ts` ni se
  agregó un helper compartido en `common/money/` — mismo alcance que
  el resto de esta fase, dentro del módulo), aplicada en seis puntos:
  el subtotal de cada línea (paso 7, cubre el caso "cantidad enorme"),
  el subtotal de la venta, el monto y el porcentaje de cada descuento
  (con un máximo distinto, `Decimal(5,2)` = 999.99), el descuento
  total, el total final, y el monto de cada pago — todos antes de
  tocar Prisma.
VERIFICADO: reproducido primero contra Postgres real (500 con el error
  crudo de arriba, deshabilitando el chequeo a propósito); revertido el
  chequeo desactivado, confirmado el 400 real con nada escrito. 4 tests
  unitarios + 1 de integración para el caso simple de entrada
  individual fuera de rango, más 2 tests unitarios adicionales para el
  caso "suma de partes válidas que desborda el agregado" (descuento
  total, total con ajuste de redondeo) — ver la sección de testing de
  mutación para el detalle completo de qué gap de cobertura cerró cada
  uno.

NOTA (mismo caveat que dejó `cash-registers` en su propio hallazgo
  análogo): `sales` es el segundo módulo con este problema encontrado y
  corregido de forma independiente, cada uno con su propia función
  local — sigue sin resolverse la pregunta de si conviene un helper
  compartido en `common/money/money.util.ts` (ambos usan el mismo
  `MAX_MONTO_ABSOLUTO`). Queda señalado, no resuelto acá — no es una
  decisión de un módulo puntual.
```

---

## Ambigüedad encontrada, no resuelta (fuera del alcance de esta fase)

Ver `state/AMBIGUITIES.md`, **AMB-15**: `crearVenta` valida
`variant.activo` (Fase 07) pero nunca trae ni chequea
`variant.product.activo` — un producto dado de baja cuya variante
sigue `activo: true` (el default) puede venderse igual por esta vía,
aunque el buscador de catálogo (RN-11, `variants.service.ts`) sí lo
excluye de la búsqueda. No hay ninguna fuente (spec de `sales`,
BLUEPRINT) que diga si esto es intencional o un gap — documentado como
ambigüedad para el PO, no corregido a ciegas (CLAUDE.md regla 2).

---

## Testing de mutación (obligatorio — BLUEPRINT §9.8 lista `sales` literal)

Corrido con Stryker sobre `src/modules/sales/**/*.service.ts`.

- **Antes** (con los tests de T4.1–T4.11 y el fix de Fase 07, antes de
  cualquier cambio de esta fase): **83.12%** (197 matados, 38
  sobrevivientes, 2 sin cobertura, 2 errores) — ya por encima del
  umbral del 80%, pero con gaps reales:
  - **2 mutantes sin cobertura, cero tests**: la rama completa que
    rechaza un descuento sin `porcentaje` NI `monto` (línea ~272) — un
    caso de validación real, en un módulo de plata, nunca ejercitado
    por ningún test unitario ni de integración en T4.3-T4.11.
  - **Gap de lógica real**: `sale.payments.some(p => metodo ===
    CREDITO_DEVOLUCION)` sobrevivía mutado a `.every(...)` — el único
    test existente de esa rama (T4.7) usa una venta con UN SOLO pago,
    donde `.some()` y `.every()` dan el mismo resultado; ninguna venta
    con pago MIXTO (una línea CREDITO_DEVOLUCION + otra EFECTIVO)
    estaba probada, así que un `.every()` que dejara anular una venta
    así (invariante 15 violada) no lo hubiera detectado ningún test.
  - **Código muerto real** (mismo patrón que la Fase 07 de este mismo
    módulo): el fallback `variant?.stockActual ?? 0` del chequeo de
    stock (paso 6) — desde que el paso 5b garantiza que todo
    `variantId` existe y está activo, ese fallback es inalcanzable.
  - **`descripcionSnapshot` con `size`/`color` null nunca probado**:
    el único assert existente era "longitud > 0" — el `.filter()` que
    evita que aparezca "null"/"undefined" o un separador huérfano
    (comentario explícito de T4.2) nunca se ejercitó con una variante
    sin talle o sin color.
  - El resto: mutaciones de la FORMA de los argumentos pasados a
    Prisma (`where`/`select`/`include` de `tx.variant.findMany`,
    `tx.sale.findUnique`, `tx.return.findFirst`) sin aserción exacta
    (mismo patrón ya visto en la Fase 08 de `cash-registers`); el
    texto de la `descripcion` de dos `cash_movement` sin verificar.
- **Después**: **100.00%** (232 matados, 0 sobrevivientes, 0 sin
  cobertura, 2 "errores" — ver nota abajo). Se agregaron:
  - El test que faltaba para "descuento sin porcentaje ni monto".
  - Un test de `anularVenta` con pago MIXTO (EFECTIVO + CREDITO_DEVOLUCION)
    que distingue `.some()` de `.every()`.
  - Dos tests de `descripcionSnapshot` (`size: null`, `size` y `color`
    ambos `null`) contra el valor exacto esperado.
  - Aserciones `toHaveBeenCalledWith(...)` exactas (no
    `objectContaining`) sobre `where`/`select`/`include` de
    `tx.variant.findMany` (`crearVenta`) y `tx.sale.findUnique`/
    `tx.return.findFirst` (`anularVenta`).
  - Aserciones sobre la `descripcion` exacta de los `cash_movement` de
    venta y de anulación.
  - Limpieza del fallback muerto del paso 6 (ver arriba).
  - Los 6 tests del hallazgo de precisión de la sección anterior, más
    2 tests nuevos para el caso "suma de partes válidas que desborda
    el agregado" (`descuentoTotal`, `total` con `ajusteRedondeo`
    empujándolo por encima del máximo aun con `subtotal` ya en el
    límite).
- **2 "errores" documentados, no forzados** (mismo criterio que
  BLUEPRINT/protocolo: "si la mutación es irrelevante, documentalo, no
  fuerces el número"): Stryker mutó los literales `'9999999999.99'` y
  `'999.99'` de las constantes `MAX_MONTO_ABSOLUTO`/
  `MAX_PORCENTAJE_ABSOLUTO` a otro texto — `new Prisma.Decimal(...)`
  con un string inválido tira `DecimalError` al cargar el módulo, antes
  de que corra ningún test. Stryker lo clasifica como "error de
  ejecución", no como "sobreviviente" ni "matado" — la mutación de
  todos modos cambia el comportamiento observable (el módulo ni
  siquiera carga), así que no representa ningún gap de cobertura real.
- Ningún mutante quedó sin clasificar por "código inalcanzable" — todos
  los sobrevivientes/sin-cobertura originales fueron matados o quedaron
  documentados arriba con su motivo.

## Otras pruebas adversariales sin hallazgos (comportamiento ya correcto)

- **Fallos a mitad de operación / rollback**: todo rechazo de
  `crearVenta`/`anularVenta` ocurre ANTES de la primera escritura
  (`tx.sale.create`/`tx.sale.update`) — confirmado leyendo el flujo
  completo y con los tests de "rechazos con rollback completo" de la
  integración (T4.1, ampliados en Fase 07 y en esta fase), que
  verifican explícitamente que no quedó ninguna fila en
  `sales`/`stock_movements`/`cash_movements` tras cada rechazo.
- **Datos huérfanos**: la reproducción a propósito del hallazgo de
  precisión (con el chequeo desactivado) no dejó ninguna fila creada —
  Postgres rechaza el `INSERT` completo, la transacción de Nest
  revierte todo.
- **Requests duplicados (doble click real)**: cubierto por T4.5
  (`Idempotency-Key`, mismo patrón `withIdempotency` que el resto del
  sistema) — el `unique` de `sales.idempotency_key` hace que un
  segundo intento concurrente con la misma clave, si el primero ya
  escribió, devuelva la venta original en vez de un error o una
  duplicada. Reconfirmado leyendo el código, sin cambios en esta fase.
- **IDOR / recursos ajenos**: no aplica — no existe "mi venta" vs "la
  de otro vendedor" (spec sección 8, tabla de permisos: "sin
  restricción de 'mis ventas'"). Mismo criterio ya aceptado en
  `cash-registers`.
- **Manipulación de IDs**: un `variantId` que no existe (o que existe
  pero pertenece a otra tienda — no aplica, single-tenant) da 400 "no
  existe", nunca 500 ni un 409 confuso (Fase 07, RN-2). Un `saleId`
  inexistente en `anularVenta` da 404 explícito.
- **Autorización server-side**: `esOwner` siempre se deriva de
  `user.rol` (JWT verificado por `AuthGuard` global), nunca de un
  campo del body — `CreateSaleDto` no tiene ningún campo `esOwner`, y
  si el cliente lo manda igual, `forbidNonWhitelisted` (pipe global) lo
  rechaza con 400 antes de llegar al handler. `SalesController.crear()`
  no tiene `@Roles()` a propósito (RN-1: "cualquiera autenticado, es
  el trabajo del vendedor") — confirmado que `RolesGuard` sin
  `@Roles()` en la ruta exige solo estar autenticado, no un rol
  específico.
- **Mass assignment**: `CreateSaleDto`/`SaleItemDto`/`SaleDiscountDto`/
  `SalePaymentDto` no exponen `id`, `subtotal`, `total`,
  `descripcionSnapshot`, `precioUnitario`, `costoUnitario`,
  `autorizadoPorUserId` ni ningún otro campo calculado por el
  servidor — un body con esos campos de más da 400
  (`ValidationPipe` global, mismo mecanismo ya probado en otros
  módulos).
- **SQL injection**: los dos `$queryRaw` del módulo (lock de sesión de
  caja, lock de variantes por id) usan template tags parametrizados de
  Prisma; los ids que entran ahí ya pasaron por `@IsInt()` +
  `transform: true` del DTO, nunca un string sin validar.
- **UI — doble click / doble submit**: el botón "Confirmar venta" de
  `CobroPage.tsx` se deshabilita (`disabled={... || submitting}`,
  `loading={submitting}`) apenas se aprieta — confirmado en código,
  sin cambios desde T4.11.
- **UI — error de servidor no rompe la pantalla**: `handleConfirmarVenta`
  captura cualquier `ApiError` y lo muestra en un `Alert`
  (`submitError`) sin perder el estado del carrito/borrador —
  confirmado en código; un 400 "El monto del descuento ... es
  demasiado grande" (el hallazgo de esta fase) se mostraría ahí igual
  que cualquier otro rechazo de negocio, sin pantalla en blanco.
- **Descuento con porcentaje/monto fuera de rango de negocio (no de
  precisión)**: un porcentaje negativo o un `monto` negativo por
  descuento individual está bloqueado del lado del cliente
  (`DiscountModal.tsx`: `min={0.01}` en ambos modos) y, aunque no hay
  un `CHECK` de base ni una validación de servidor por descuento
  INDIVIDUAL (solo sobre el AGREGADO — `descuento_total >= 0 AND
  descuento_total <= subtotal`, invariante 4, con `CHECK` de base como
  segunda barrera), la combinación que haría falta para explotarlo
  (dos descuentos que se cancelen, uno con signo "de más" y otro "de
  menos") requiere un request armado a mano, fuera de lo que exige la
  spec del módulo (RN-4 solo habla del agregado) — documentado acá,
  no tratado como hallazgo bloqueante porque no hay ninguna fuente que
  diga que cada descuento individual necesita su propio signo
  validado; si el PO confirma que sí, es un ticket nuevo, no un
  arreglo de esta fase (mismo criterio que AMB-15).

## Resultado de validación (después de esta fase)

- Unitarios: **336/336** (`npm run test`).
- Integración (Postgres real): **284/284** (`npm run test:integration`),
  confirmado en dos corridas independientes tras un falso negativo por
  contención de recursos (un test de `auth` no relacionado, timeout de
  5s, corriendo Stryker y la suite de integración en simultáneo — no
  reproducible corriendo la suite sola).
- `tsc --noEmit`: limpio.
- `npm run lint`: limpio.
- `npm run build` (`nest build`): limpio.
- Mutación (Stryker, `sales/**/*.service.ts`): **100.00%** (era
  83.12%), 232 matados, 0 sobrevivientes, 0 sin cobertura.

No se declara el módulo terminado — eso lo decide la Fase 12
(production readiness).
