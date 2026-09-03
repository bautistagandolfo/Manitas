# ROLLBACK_PLAN

Generado en la Fase 17 (2026-09-02), después de que la Fase 16 dio READY.
Cubre el release desplegado a producción el 2026-09-01/02 (Neon + Render +
Cloudflare Pages, commit `e1192ba`).

## Resultado del ensayo de restauración de backup

**Ensayado de verdad, contra el backup real de producción (no un mock):**

1. Se disparó `backup.yml` a mano (`workflow_dispatch`) contra la base de
   Neon real — terminó en verde: `pg_dump` → cifrado GPG (AES256) → subida
   a Backblaze B2 (`manitas-backups`, bucket privado, cifrado SSE-B2
   encima) → limpieza de backups vencidos (no había ninguno, es el primer
   backup).
2. Se confirmó en el bucket: `manitas-backup-2026-09-02.sql.gpg`, 7.6 KB
   (no vacío).
3. Se descargó ese archivo real usando la API nativa de B2 (keyID +
   applicationKey de los secrets), se descifró con
   `BACKUP_ENCRYPTION_PASSPHRASE`, y se restauró contra un Postgres 16
   **temporal y aislado** (contenedor Docker aparte, nunca el de
   desarrollo ni el de producción) — 2193 líneas de SQL, sin errores.
4. Los datos restaurados se compararon con lo que se sabía que había en
   producción en ese momento: `users` (1), `expense_categories` (6),
   `settings` (4), `products`/`sales`/`customers` (0 los tres) —
   **coincidencia exacta**. Se verificó además el contenido de la fila de
   `users` (no solo la cantidad): `estefa | Estefa | OWNER`, intacto.
5. Limpieza: contenedor temporal borrado, archivo descifrado borrado del
   disco — no quedó ningún dato de producción residual fuera de donde
   corresponde (Neon + el propio backup cifrado en B2).

**Conclusión: el mecanismo de backup y restauración funciona de punta a
punta contra datos reales.** No es solo teoría — se probó.

## Cómo revertir el código (versión/tag/artefacto anterior)

- **Backend (Render):** cada deploy queda listado en la pestaña
  "Events"/deploy history del servicio, identificado por el commit de
  `main`. Para revertir: abrir el deploy anterior conocido como bueno y
  usar "Redeploy" sobre ese commit específico — Render reconstruye ese
  código y lo pone en producción. Alternativa equivalente: `git revert`
  del/de los commit(s) problemáticos sobre `main` y `git push` — el
  Auto-Deploy ("On Commit") dispara solo.
- **Frontend (Cloudflare Pages):** cada deployment queda con su propia
  URL inmutable en la pestaña "Deployments" del proyecto. Cloudflare
  Pages permite promover directamente un deployment anterior a
  producción ("Rollback"/"Retry"/similar en esa pantalla) sin necesidad
  de un nuevo build — es el camino más rápido de los dos.

## Cómo revertir las migraciones de este release

**No son reversibles automáticamente** — Prisma (`migrate deploy`) solo
sabe aplicar migraciones hacia adelante; este proyecto no mantiene
scripts de "down migration" a mano.

**Mitigación:** la Fase 18 (checklist de deploy) ya exige tomar un backup
fresco inmediatamente antes de aplicar cualquier migración nueva. Si una
migración deja la base en mal estado, el camino real de reversión es
restaurar ese backup pre-migración (mismo mecanismo recién probado
arriba), no intentar escribir un `DOWN` improvisado bajo presión.

**Nota real sobre compatibilidad hacia atrás:** revertir solo el código
(sin restaurar la base) funciona bien si la migración fue aditiva (columna
nueva, tabla nueva) — el código viejo simplemente la ignora. Si la
migración borró o renombró algo que el código viejo necesita, revertir
solo el código no alcanza y hace falta restaurar la base también.

## Cómo desactivar funcionalidades nuevas rápidamente (feature flags/config)

**No existe un sistema de feature flags en este proyecto.** Lo más
cercano es la tabla `settings` (pantalla Configuración, solo OWNER):
`permitir_venta_sin_stock`, `max_descuento_vendedor_pct`,
`dias_plazo_devolucion`, `umbral_diferencia_caja` — estos 4
comportamientos puntuales se pueden cambiar en caliente, sin deploy.
Cualquier otra funcionalidad nueva que haya que desactivar requiere un
rollback de código completo (ver arriba), no hay un interruptor
intermedio.

## Tiempo estimado de rollback completo

- **Rollback de código, frontend:** ~1-2 minutos (promover un deployment
  ya construido en Cloudflare Pages).
- **Rollback de código, backend:** ~2-4 minutos (Render reconstruye el
  commit anterior — build + migrate + seed + arranque, mismo orden que
  cualquier deploy normal).
- **Si además hace falta restaurar la base:** el ensayo de hoy (bajar +
  descifrar + restaurar) tardó bien menos de un minuto de punta a punta
  — pero era una base casi vacía (7.6 KB). Con datos reales de la tienda
  ya cargados (miles de ventas, stock, etc.), estimar **10-15 minutos**
  para el mismo proceso, siendo conservador.
- **Total estimado:** 5 minutos si alcanza con revertir código; hasta
  ~20 minutos si además hace falta restaurar datos.

## Quién está autorizado a decidir un rollback

**Confirmado con el usuario (2026-09-02): Bautista Gandolfo** —
desarrollador/operador técnico del sistema, único con acceso a las
cuentas de Render, Cloudflare, Neon y GitHub. La clienta no tiene
credenciales técnicas ni las necesita: si algo falla, Bautista es quien
decide y ejecuta la reversión. Comunicación con la clienta: contacto
directo y constante, sin necesidad de un canal formal aparte.
