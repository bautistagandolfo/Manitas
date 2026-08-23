# Fase 07 — Cierre de implementación del módulo

Los módulos se construyen **ticket por ticket** con
`04-ticket-execution.md`. Esta fase se ejecuta cuando **todos los tickets
del módulo están VERDE**, para verificar que el módulo quedó completo y
coherente como unidad.

> **Antes de empezar:** verificá en `state/ROADMAP.md` que todos los tickets
> del módulo [NOMBRE] estén VERDE. Si falta alguno, DETENÉTE.

Verificá el módulo **[NOMBRE]** como conjunto:

1. Contrastá lo implementado contra `state/reports/modulo-<nombre>-spec.md`.
   ¿Quedó algo de la especificación sin implementar?
2. ¿Se respetan todos los invariantes que el módulo toca?
3. ¿Los tickets construidos por separado quedaron **coherentes entre sí**
   (nombres, contratos, manejo de errores, convenciones)?
4. ¿Hay duplicación entre tickets que convenga unificar?
5. ¿Quedaron `TODO`, código muerto o comentado?
6. ¿La cobertura de tests cubre las reglas de negocio, no solo los caminos
   felices?

Corregí únicamente inconsistencias **dentro de este módulo**. No expandas el
alcance ni toques otros módulos.

Ejecutá: tests del módulo, suite completa, lint, build.

Al finalizar informá:

- funcionalidades de la spec implementadas / faltantes
- inconsistencias corregidas
- tests agregados
- resultado de tests, lint y build
- problemas pendientes

**No declares el módulo terminado**: eso lo decide la fase 12 (production
readiness), después de QA adversarial y seguridad.

---

> **Al finalizar:** agregá una fila a `state/STATUS.md` (módulo [NOMBRE],
> Fase 07, VERDE/BLOQUEADO).
