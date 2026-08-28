# Security Audit — módulo `returns` (2026-08-28)

Fase 09 del protocolo. Precondición verificada: Fase 08 VERDE
(`state/STATUS.md`, commit `8edce86`). **Sin código modificado** —
regla de la fase.

Alcance: `ReturnsController`/`ReturnsService`/`CreateReturnDto`
(backend), la extensión de T5.8 en `SalesController`/`SalePaymentDto`
(`returnId`), y `DevolucionPage.tsx`/`CobroPage.tsx`/
`PaymentLinesBuilder.tsx` (frontend). Verificaciones EN VIVO contra el
servidor real (Postgres real) cuando fue posible, no solo lectura de
código — mismo criterio que las Fases 09 de `sales`/`cash-registers`.

---

## 1. Authentication

Las 3 rutas de `ReturnsController` (`GET /returns/sales/:numero`,
`GET /returns/:numero/credito`, `POST /returns`) pasan por `AuthGuard`
global — sin `@Public()` en ningún método. **Reconfirmado EN VIVO**:
las 3 rutas, sin cookie, responden `401` (curl directo contra el
servidor real). Sin hallazgos.

## 2. Authorization

RN-1 (spec sección 4): "cualquiera autenticado" para crear devolución
— sin restricción de rol, correcto según spec. `esOwner` se resuelve
siempre de `user.rol === 'OWNER'` (JWT verificado), nunca del body —
**reconfirmado EN VIVO**: `POST /returns` con `esOwner: true` forjado
en el body → `400 "property esOwner should not exist"`
(`forbidNonWhitelisted`, antes de llegar al handler). Sin hallazgos.

## 3. Access control

`costoUnitario` en `GET /returns/sales/:numero`: presente solo para
`OWNER` (`incluirCosto: user.rol === UserRole.OWNER`), **ausente** (no
`null`) del JSON para `SELLER` — confirmado por código y por el test
unitario de Fase 08 (`hasOwnProperty` false). Sin hallazgos.

## 4. Privilege escalation

Fuera de plazo sin autorización: `SELLER` rechazado con 400/403
(`esOwner` resuelto del JWT real, no manipulable — ver sección 2).
`GET /returns/:numero/credito` y "aplicar crédito" (T5.8) son
deliberadamente sin restricción de rol (RN-10, sección 8 de la spec:
"es cobrar, no autorizar nada") — decisión de negocio ya documentada,
no una escalada de privilegios real. Sin hallazgos.

## 5. IDOR

El modelo de negocio es "tienda única, cualquier empleado autenticado
ve/opera cualquier venta o devolución" (spec sección 8, "sin
restricción de mis devoluciones") — no una vulnerabilidad dado ese
contexto, ya documentado.

**El hallazgo real de esta categoría se encontró y corrigió en la Fase
08** (manipulación de IDs: `saleItemId` de una venta ajena a la
`saleId` declarada, severidad HIGH — ver
`state/reports/modulo-returns-qa-2026-08-28.md`). **Reconfirmado EN
VIVO en esta fase, contra el servidor real, sin tocar código**: dos
ventas genuinas creadas por HTTP (`saleId` 9181/$100 y 9182/$250),
`POST /returns` con `saleId: 9181` + `saleItemId` de la línea de 9182
→ `400 "La línea 8440 no existe en esta venta"`. El fix de la Fase 08
sigue corregido.

## 6. Input validation

`class-validator` en `CreateReturnDto`/`ReturnItemDto`/
`ReturnPaymentDto`/`ReturnVentaNuevaDto` (tipos, `@Min(1)`,
`@ArrayMaxSize`, `@IsDecimal`) y en `SalePaymentDto.returnId`
(`@IsInt`). Sin hallazgos nuevos — ya probado exhaustivamente en
T5.7/T5.8.

## 7. SQL injection

El lock manual (`$queryRaw` en `crearDevolucion`, pasos 2 y 4) usa
`Prisma.join()` para parametrizar los IDs — nunca concatenación de
strings crudos. El resto de las queries usa el query builder de Prisma
(parametrizado por diseño). Sin vector de inyección.

## 8. XSS

API JSON pura del lado backend, sin renderizado de HTML. Frontend:
`DevolucionPage.tsx`/`CobroPage.tsx`/`PaymentLinesBuilder.tsx` usan
JSX/React (escapa por defecto) — sin `dangerouslySetInnerHTML` en
ninguno de los tres archivos. Sin hallazgos.

## 9. CSRF

`OriginCheckMiddleware` (global, `forRoutes('*')`, construido en la
Fase 10 de `sales`) cubre `returns` sin necesitar nada nuevo.
**Reconfirmado EN VIVO contra el servidor real**:

- `POST /returns` con `Origin: https://evil.example.com` + cookie real
  → `403 "Origen no autorizado"`, antes de tocar la sesión o el
  negocio.
- `POST /returns` con `Origin` legítimo (`FRONTEND_URL` real) → pasa
  el chequeo de Origin, llega a la validación de negocio (`400`, DTO
  vacío — el camino esperado).
- Los dos `GET` (`/returns/sales/:numero`, `/returns/:numero/credito`)
  no son bloqueados por `Origin` cross-site — comportamiento heredado
  y ya aceptado del middleware (solo protege métodos mutadores;
  lecturas puras no mueven dinero ni estado). No es un hallazgo nuevo
  de `returns`, es el diseño ya auditado en `sales`.

Sin hallazgos.

## 10. SSRF

No aplica — `returns` no realiza peticiones salientes a URLs externas
ni acepta URLs como input en ningún campo.

## 11. Path traversal

No aplica — sin manejo de archivos ni rutas de filesystem en este
módulo.

## 12. Sensitive information exposure

`costoUnitario`/margen: ya cubierto (sección 3). Mensajes de error:
contrastados literalmente contra la tabla de la spec en la Fase 07 —
ninguno expone detalle interno (SQL, stack trace, nombres de tabla).
`GlobalExceptionFilter` (global, ya auditado en `auth`) sanitiza
cualquier error no controlado. Sin hallazgos.

## 13. Secrets

Sin secretos hardcodeados en ningún archivo de `returns` tocado por
T5.1–T5.8 (inspección directa de los 9 archivos backend + 6 frontend).

## 14. Logs

El logger HTTP global (`nestjs-pino`) ya redacta cookies/headers
sensibles (`LOG_REDACT_PATHS`, auditado en la Fase 09 de `auth`) —
aplica igual a las rutas de `returns`, confirmado en los logs reales
capturados durante las pruebas en vivo de esta fase (`cookie`
aparece como `"[REDACTED]"`). Sin logging custom en el módulo.

## 15. Error handling

Errores de negocio (`BadRequestException`/`NotFoundException`/
`ConflictException`) con mensajes ya contrastados contra la spec
(Fase 07). Errores no controlados pasan por `GlobalExceptionFilter`
(sanitizado, ya auditado). Sin hallazgos.

## 16. Rate limiting

**Hallazgo — SEVERITY: LOW (extiende TD-12/TD-14, no nuevo en
esencia).** `POST /returns` (cualquier usuario autenticado, mueve
dinero y stock) no tiene `@nestjs/throttler` — el único endpoint con
rate limiting en todo el backend sigue siendo `/auth/login`. Mismo
patrón exacto ya aceptado para `/cash-registers/movements/*` (TD-12) y
`POST /sales` (TD-14): exige sesión autenticada real (no es vector de
fuerza bruta ni enumeración), y el abuso real queda acotado por las
validaciones de negocio (tope por línea, plazo, sesión de caja). No
bloquea — decisión transversal ya tomada, se documenta como TD-15 en
vez de repetir la discusión.

## 17. Dependencies

`npm audit` (backend): 12 advisories totales (0 critical, 4 high, 3
moderate, 5 low) — **exactamente los mismos ya documentados en TD-9**,
sin cambios desde la última auditoría. Reconfirmado con
`npm audit --omit=dev`: **3 high**, ninguno nuevo, misma cadena de
`prisma` CLI ya aceptada. Sin hallazgo nuevo.

## 18. Sensitive data storage

Sin almacenamiento de credenciales/tokens/tarjetas en este módulo. Los
montos de dinero (`totalDevuelto`, `monto` de reintegros) no son datos
"sensibles" en el sentido de esta categoría — son el objeto de negocio
del sistema, con acceso ya acotado por autenticación/rol donde
corresponde (sección 3).

## 19. Incorrect permissions

Cubierto en las secciones 2-4. Sin hallazgos adicionales.

## 20. Unauthorized endpoints

Las 3 rutas de `ReturnsController` y la extensión de `SalePaymentDto`
en `SalesController` están todas detrás de `AuthGuard` — confirmado
por código y en vivo (sección 1). Sin rutas huérfanas sin protección.

---

## Resultado

```
Previous vulnerabilities: ninguna (primera auditoría de seguridad del
  módulo returns)

Fixed: N/A

Remaining: ninguna CRITICAL ni HIGH sin corregir — el único HIGH
  encontrado (manipulación de IDs, IDOR/integridad) se encontró y
  corrigió en la Fase 08, reconfirmado corregido en vivo en esta fase.

New findings:
  - LOW — POST /returns sin rate limiting (TD-15, extiende
    TD-12/TD-14, no bloquea)
  - LOW — npm audit, 12 advisories totales / 3 high de producción,
    ya documentados en TD-9, sin cambios (no requiere fila nueva)

Security status: sin CRITICAL ni HIGH pendientes. El módulo puede
  avanzar a la Fase 10 (security remediation) para corregir el único
  hallazgo pendiente formal (TD-15, documentación en TECH_DEBT.md —
  no requiere código, ya se decidió no bloquear).
```

No se declara el módulo seguro de forma permanente — corresponde a la
Fase 11 (re-auditoría) confirmarlo de forma independiente.
