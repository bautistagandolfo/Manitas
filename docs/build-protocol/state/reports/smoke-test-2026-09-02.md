# Production Smoke Test — 2026-09-02

Fase 19 del protocolo de build. Corrido contra el sistema real ya
desplegado (Neon + Render + Cloudflare Pages), no un entorno de prueba.

## Resultado

```
SMOKE TEST: PASS

CRITICAL: ninguno
HIGH: ninguno
WARNINGS: ninguno
```

## Qué se verificó, punto por punto

1. **Aplicación accesible** — `https://manitas-69o.pages.dev` responde
   200, HTML real servido por Cloudflare Pages.
2. **Login** — cuenta real `estefa` (OWNER), login exitoso por la
   pantalla real, cookie de sesión recibida.
3. **Autenticación** — el dashboard cargó datos protegidos (resumen de
   caja, accesos) solo después del login; sin sesión, las rutas
   protegidas redirigen a `/login` (ya verificado en sesiones previas).
4. **Autorización básica** — se operó con la cuenta OWNER real, con
   acceso a Resultados/Configuración (rutas exclusivas de ese rol).
5. **Conexión con base de datos** — `GET /health` respondía
   `{"status":"ok","database":"up"}` durante toda la prueba.
6. **Lectura de datos** — catálogo, historial de ventas y resultados
   mostraron los datos reales recién creados, correctamente.
7. **Creación/consulta de un recurso de prueba** — producto
   "PRUEBA SMOKE TEST (borrar)" con una variante (SKU autogenerado
   `P1`), creado y consultado sin problemas.
8. **Flujo crítico principal** — de punta a punta, contra producción
   real:
   - Ingreso de mercadería (0 → 5 unidades).
   - Apertura de caja ($5.000 inicial).
   - Venta real (1 unidad, $1.000, efectivo) — SKU escaneado por
     búsqueda, cobro confirmado.
   - Verificación del monto en sistema de caja: $5.000 + $1.000 =
     $6.000 (correcto — AD-8, solo efectivo mueve la caja).
   - Cierre de caja, $6.000 declarado, sin diferencia.
   - **Hallazgo positivo de paso**: al volver a abrir caja después de
     este cierre, el sistema sugirió correctamente "$6.000,00" como
     monto inicial (función de continuidad de caja, construida en un
     ticket anterior) — primera vez que se ve funcionar con datos 100%
     reales, de punta a punta.
9. **Persistencia correcta** — Resultados mostró Ventas $1.000, Costo
   de lo vendido $500, Ganancia bruta $500 (50%), Ganancia neta $500 —
   coincide exacto con lo cargado (precio $1.000, costo $500).
10. **Logs** — sin errores en la consola del navegador durante todo el
    flujo (fuera de los 401 esperados antes de loguearse).
11. **Errores del servidor** — ninguno; y de paso, este mismo flujo
    sirvió para confirmar que Sentry (backend y frontend) no reportó
    ningún evento durante toda la operación real — consistente con que
    no hubo ningún error genuino.
12. **Estado de migraciones** — las 5 migraciones ya estaban aplicadas
    (confirmado en el log del deploy de Render, ver `STATUS.md`); no se
    aplicó ninguna nueva en esta prueba.

## Limpieza

Todo el rastro de la prueba se borró después de verificar: producto,
variante, movimiento de stock, venta, movimiento de caja, sesión de
caja. Verificado tabla por tabla contra la base real: 0 en todas salvo
la cuenta `estefa` (real), las 6 categorías de gasto de semilla y las 4
configuraciones — el sistema queda exactamente como estaba antes de la
prueba, listo para cargarse con datos reales.

**Conclusión: PASS. El sistema funciona de punta a punta en producción,
sin hallazgos que bloqueen el uso real.**

## Adenda — segunda ronda, mismo día (Gastos, movimientos manuales, Devolución)

La ronda original (arriba) cubrió el flujo principal de venta, pero no
gastos, movimientos manuales de caja, reposición de stock ni
devoluciones. Se corrió una segunda ronda, contra la misma producción
real, para cerrar esa brecha.

```
RESULTADO: PASS
CRITICAL: ninguno
HIGH: ninguno
WARNINGS: ninguno
```

1. **Apertura de caja** — $5.000 inicial.
2. **Ingreso manual** (+$1.000) — monto en sistema pasó a $6.000.
   Correcto.
3. **Retiro** (−$500) — monto en sistema pasó a $5.500. Correcto.
4. **Gasto real** — categoría "Servicios", "Prueba real - factura de
   luz", $800, Efectivo. Apareció en el listado de Gastos y el monto en
   sistema bajó a $4.700 (5.500 − 800). Correcto.
5. **Reposición de stock** — producto nuevo "PRUEBA DEVOLUCION
   (borrar)", variante suelta, Ingreso de mercadería 0 → 3 unidades.
6. **Venta real** — 1 unidad, $2.000, efectivo. Venta #1, COMPLETADA en
   Historial.
7. **Devolución real** — desde Devoluciones, venta #1 encontrada
   ("DENTRO DE PLAZO"), 1 unidad a devolver con reingreso a stock,
   reintegro $2.000 en efectivo, "Cubierto por completo". Confirmada:
   toast "Devolución #1 por $ 2.000,00".
8. **Verificación de stock reingresado** — Catálogo mostró la variante
   con stock 3 (3 inicial → 2 tras la venta → 3 tras la devolución).
   Correcto.
9. **Verificación de caja, cálculo exacto de punta a punta**:
   $5.000 + $1.000 (ingreso) − $500 (retiro) − $800 (gasto)
   + $2.000 (venta) − $2.000 (reintegro) = **$4.700,00**, que coincidió
   exacto con "Monto en sistema (en vivo)" mostrado por la app.
10. **Sin errores** — sin errores de consola ni eventos en Sentry
    durante todo el flujo.

### Limpieza

Se corrió un script de limpieza (`cleanup-round2.ts`, temporal, no
commiteado) contra la base de producción vía Prisma: borró la venta, la
devolución (con su ítem y su pago), el pago de la venta, el gasto, los 5
movimientos de caja, la sesión de caja, los 3 movimientos de stock, el
historial de precio de la variante, la variante y el producto de
prueba. Verificado después, en la app real: sin caja abierta, catálogo
vacío, historial vacío, clientes vacío — 0km otra vez.

**Conclusión: PASS. Gastos, ingreso manual, retiro, reposición de stock
y devoluciones (con reintegro en efectivo) funcionan correctamente de
punta a punta en producción, con el efecto exacto esperado en stock y
en caja. Con esto, junto con la ronda original, el flujo completo del
sistema (venta, cobro, gastos, movimientos de caja, stock, devolución)
quedó verificado en vivo, no solo por los tests automatizados.**
