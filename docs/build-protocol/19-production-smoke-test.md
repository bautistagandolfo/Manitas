# Fase 19 — Production Smoke Test

> **Antes de empezar:** verificá que la Fase 18 esté VERDE en
> `state/STATUS.md` (el deploy efectivamente se hizo). Si no, DETENÉTE.

El sistema acaba de ser desplegado en producción.

Quiero realizar un Production Smoke Test.

NO realices cambios de código.

Verificá únicamente los flujos críticos y de bajo riesgo.

Comprobá:

1. Aplicación accesible.
2. Login.
3. Autenticación.
4. Autorización básica.
5. Conexión con base de datos.
6. Lectura de datos.
7. Creación/consulta de un recurso seguro de prueba.
8. Flujo crítico principal.
9. Persistencia correcta.
10. Logs.
11. Errores del servidor.
12. Configuración esencial.
13. Estado de migraciones.

No ejecutes operaciones destructivas ni utilices datos reales
innecesariamente.

Si existe un entorno o mecanismo de datos de prueba, utilizalo.

Al finalizar:

```
SMOKE TEST: PASS / FAIL

CRITICAL: ...
HIGH: ...
WARNINGS: ...
```

Si existe un problema que pueda afectar dinero, stock, datos,
autenticación, autorización o disponibilidad, marcar FAIL.

Si el resultado es FAIL, consultá inmediatamente `state/ROLLBACK_PLAN.md` y
notificá al responsable definido ahí — no esperes a que alguien pregunte.

---

> **Al finalizar:** guardá el resultado en
> `state/reports/smoke-test-<fecha>.md` y agregá una fila a
> `state/STATUS.md` (Fase 19, PASS/FAIL, referencia al reporte). Si es
> PASS, el saneamiento del MVP está formalmente cerrado.
