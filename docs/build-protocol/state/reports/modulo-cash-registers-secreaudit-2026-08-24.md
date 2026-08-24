# Security Re-audit — módulo `cash-registers` (2026-08-24)

Fase 11 del protocolo. **Sin archivos modificados** (regla explícita
de la fase). Verificación independiente contra
`state/reports/modulo-cash-registers-secaudit-2026-08-24.md` (fase
09), con re-chequeos empíricos en vivo, no solo relectura del reporte
anterior.

Confirmado primero que no hubo ningún cambio de código entre la fase
09 y esta verificación: `git log fase09-secaudit-cash-registers..fase10-secremediation-cash-registers -- backend/src backend/prisma frontend/src`
no devuelve ningún commit — la fase 10 fue enteramente documentación
(`TECH_DEBT.md`, `STATUS.md`), sin tocar código. El estado auditado en
la fase 09 es exactamente el estado actual.

## Previous vulnerabilities

La fase 09 no encontró ningún CRITICAL/HIGH/MEDIUM. Encontró 2 LOW:

1. Header `Idempotency-Key` sin cota de longitud (infraestructura
   compartida de `common/idempotency/`).
2. Sin rate limiting en `POST /cash-registers/movements/ingreso`/
   `retiro`.

## Fixed

Ninguna — no había nada CRITICAL/HIGH/MEDIUM que corregir, así que la
fase 10 no tuvo ningún fix de código dentro de su alcance (confirmado:
cero commits de código entre fase 09 y fase 10). Lo único que hizo la
fase 10 fue registrar formalmente las 2 LOW en `state/TECH_DEBT.md`
(TD-11, TD-12) — un requisito del propio `QUALITY_GATE.md`, no una
corrección de vulnerabilidad.

## Remaining

Las 2 LOW siguen exactamente igual (ni agravadas ni resueltas, ahora
con seguimiento formal en TECH_DEBT.md):

- **TD-11** — `Idempotency-Key` sin cota de longitud. Riesgo bajo
  reconfirmado: el valor nunca se ejecuta ni se interpreta.
- **TD-12** — sin rate limiting en movimientos manuales. Riesgo bajo
  reconfirmado: ya exige sesión `OWNER` autenticada, mismo criterio
  que `products`/`stock`.

Ninguna de las dos bloquea el Quality Gate (`QUALITY_GATE.md`: "LOW:
Pueden permanecer como deuda técnica documentada").

## New findings

Ninguno. Re-chequeos empíricos específicos de este módulo, corridos
de nuevo contra el servidor real (no solo releídos del reporte de la
fase 09):

- **Autenticación**: `GET /cash-registers/sessions/open` sin cookie →
  **401** (reconfirmado en vivo).
- **CSRF**: `POST /cash-registers/sessions` con
  `Content-Type: application/x-www-form-urlencoded` → **415**
  (reconfirmado en vivo, mismo resultado que la fase 09).
- **Headers de seguridad**: `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN` presentes, `X-Powered-By` ausente en
  una respuesta real del módulo (reconfirmado en vivo).
- **RN-6 (cierre a ciegas)**: los 12 tests de integración que cubren
  el ocultamiento de `montoSistema`/`diferencia` para SELLER, más el
  cálculo correcto para OWNER, corridos de nuevo — **12/12 verde**,
  contra Postgres real.
- **Los 2 hallazgos de la fase 08** (validación de magnitud/signo de
  montos, corregidos ahí, no en esta fase): los 3 tests de integración
  específicos ("Fase 08 — QA adversarial: validación de magnitud")
  corridos de nuevo — **3/3 verde**. Los fixes de la fase 08 siguen
  vigentes y no se revirtieron ni debilitaron en ningún commit
  posterior.
- Casos límite de manipulación de IDs (sesión inexistente → 404,
  sesión ya cerrada → 409) reconfirmados dentro de la misma corrida.

Sin código modificado en esta fase, así que no hay superficie nueva
que un fix pudiera haber introducido — el checklist "que los fixes no
introduzcan nuevas vulnerabilidades" (punto 2 de esta fase) se
satisface trivialmente: no hubo ningún fix de código en la fase 10 que
auditar por posibles regresiones.

## Security status

**Sin CRITICAL ni HIGH, ni antes ni ahora.** Las 2 LOW siguen
documentadas y no bloqueantes. Nada que remediar quedó sin remediar
(no había nada que remediar). El módulo pasa la fase 11 con
verificación empírica, no solo por ausencia de cambios.

**El módulo `cash-registers` queda en condiciones de avanzar a la
fase 12 (production readiness) cuando corresponda** — no se declara
terminado ni "listo para producción" acá, eso lo decide
específicamente la fase 12.
