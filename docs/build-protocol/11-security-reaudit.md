# Fase 11 — Security Re-audit

> **Antes de empezar:** verificá que la Fase 10 esté VERDE en
> `state/STATUS.md`. Si no, DETENÉTE.

Repetí la auditoría de seguridad del módulo [NOMBRE].

NO MODIFIQUES NINGÚN ARCHIVO.

Verificá específicamente contra
`state/reports/modulo-<nombre>-secaudit-<fecha>.md`:

1. Que las vulnerabilidades anteriores estén realmente corregidas.
2. Que los fixes no introduzcan nuevas vulnerabilidades.
3. Que no existan CRITICAL o HIGH adicionales.

Ejecutá las verificaciones disponibles.

Generá:

## Previous vulnerabilities
## Fixed
## Remaining
## New findings
## Security status

No declares seguro el módulo si existe una vulnerabilidad que bloquee el
Quality Gate.

> Nota de proporcionalidad: si el módulo está clasificado como riesgo BAJO
> en `MVP_SCOPE.md` y la Fase 09 no encontró ningún hallazgo, esta fase
> se puede omitir — dejalo explícito en `state/STATUS.md`
> ("Fase 11 omitida — módulo BAJO sin hallazgos en Fase 09").

---

> **Al finalizar:** guardá el resultado en
> `state/reports/modulo-<nombre>-secreaudit-<fecha>.md` y agregá una fila a
> `state/STATUS.md` (módulo [NOMBRE], Fase 11, VERDE/BLOQUEADO).
