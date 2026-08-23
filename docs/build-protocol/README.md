# Protocolo de construcción del MVP

Secuencia de prompts para construir el sistema de cero con un agente, sin
perder control de la calidad. Adaptado del protocolo de saneamiento: en vez
de auditar y reparar código existente, acá se **construye**, pero con las
mismas compuertas.

## Documentos de referencia (en la raíz del repo)

- **`MVP_SCOPE.md`** — qué se construye y qué no.
- **`BLUEPRINT.md`** — modelo de datos, reglas de negocio, invariantes,
  stack y patrones críticos. Es la fuente de verdad técnica.
- **`state/ROADMAP.md`** — los tickets, en orden.

## Regla de oro

**Nunca se pasa al siguiente ticket, módulo o etapa si el anterior no está
VERDE en `state/STATUS.md`.** No alcanza con "creer recordar" que se hizo.

Por eso toda fase —incluidas las de solo revisión— termina escribiendo un
artefacto en `state/reports/` y una fila en `state/STATUS.md`.

## Flujo

```
00 Setup del proyecto            ← una sola vez
01 Modelo de datos               ← una sola vez
02 Plan de construcción          ← una sola vez (genera/actualiza ROADMAP)
03 Resolución de ambigüedades    ← cuando aparezcan (requiere a la clienta)
05 QUALITY_GATE.md               ← una sola vez

── por cada módulo del ROADMAP, en orden ──
06 Especificación del módulo
04a Tests primero, en sesión aislada  ← solo plata y stock
04 Ejecución de cada ticket T#   ← se repite por ticket
08 QA adversarial
09 Security audit
10 Security remediation
11 Security re-audit
12 Production readiness
── fin del loop ──

13 Integration audit
14 E2E realista
15 Concurrencia y carga
16 Release Candidate
17 Backup restore drill + rollback
18 Deploy checklist              ← autorización humana
19 Production Smoke Test
```

## Cómo se usa

Una instrucción corta por fase, apuntando al archivo. No hace falta pegar el
contenido: el agente lo lee del repo.

```
Leé docs/build-protocol/00-project-setup.md y ejecutá esa fase.
Leé docs/build-protocol/04-ticket-execution.md y ejecutá el ticket T2.3.
Leé docs/build-protocol/06-module-spec.md y ejecutá esa fase para el módulo sales.
```

**Fases de solo lectura o planificación** (02, 06, 08, 09, 11, 12, 13):
se pueden encadenar sin revisar entre medio.

**Fases que escriben código** (00, 01, 04, 07, 10): una por vez, revisando
el `git diff` antes de pedir la siguiente.

## Modelos recomendados

- **Opus** para 01 (modelo de datos), 02 (plan), 06 (especificación de
  módulo) y 13 (integración): son decisiones de diseño.
- **Sonnet** para 04 (tickets) y el resto de la ejecución.
- En Claude Code, `/model opusplan` hace ese cambio automáticamente.

## Artefactos vivos (`state/`)

- `STATUS.md` — bitácora de qué está VERDE. Se lee al empezar, se actualiza
  al terminar.
- `ROADMAP.md` — tickets ordenados con su estado.
- `AMBIGUITIES.md` — reglas de negocio a confirmar con la clienta.
- `TECH_DEBT.md` — MEDIUM/LOW aceptados conscientemente.
- `ROLLBACK_PLAN.md` — cómo revertir un deploy.
- `reports/` — un archivo por corrida de QA/security/auditoría.

## Quién decide qué

- **Ambigüedades de negocio** (fase 03): las resuelve la clienta. El agente
  propone una recomendación, no decide.
- **HIGH que no bloquea automáticamente**: lo aprueba una persona, queda en
  `TECH_DEBT.md`.
- **Autorización de deploy** (fase 18): la da una persona. Ningún agente
  deploya solo.
