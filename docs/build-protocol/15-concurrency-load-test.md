# Fase 15 — Prueba de concurrencia y carga

> **Antes de empezar:** verificá que la Fase 14 esté VERDE en
> `state/STATUS.md`. Si no, DETENÉTE.

Quiero probar el sistema bajo concurrencia real antes del Release
Candidate.

Enfocate en las operaciones que tocan dinero, stock o estado compartido:
venta, entrada/salida de stock, apertura/cierre de caja, devoluciones.

Simulá:

- múltiples ventas simultáneas del mismo producto con stock limitado
- cierre de caja mientras hay una venta en curso
- doble submit de la misma operación (reintento de red / doble click)
- dos usuarios operando la misma caja o el mismo producto al mismo tiempo

Para cada escenario verificá el ESTADO PERSISTIDO REAL en la base de
datos, no la respuesta HTTP ni lo que muestra la UI:

- stock final correcto (sin decremento doble, sin negativo)
- caja consistente (sin duplicar ni perder movimientos)
- ninguna venta duplicada
- ninguna operación en estado intermedio/huérfano

Documentá cualquier race condition con reproducción exacta (script o
pasos), clasificada CRITICAL/HIGH/MEDIUM/LOW igual que las auditorías
previas.

NO MODIFIQUES CÓDIGO.

---

> **Al finalizar:** guardá el resultado en
> `state/reports/concurrency-<fecha>.md` y agregá una fila a
> `state/STATUS.md` (Fase 15, VERDE/BLOQUEADO).
