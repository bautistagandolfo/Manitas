# Fase 11 — Security Re-audit del módulo `expenses` + `resultados`

2026-08-29. Rama `fase11-secreaudit-expenses-resultados`, sobre Fase 10
VERDE. **Sin ningún archivo modificado** — regla de la fase.

No aplica la nota de proporcionalidad de omisión (`11-security-reaudit.md`):
`resultados` está clasificado **MEDIO** en `MVP_SCOPE.md` §5 (no BAJO), y
`expenses` mueve dinero real — el módulo corre el pipeline completo, con
la auditoría/re-auditoría ya aligerada específicamente para los
endpoints de solo lectura de `resultados` (decisión tomada en la Fase 06,
aplicada igual en la Fase 09).

`git diff` confirmado entre la Fase 08 (última con cambios de código) y
esta rama: **cero commits tocaron `backend/src`/`backend/test`** entre
la Fase 09 y la Fase 11 (Fase 10 no tuvo nada que remediar) — nada que
pudiera haber introducido una regresión desde la última auditoría.

## Previous vulnerabilities

Ninguna — la Fase 09 no encontró CRITICAL, HIGH ni MEDIUM. El único
hallazgo fue 1 LOW (TD-16, rate limiting ausente en las rutas
mutadoras), aceptado como deuda técnica documentada sin exigir
remediación (Fase 10).

## Fixed

No aplica (no había nada que corregir).

## Remaining

TD-16 (LOW) sigue como deuda técnica documentada, sin cambios — mismo
patrón transversal ya aceptado en TD-12/TD-14/TD-15 para el resto del
sistema.

## New findings

Ninguno. Reconfirmado **EN VIVO** contra el servidor real (Postgres
real, sesión OWNER real, login fresco para esta fase), mismo resultado
exacto que la Fase 09:

- Sin sesión → 401 en `/expenses`, `/resultados`, `/settings`,
  `/expense-categories`.
- `POST /expense-categories` con `Origin: https://evil.example.com` +
  cookie real → 403 "Origen no autorizado" (CSRF).
- `PATCH /expense-categories/:id` con `bloqueada` forzada en el body →
  400 "property bloqueada should not exist" (mass-assignment).
- `PATCH /expense-categories/abc` (id no numérico) → 400;
  `PATCH /expense-categories/999999` (inexistente) → 404 — ninguno 500
  (IDOR).
- `GET /resultados?desde=2026-02-30` y `GET /expenses?desde=2026-02-30`
  (fecha de calendario inválida, el fix de la Fase 08) → 400 en ambos,
  sin rollover silencioso ni 500.

`git diff` entre `backend/package.json`/`package-lock.json` de la Fase 09
y esta rama: sin cambios — no hace falta repetir `npm audit`, la
Fase 09 ya lo dejó constando con los mismos 12 advisories/3 high
(cadena de `prisma` CLI, TD-9) que viene sin cambios desde entonces.

## Security status

**Sin CRITICAL, sin HIGH, sin MEDIUM.** El único hallazgo (LOW, TD-16)
no bloquea el Quality Gate. Todas las protecciones verificadas en la
Fase 09 siguen activas y reconfirmadas en vivo, sin ningún cambio de
código de por medio que pudiera haberlas alterado.

## Verificación

- 514/514 unitarios, 436/436 integración — sin cambios desde la Fase 09
  (nada tocado en el medio).
- Servidor real levantado, las 5 verificaciones críticas de la Fase 09
  reconfirmadas en vivo con resultado idéntico.
- `backend/.env.example` no tocado.

## Problemas pendientes

Ninguno que bloquee. El módulo queda en condiciones de avanzar a la
Fase 12 (production readiness) cuando corresponda.
