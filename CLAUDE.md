# Contexto del proyecto

Sistema de gestión y punto de venta para una tienda de indumentaria.

## Documentos de referencia — leer antes de trabajar

- `MVP_SCOPE.md` — qué entra en el MVP y qué no.
- `BLUEPRINT.md` — **fuente de verdad técnica**: modelo de datos, reglas de
  negocio, invariantes, stack, patrones críticos y flujos de interfaz.
- `docs/build-protocol/` — protocolo de construcción. Una fase por archivo.
- `docs/build-protocol/state/ROADMAP.md` — tickets en orden.
- `docs/build-protocol/state/STATUS.md` — qué está VERDE.

## Reglas permanentes

1. **Antes de cualquier fase o ticket, leé `state/STATUS.md`.** Si la
   dependencia previa no está VERDE, detenete e informá el bloqueo.
2. El `BLUEPRINT.md` manda. Si algo es ambiguo o parece faltar, **paralo y
   reportalo** — no improvises una interpretación.
3. Toda operación que toque stock, dinero o caja va **dentro de una
   transacción**, y el stock se bloquea por fila ordenado por id
   (BLUEPRINT §9.4).
4. Solo `stock.service.ts` escribe movimientos de stock.
5. Los importes se operan con `Decimal`, **nunca con `number`**, y se
   redondean según las reglas de BLUEPRINT §9.3.
6. Toda agrupación por día o período se calcula en hora argentina
   (`America/Argentina/Buenos_Aires`), nunca en UTC.
7. La autorización se verifica siempre en el servidor.
8. Los tests se escriben **en el mismo ticket** que el código. Un ticket no
   cierra sin ellos. No se eliminan ni debilitan tests existentes.
9. Formatos siempre es-AR mediante los helpers comunes (BLUEPRINT §12.3).
   Prohibido formatear moneda o fecha a mano en un componente.
10. Un ticket por vez. No adelantes trabajo de tickets futuros.
