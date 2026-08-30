# Fase 16 — Release Candidate

2026-08-29/30. Rama `fase16-release-candidate`. Precondición
verificada: Integration Audit (Fase 13), E2E (Fase 14) y Concurrencia
(Fase 15) VERDE en `state/STATUS.md`. Código congelado durante esta
auditoría — el único cambio de esta fase fue una **limpieza de datos**
(no de código) necesaria para que la suite de integración volviera a
correr limpia, descripta en la sección 0.

## 0. Incidente encontrado y resuelto al arrancar esta fase

Al correr la suite de integración de nuevo (regla: "no confíes
únicamente en resultados anteriores"), **6 archivos fallaron** — no por
un bug de la aplicación, sino porque mis propias pruebas manuales en
vivo de las Fases 08 a 15 (sesiones de caja, ventas, devoluciones,
gastos, categorías, un usuario `SELLER` de prueba) dejaron datos reales
en la base de desarrollo compartida, y las rutinas de limpieza de los
tests de integración (`limpiarTodasLasSesiones` y equivalentes) asumen
poder borrar **cualquier** fila de esas tablas sin que nada real la
referencie.

**Resuelto** con un script de limpieza quirúrgico (no un `prisma
migrate reset`, que el propio entorno bloqueó por seguridad — se
confirmó con el usuario antes de proceder por cualquier vía): borrado
en el orden correcto de FKs de `sales`/`returns`/`expenses`/
`cash_movements`/`cash_register_sessions` (con el mismo truco que ya
usa el propio test para sortear el trigger de inmutabilidad de
movimientos de una sesión cerrada — reabrir antes de borrar),
recálculo de `stock_actual` por variante después de quitar los
movimientos `VENTA`/`DEVOLUCION`/`ANULACION` huérfanos, y borrado de 2
usuarios y 22 categorías de gasto fijas que tests anteriores (de esta
sesión y de corridas previas) habían dejado sin limpiar. Las 6
categorías **seedeadas** (`bloqueada: true`) se conservaron intactas.
Tras la limpieza: **436/436 integración, dos corridas seguidas sin
flakes.**

Esto no revela ningún bug de la aplicación — al contrario, el trigger
de inmutabilidad y las constraints de FK que bloquearon el borrado
"a lo bruto" son, en sí mismos, la protección funcionando como se
diseñó.

## 1. Requisitos del MVP

`MVP_SCOPE.md` §3, los 6 módulos: los 6 tienen su ciclo T*.x completo +
Fases 07→12 VERDE (confirmado en `state/STATUS.md`). Sin gaps de
alcance nuevos — los ya documentados (`GET /sales`/`GET /sales/:id`,
`GET /returns`/`GET /returns/:id`, sin `DELETE` físico en ningún
módulo) siguen siendo los mismos, ya señalados y aceptados en sus
respectivas Fases 07.

## 2. `QUALITY_GATE.md`

Repasado ítem por ítem contra el estado real del repo — ver secciones
siguientes para el detalle de cada categoría. Sin CRITICAL. El único
HIGH nuevo de esta fase (sección 10, backups) se documenta como
bloqueante según la propia regla del gate ("HIGH: bloquea si afecta...
pérdida de información").

## 3. Los 6 módulos del MVP

Fase 12 = VERDE en los 6 (`auth`, `products`/`variants`+`stock`,
`cash-registers`, `sales`, `returns`, `expenses`/`resultados`) —
confirmado de nuevo contra `state/STATUS.md`.

## 4. Integración / 5. E2E / 6. Concurrencia

Fases 13/14/15 VERDE, sin hallazgos que bloqueen. No se repitieron
íntegras en esta fase (hubiera sido redundante recrear el mismo
escenario de punta a punta) — sí se repitió toda la suite automatizada
que las sostiene (sección 8).

## 7. Regresión

`npx jest` (unitarios): **514/514**. `npx jest --config
test/jest-integration.json` (Postgres real): **436/436**, corrido DOS
veces seguidas tras la limpieza de la sección 0, sin flakes. `npx
vitest run` (frontend): **84/84**.

## 8. Seguridad

Fases 09/11 (sin CRITICAL/HIGH/MEDIUM, dos rondas independientes) +
reconfirmaciones en vivo de la Fase 13 (RBAC, CSRF, mass-assignment,
IDOR) — nada cambió desde entonces (sin código tocado en las Fases
13-15). `npm audit` repetido en esta fase (no reusado de la Fase 13):
backend 12 advisories/3 high (mismos exactos, TD-9), frontend 0.
Escaneo manual de secretos repetido sobre todo el repo versionado: sin
resultados.

## 9. Permisos

Matriz RBAC de los 15 controllers, ya verificada exhaustivamente en la
Fase 13 y reconfirmada en vivo en las Fases 14/15 (sesión `SELLER`
real bloqueada de las 3 rutas `OWNER`-only, `costoActual` confirmado
ausente de la respuesta de red). Sin cambios desde entonces.

## 10. Integridad de datos

- **Constraints**: el índice único parcial de `cash_register_sessions`
  y el trigger de inmutabilidad de `cash_movements` tras el cierre
  (sección 0) reconfirmados sosteniendo la garantía incluso bajo un
  intento de borrado masivo fuera de la app.
- **Transacciones/rollback**: reconfirmado en la Fase 15 (Test B, venta
  + cierre de caja concurrentes — rollback completo de la venta
  perdedora, sin estado huérfano).
- **Concurrencia**: Fase 15, 5 escenarios, sin race conditions.
- **Migraciones**: `npx prisma migrate status` → **"Database schema is
  up to date!"**, 4 migraciones, sin pendientes.

## 11. Variables de entorno / 12. Configuración de producción

`src/config/env.schema.ts` (Zod, `validateEnv`, falla rápido al
arrancar si falta algo): 6 variables de runtime
(`NODE_ENV`/`PORT`/`DATABASE_URL`/`FRONTEND_URL`/`JWT_SECRET` con
`min(32)`/`LOG_LEVEL`) — las 6 documentadas en `backend/.env.example`,
más las 3 de semilla (`SEED_OWNER_*`, usadas solo por `seed.ts`, no
por el runtime). Sin variable usada en el código que falte en el
`.env.example`, sin variable documentada que ya no se use.

## 13. Build

Backend (`nest build`) y frontend (`tsc -b && vite build`): **limpios
los dos**, corridos de nuevo en esta fase. Bundle frontend idéntico al
ya reportado (684.48 kB / 205.89 kB gzip) — sin crecimiento desde
T6.9.

## 14. Tests / 15. Lint

Cubierto en la sección 7 (regresión) y acá: `npx tsc --noEmit`
(backend) limpio, `npx eslint` (backend) limpio, `npx tsc -b`
(frontend) limpio, `npx eslint .` (frontend) → 1 warning ya conocido y
aceptado (TD-6, cosmético).

## 16. Escaneo de dependencias vulnerables y secretos expuestos

Repetido en esta fase, no reusado de la Fase 13 (sección 8, arriba) —
mismo resultado exacto.

## 17. Logs

Sin cambios desde la Fase 09/13: logger HTTP global (`pino`), redacta
`cookie`, sin logging propio nuevo en ningún módulo.

## 18. Manejo de errores

Sin cambios desde las fases previas: ningún camino de error de negocio
devuelve 500, confirmado sistemáticamente en Fases 08/09/11/13/14/15.

## 19. Backups — **HALLAZGO NUEVO, HIGH, BLOQUEANTE**

**No existe ningún mecanismo de backup implementado.** Revisando
`state/ROADMAP.md` (Etapa 0, tabla de tickets) se encontró que **T0.6
— "Backup diario: GitHub Action con `pg_dump` cifrado a almacenamiento
externo" sigue en estado `PENDIENTE`**, nunca se construyó. Confirmado
además: `.github/workflows/` solo tiene `ci.yml` (lint/build/tests en
cada push) — ningún workflow de backup, ningún cron. No hay ningún
otro mecanismo (script, servicio externo, configuración de la base)
que lo reemplace.

**Por qué bloquea**: `QUALITY_GATE.md`, regla de bloqueo HIGH — "Bloquea
si afecta... pérdida de información". Un sistema que maneja plata real
de una tienda, sin ninguna copia de seguridad automática, expone a la
clienta a perder TODA la información del negocio (ventas, stock,
historial de precios, resultados) ante cualquier falla de la base —
sin forma de recuperarla. Esto no es un caso hipotético de "nice to
have": es exactamente el escenario que `A9`/`DECISIONES_PENDIENTES.md`
y el propio ticket T0.6 ya habían identificado como necesario antes de
producción, y quedó sin construir.

**No se corrige en esta fase** (regla: "no modifiques código" en el
Release Candidate Review) — se documenta como blocker explícito para
que se resuelva antes de la Fase 18 (Deploy checklist).

## 20. Recuperación ante fallos

Directamente ligado al hallazgo anterior — sin backup, no hay ninguna
recuperación posible ante una falla de datos. El resto de la
recuperación ante fallos de aplicación (rollback transaccional,
idempotencia, locks) está sólidamente probado (Fases 13/14/15) — el
gap es específicamente de infraestructura/operación, no de código de
aplicación.

## 21. Performance

Sin cambios desde la Fase 12 de cada módulo — TD-17 (índices de fecha
ausentes en `sales`/`returns`/`expenses`) sigue como el único hallazgo
de performance, ya documentado, no bloqueante a escala MVP.

## Otros hallazgos de esta fase (menores, no bloqueantes)

- **T0.10 — MEDIUM**: "Stryker + umbral de cobertura 80% en servicios,
  **en CI**" también sigue `PENDIENTE` en `ROADMAP.md`. Stryker SÍ se
  corrió manualmente y a fondo en cada Fase 08 de cada módulo de plata
  (confirmado exhaustivamente en el historial de esta sesión), pero
  nunca quedó integrado a `ci.yml` — un cambio futuro podría bajar la
  cobertura de mutación de un módulo ya cerrado sin que nada lo
  detecte hasta la próxima auditoría manual. No bloquea el estado
  ACTUAL del código (ya probado y verde), sí es un riesgo para el
  mantenimiento futuro.
- **T0.9 — LOW**: `seed:dev` ("datos realistas para desarrollo") nunca
  se construyó como script aparte del seed mínimo — confirmado en el
  propio comentario de `prisma/seed.ts`. Sin impacto en producción,
  solo comodidad de desarrollo.
- **LOW, cosmético**: `backend/package.json` tiene
  `"test:e2e": "playwright test"` pero no existe ningún archivo
  `*.e2e-spec.ts` en el proyecto — confirmado corriendo el comando
  (`"Error: No tests found"`). Script colgado de la Fase 00, la
  estrategia real de E2E de este proyecto siempre fue manual (Fase 14 y
  las verificaciones manuales de cada ticket de frontend). No engaña a
  nadie que no intente correrlo, pero conviene borrarlo o documentarlo.
- **LOW, cosmético**: la tabla-resumen de `state/ROADMAP.md` (la que
  lista "Fase 13… PENDIENTE" hasta "Fase 19… PENDIENTE") no se
  actualizó en paralelo a `state/STATUS.md` — desincronizada desde la
  Fase 13. `STATUS.md` es la fuente de verdad real y está al día;
  `ROADMAP.md` debería reflejarlo.

## Riesgos de negocio, no de código (informativos, ya documentados en `DECISIONES_PENDIENTES.md`)

`DECISIONES_PENDIENTES.md`, Bloque B — decisiones que necesitan a la
clienta, no al código: **B1 (¿necesita facturar legalmente, AFIP?)**
sigue explícitamente marcada como algo a "verificar... antes de
entregar" en `MVP_SCOPE.md` §4. El resto del Bloque B (B2 fía/cuenta
corriente, B3 ticket impreso, B4 origen de datos actual, B5 umbral de
diferencia de caja) parece resuelto implícitamente por lo que
efectivamente se construyó (AD-17 "no fía", `umbral_diferencia_caja`
seedeado como `Setting` real, sin soporte de impresora en el código) —
pero no hay ningún artefacto en el repo que confirme que esa
conversación con la clienta realmente ocurrió. No es verificable desde
el código; queda para quien coordine el lanzamiento confirmarlo.

---

```
RELEASE STATUS: NOT READY

BLOCKERS:
- T0.6 (backup diario) nunca implementado — sin ningún mecanismo de
  backup en todo el sistema. HIGH según QUALITY_GATE.md ("pérdida de
  información"). Bloquea hasta que se implemente (o se acepte
  explícitamente el riesgo, por escrito, con un responsable humano —
  QUALITY_GATE.md permite esa vía para un HIGH que no es CRITICAL).

HIGH RISKS:
- Ninguno adicional sin ya cubrir arriba.

MEDIUM RISKS:
- T0.10: Stryker (testing de mutación) corrido manualmente en cada
  Fase 08, pero nunca integrado a CI — riesgo de regresión silenciosa
  de cobertura de mutación en cambios futuros, no del código actual.

TEST SUMMARY: 514/514 unitarios backend, 436/436 integración
  (Postgres real, dos corridas sin flakes tras la limpieza de datos de
  la sección 0), 84/84 Vitest frontend. tsc/eslint/build limpios en
  ambos proyectos.
SECURITY SUMMARY: sin CRITICAL/HIGH/MEDIUM en dos auditorías completas
  (Fases 09/11) + reconfirmación en vivo (Fase 13). npm audit repetido
  en esta fase: 12 advisories/3 high backend (cadena de `prisma` CLI,
  TD-9, sin cambios), 0 frontend. Sin secretos expuestos (escaneo
  manual repetido, sin gitleaks disponible en el entorno).
BUILD: limpio en ambos proyectos, corrido de nuevo en esta fase.
DATABASE: 4 migraciones, "up to date", sin pendientes. Integridad y
  concurrencia probadas de punta a punta (Fases 13/14/15).
DEPLOYMENT: sin variables de entorno ni configuración de producción
  faltante en el código — el blocker de esta fase es puramente
  operacional (backups), no de código listo para desplegar.
REMAINING RISKS: T0.9 (LOW, sin seed de datos realistas para dev),
  script `test:e2e` colgado sin tests reales (LOW, cosmético),
  `ROADMAP.md` desincronizado de `STATUS.md` en su tabla resumen (LOW,
  cosmético), B1 de `DECISIONES_PENDIENTES.md` (AFIP) sin confirmación
  documentada de que se resolvió con la clienta (riesgo de negocio, no
  de código).
```

## Problemas pendientes

**El único que bloquea**: implementar T0.6 (o su equivalente — backup
automático de la base de datos con retención razonable, antes de que
haya datos reales de la clienta en producción). El resto de los
hallazgos quedan documentados en `state/TECH_DEBT.md` y no impiden
declarar el código en sí mismo listo — lo que falta es una pieza de
infraestructura, no de la aplicación.
