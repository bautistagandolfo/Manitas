# Fase 09 — Security Audit

> **Antes de empezar:** verificá en `state/STATUS.md` que la Fase 08 de este
> módulo esté VERDE. Si no, DETENÉTE.

Realizá una auditoría de seguridad completa del módulo [NOMBRE].

NO MODIFIQUES CÓDIGO.

Revisá frontend y backend.

Evaluá:

1. Authentication
2. Authorization
3. Access control
4. Privilege escalation
5. IDOR
6. Input validation
7. SQL injection
8. XSS
9. CSRF cuando corresponda
10. SSRF cuando corresponda
11. Path traversal
12. Sensitive information exposure
13. Secrets
14. Logs
15. Error handling
16. Rate limiting cuando corresponda
17. Dependencies
18. Sensitive data storage
19. Incorrect permissions
20. Unauthorized endpoints

No asumas que las protecciones existentes son correctas.

Clasificá:

CRITICAL
HIGH
MEDIUM
LOW

Para cada vulnerabilidad:

- ubicación
- causa
- impacto
- escenario de explotación
- solución recomendada

NO CORRIJAS NADA.

No declares el módulo seguro si existe una vulnerabilidad que bloquee el
Quality Gate.

---

> **Al finalizar:** guardá el resultado en
> `state/reports/modulo-<nombre>-secaudit-<fecha>.md` y agregá una fila a
> `state/STATUS.md` (módulo [NOMBRE], Fase 09, VERDE/BLOQUEADO).
