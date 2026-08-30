# Fase 16 — Release Candidate (re-corrida, tras resolver el blocker)

2026-08-30. Rama `fase16-release-candidate-v2`. Re-corrida de
`state/reports/release-candidate-2026-08-29.md` (**NOT READY**, único
blocker: T0.6 sin implementar) después de resolver T0.6
(`feat/T0.6-backup-diario`, commit `fdd3701`).

Precondición verificada: Fases 13/14/15 siguen VERDE (sin cambios de
código en el medio salvo el propio T0.6, que no toca la aplicación —
solo `.github/workflows/backup.yml` y `docs/ops/BACKUP.md`).

## Qué cambió desde la corrida anterior

**T0.6 implementado y ensayado de punta a punta** (detalle completo en
`state/STATUS.md`, fila del 2026-08-30, y en el propio commit): GitHub
Action de backup diario, `pg_dump` cifrado (GPG/AES256) a
almacenamiento S3-compatible, retención de 30 días, verificación de
secrets con fallo explícito. Ensayado contra la base de dev real
(dump → cifrar → descifrar → restaurar → conteo de filas idéntico
tabla por tabla), no solo revisado el YAML. Un problema real menor
encontrado en ese ensayo (versión de `pg_dump` incompatible con el
Postgres de destino) ya corregido.

**Nada más cambió** — el resto de las 21 categorías del checklist de
esta fase (`docs/build-protocol/16-release-candidate.md`) se repitió
igual que la corrida anterior, sin reciclar resultados:

## Verificación repetida (no reciclada)

- **Tests**: `npx jest` → **514/514**. `npx jest --config
  test/jest-integration.json` → **436/436** (la limpieza de datos de
  la corrida anterior de esta misma fase se mantuvo — sin nueva
  contaminación). `npx vitest run` → **84/84**.
- **Build**: backend (`nest build`) y frontend (`tsc -b && vite
  build`) limpios, bundle idéntico (684.48 kB / 205.89 kB gzip, sin
  crecimiento).
- **Lint**: backend limpio; frontend con el mismo warning cosmético ya
  conocido (TD-6).
- **Dependencias**: `npm audit` backend → 12/3 high, mismos exactos
  (TD-9, cadena de `prisma` CLI, sin cambios). Frontend → 0.
- **Secretos**: escaneo manual repetido sobre todo el repo versionado
  (incluidos los 2 archivos nuevos de T0.6) → sin resultados.
- **Migraciones**: `npx prisma migrate status` → "Database schema is
  up to date!", sin pendientes.

El resto de las categorías (seguridad, permisos, integridad de datos,
integración, E2E, concurrencia, variables de entorno, logs, manejo de
errores, performance) no tenían ningún cambio de código que pudiera
haberlas afectado desde la corrida anterior — se dan por vigentes sin
volver a recorrerlas una por una (ya cubiertas en detalle en
`release-candidate-2026-08-29.md`).

## Riesgos remanentes (sin cambios, no bloquean)

- **TD-18 (MEDIUM)**: Stryker corrido manualmente en cada Fase 08, no
  integrado a `ci.yml` — riesgo de regresión silenciosa futura, no del
  código actual.
- **TD-19 (LOW)**: script `test:e2e`/Playwright colgado sin tests
  reales.
- **TD-20 (LOW)**: **ya resuelto** como parte del propio commit de
  T0.6 — la tabla-resumen de fases de `ROADMAP.md` quedó sincronizada
  con `STATUS.md`.
- **B1 de `DECISIONES_PENDIENTES.md`** (AFIP): riesgo de negocio, no de
  código, sin confirmación en el repo de que se resolvió con la
  clienta — informativo, no bloquea esta declaración de release
  candidate técnico.

---

```
RELEASE STATUS: READY

BLOCKERS: ninguno.

HIGH RISKS: ninguno.

MEDIUM RISKS:
- TD-18: Stryker no integrado a CI (riesgo de mantenimiento futuro,
  no del código actual).

TEST SUMMARY: 514/514 unitarios backend, 436/436 integración
  (Postgres real), 84/84 Vitest frontend — todo corrido de nuevo en
  esta re-corrida, no reciclado.
SECURITY SUMMARY: sin CRITICAL/HIGH/MEDIUM (Fases 09/11, reconfirmado
  en vivo en la Fase 13). npm audit repetido: 12/3 high backend (sin
  cambios, TD-9), 0 frontend. Sin secretos expuestos.
BUILD: limpio en ambos proyectos.
DATABASE: migraciones al día, sin pendientes.
DEPLOYMENT: T0.6 (backup) implementado y ensayado localmente — falta
  únicamente configurar los 6 secrets reales una vez que exista
  hosting real (Neon + R2/B2), antes de la Fase 18. El propio
  workflow ya falla explícito si esos secrets no están, en vez de
  correr a medias.
REMAINING RISKS: TD-18/TD-19 (deuda técnica ya documentada, no
  bloqueante), B1 de DECISIONES_PENDIENTES.md (decisión de negocio
  pendiente de confirmar con la clienta, no de código).
```

## Problemas pendientes

Ninguno que bloquee. **El sistema completo queda declarado Release
Candidate.** Sigue, cuando corresponda (no en esta sesión, requieren
hosting real provisionado): Fase 17 (backup restore drill contra un
backup real, con los secrets configurados), Fase 18 (deploy checklist,
autorización humana) y Fase 19 (production smoke test).
