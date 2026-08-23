# STATUS

Bitácora única de avance del protocolo. Toda fase la lee antes de empezar y
la actualiza al terminar. Si algo no está VERDE acá, no pasó — no importa
lo que diga la conversación.

Resultados posibles: `VERDE`, `BLOQUEADO`, `VERDE CON DEUDA` (pasó, pero
dejó MEDIUM/LOW documentados en `TECH_DEBT.md`).

| Fecha | Fase / Módulo | Resultado | Referencia | Responsable |
|---|---|---|---|---|
| _ejemplo_ 2026-08-16 | Fase 0.0 — Inventario de módulos | VERDE | `state/MODULES.md` | agente |
| 2026-08-20 | Fase 00 — Setup del proyecto | VERDE | commit pendiente (repo local sin commitear todavía — lo hace el usuario) | agente |
| 2026-08-23 | Fase 01 — Modelo de datos | VERDE | `backend/prisma/schema.prisma`, `backend/prisma/migrations/20260823002959_init/`, `backend/prisma/seed.ts`, `backend/test/integration/schema-constraints.integration.spec.ts` — commit pendiente (lo hace el usuario) | agente |
| 2026-08-23 | Fase 02 — Plan de construcción | VERDE | `state/ROADMAP.md` — revisado contra `MVP_SCOPE.md` y `BLUEPRINT.md`; T0.1–T0.5 y T0.8 pasan a VERDE (ya hechos en fases 00/01); se agregan T0.11–T0.14 (helpers es-AR, helpers de Decimal/redondeo, `settings`, interceptor de idempotencia) y T6.9 (pantalla de configuración), que faltaban en la versión original — commit pendiente (lo hace el usuario) | agente |
| 2026-08-23 | Fase 03 — Ambigüedades (Paso 1: compilar y recomendar) | VERDE | `state/AMBIGUITIES.md` — 10 ambigüedades de BLUEPRINT §11 compiladas con pregunta cerrada, recomendación y riesgo. 3 ya RESUELTAS (AMB-1, AMB-7 con caveat, AMB-8), 7 PENDIENTES de respuesta del PO (AMB-2 a AMB-6, AMB-9, AMB-10) — la Etapa 5 completa, T3.4, T4.1, T4.3 y T0.13 (valor real de `umbral_diferencia_caja`) quedan BLOQUEADOS hasta el Paso 2 — commit pendiente (lo hace el usuario) | agente |
| 2026-08-23 | Fase 03 — Ambigüedades (Paso 2: resolver) | VERDE | `state/AMBIGUITIES.md` — las 7 PENDIENTES quedan RESUELTAS: AMB-2 a AMB-5 y AMB-9 aprobadas según recomendación; AMB-6 (costeo por último costo) confirmada explícitamente aparte por ser ⚠️ ALTO RIESGO; AMB-10 (umbral de diferencia de caja) sin recomendación previa, definida por el PO en **$500** fijos. Las 10 ambigüedades de BLUEPRINT §11 quedan cerradas: ningún ticket del `ROADMAP.md` sigue bloqueado por ambigüedad — commit pendiente (lo hace el usuario) | agente |
| 2026-08-23 | Fase 05 — Quality Gate | VERDE | `QUALITY_GATE.md` — commit pendiente (lo hace el usuario) | agente |
| 2026-08-23 | Fase 06 — Spec del módulo `auth` | VERDE | `state/reports/modulo-auth-spec.md` — sin ambigüedades de negocio pendientes; corregido T1.2 (8h→12h, BLUEPRINT §9.6) y ampliado T1.1 en `ROADMAP.md`; hallazgo fuera de alcance reportado (falta ticket de importación CSV en Etapa 2, `DECISIONES_PENDIENTES.md` Bloque C2) — commit pendiente (lo hace el usuario) | agente |
| 2026-08-23 | T1.1 — Usuarios (`auth`) | VERDE | commit `3fc165d` en rama `feat/T1.1-usuarios` — 10 tests unitarios + 8 de integración en verde, lint y build en verde. De paso corrigió un bug real: `ValidationPipe`/`GlobalExceptionFilter` no corrían en tests de integración por estar registrados solo en `main.ts` (movidos a `APP_PIPE`/`APP_FILTER` en `AppModule`) | agente |
| 2026-08-23 | T1.2 — Login + JWT + logout (`auth`) | VERDE | commit `2e9f3b5` en rama `feat/T1.2-login` (ramificada de `feat/T1.1-usuarios`, todavía sin mergear a `main`) — 5 tests unitarios + 6 de integración en verde, lint y build en verde. Sin `GET /auth/me` ni guards: quedan para T1.3 | agente |
| 2026-08-23 | T1.3 — Guards + RolesGuard + `GET /auth/me` (`auth`) | VERDE | commit `fd69e5f` en rama `feat/T1.3-guards` (ramificada de `feat/T1.2-login`, todavía sin mergear a `main`) — 9 tests unitarios + 7 de integración nuevos, 28/28 tests de integración totales en verde, lint y build en verde. `/users` ahora exige `OWNER`; `/health`, login y logout quedan `@Public()` | agente |
| 2026-08-23 | T1.4 — Login + sesión + rutas protegidas (frontend, `auth`) | VERDE | commit `b0024ca` en rama `feat/T1.4-login-frontend` (ramificada de `feat/T1.3-guards`, todavía sin mergear a `main`) — lint y build en verde; probado a mano en navegador real (login incorrecto/correcto, persistencia tras F5, logout, bloqueo de ruta protegida). Sin tests automatizados de frontend (no hay Vitest instalado). **Etapa 1 (`auth`) completa: T1.1–T1.4 en VERDE.** Sigue el cierre de módulo: fases 07→08→09→10→11→12 | agente |

<!--
Agregá una fila nueva por cada fase/ticket/módulo completado. No edites
filas viejas salvo para corregir un error de tipeo — el historial completo
es el punto.
-->
