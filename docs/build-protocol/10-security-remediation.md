# Fase 10 — Security Remediation

> **Antes de empezar:** leé `state/reports/modulo-<nombre>-secaudit-<fecha>.md`.
> Si la Fase 09 no está en `state/STATUS.md`, DETENÉTE.

Corregí exclusivamente las vulnerabilidades identificadas en el Security
Audit anterior.

No implementes funcionalidades nuevas.

No modifiques problemas que no estén relacionados con las vulnerabilidades
reportadas.

Para cada vulnerabilidad:

1. Implementá el fix mínimo.
2. Agregá o actualizá tests de seguridad cuando corresponda.
3. Ejecutá los tests afectados.
4. Ejecutá la regresión relevante.
5. Ejecutá lint.
6. Ejecutá build.

No elimines ni debilites tests.

Al finalizar no declares el módulo seguro todavía.

Informá únicamente:

- vulnerabilidades corregidas
- tests
- regresión
- build
- problemas pendientes

---

> **Al finalizar:** agregá una fila a `state/STATUS.md` (módulo [NOMBRE],
> Fase 10, VERDE/BLOQUEADO, hash del último commit).
