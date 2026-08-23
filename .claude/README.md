# Guardarraíles

Estas reglas **bloquean técnicamente** al agente, no le piden que se porte
bien. Se aplican solas al abrir Claude Code en este repo.

> **Versión para Windows.** El hook de alcance por archivo (`scope-guard.sh`)
> no está incluido porque es un script de bash. Las reglas de permisos de
> abajo son nativas de Claude Code y funcionan igual en Windows.

## Qué impide `settings.json`

| Regla | Por qué |
|---|---|
| No puede editar `BLUEPRINT.md`, `MVP_SCOPE.md`, `CLAUDE.md` ni los prompts del protocolo | **La más importante.** Sin esto, ante una discrepancia entre lo que construyó y lo que dice la especificación, puede "arreglar" la especificación. La spec es la referencia: solo la cambiás vos. |
| No puede leer ni editar archivos `.env` | Secretos. |
| No puede hacer `git push` | Nada llega al remoto sin que lo mires. |
| No puede correr `rm -rf` ni `prisma migrate reset` | Borrado masivo y reseteo de base de datos. |

Puede escribir sin problema en `docs/build-protocol/state/` (STATUS,
ROADMAP, reportes): esos son los artefactos del proceso.

## Lo que reemplaza al hook que no está

El hook bloqueaba escrituras fuera del alcance del ticket. Sin él, ese
control pasa a ser manual y **es importante que lo hagas**:

Después de cada ticket, `git diff --stat`. Si aparecen archivos que el
ticket no mencionaba, algo se fue de alcance: revisalo antes de seguir.

Es el mismo control, solo que lo mirás vos.

## Lo que esto NO garantiza

- **No verifica que los tests sean buenos.** Un test que mockea todo pasa
  igual. Para eso está Stryker en la fase 08, y tu lectura de un test por
  ticket.
- **No garantiza que haya corrido los tests.** Para eso está el CI: que
  corra en cada push y que la rama principal esté protegida.
- **No evita que implemente mal la lógica.** Evita que toque lo que no
  debe, no que se equivoque en lo que sí debe.

## Si algún día pasás a WSL o Linux

Volvé a agregar el hook: está descrito en `COMO_TRABAJAR.md`, sección 6.b.

> Los formatos de configuración de Claude Code cambian con el tiempo. Si
> algo no funciona como acá se describe, revisá la documentación oficial de
> hooks y permisos.
