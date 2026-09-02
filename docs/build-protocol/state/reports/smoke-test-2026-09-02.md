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
