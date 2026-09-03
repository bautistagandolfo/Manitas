# DEPLOY_CHECKLIST

Fase 18 del protocolo de build. El deploy en sí ya se hizo (Neon +
Render + Cloudflare Pages, 2026-09-01/02 — ver `STATUS.md`); este
checklist es el cierre formal, ahora que las Fases 17-19 están
completas, antes de darle luz verde a la clienta para operar con datos
reales.

- [x] **Release Candidate con status READY** (Fase 16). Confirmado en
      `STATUS.md` — última re-corrida, sin CRITICAL ni HIGH.
- [x] **`state/ROLLBACK_PLAN.md` existe y fue probado** (Fase 17).
      Ensayo real de backup + restauración contra producción, exitoso —
      ver la fila de STATUS.md del 2026-09-02.
- [x] **Variables de entorno de producción configuradas, sin valores de
      default/dev, sin secretos expuestos en el repo.**
      `DATABASE_URL`, `JWT_SECRET` (generado, no reusado de dev),
      `FRONTEND_URL`, `SENTRY_DSN`, `SEED_OWNER_*` — todas cargadas en
      el dashboard de Render, ninguna en el repositorio.
      `VITE_API_URL`, `VITE_SENTRY_DSN` — cargadas en Cloudflare Pages,
      mismo criterio. Confirmado con `grep` que ningún secreto real
      quedó en el código ni en `.env.example` (que solo tiene claves,
      sin valores).
- [x] **Migraciones identificadas y en orden, con backup fresco tomado
      inmediatamente antes de aplicarlas.**
      Las 5 migraciones existentes ya se aplicaron en el primer deploy
      (`prisma migrate deploy`, dentro del Start Command de Render).
      **Nota honesta:** ese primer deploy fue *antes* de que el
      mecanismo de backup existiera — no hubo backup previo a esa
      aplicación inicial (la base estaba vacía, sin datos reales en
      juego). De acá en adelante, cualquier migración nueva sí debe
      seguir la regla: backup fresco primero (mecanismo ya probado y
      funcionando).
- [x] **Monitoreo/alertas configurados para los flujos críticos** (venta,
      caja, stock, autenticación). Sentry captura cualquier error no
      manejado en cualquiera de esos módulos automáticamente (backend y
      frontend, verificado en vivo contra producción). UptimeRobot
      cubre disponibilidad del backend cada 5 minutos.
- [x] **Ventana de deploy y responsable de guardia definidos.**
      Confirmado con el usuario (2026-09-02): **Bautista Gandolfo**, único
      con acceso técnico a Render/Cloudflare/Neon/GitHub. Sin ventana de
      deploy formal — el sistema ya está en producción, deploys futuros
      son auto-deploy desde `main` en cualquier momento, revisados por
      Bautista antes de cada push.
- [x] **Escaneo de dependencias/secretos corrido y sin hallazgos
      CRITICAL.** `npm audit` en ambos proyectos: backend 0 critical (5
      low/4 moderate/5 high — deuda técnica ya documentada, TD-9, sin
      cambios), frontend 0 vulnerabilidades. Sin secretos en el repo
      (confirmado a lo largo de toda la sesión, cada commit).
- [x] **Plan de comunicación si algo sale mal.**
      Confirmado con el usuario (2026-09-02): contacto directo y
      constante entre Bautista y la clienta — sin necesidad de un canal
      formal aparte.

## Autorización

**La autorización de deploy la da explícitamente una persona
responsable, citando este checklist en verde — ningún agente
autodeploya a producción.**

Los 8 ítems de arriba están en verde.

**Autorizado por Bautista Gandolfo, 2026-09-02** ("autorizo", confirmado
explícitamente en el chat). El sistema (Neon + Render + Cloudflare
Pages) queda formalmente autorizado para operar con datos reales — cierra
la Fase 18, y con ella, la Etapa 7 completa del protocolo de build.
