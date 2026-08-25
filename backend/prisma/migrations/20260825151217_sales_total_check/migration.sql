-- T4.6 (fase 06 de `sales`, sección 3): defensa en profundidad para el
-- invariante 4 — `total >= 0` no se sigue automáticamente de
-- `0 <= descuento_total <= subtotal` y `|ajuste_redondeo| < 1` combinados
-- (un `ajuste_redondeo` negativo puede dejarlo en negativo igual). El
-- servicio ya lo valida antes de escribir, este CHECK es la segunda
-- barrera, mismo criterio que `sales_descuento_total_check` (T4.3) y
-- `cash_movements_monto_sign_check` (fase 01).
ALTER TABLE "sales" ADD CONSTRAINT "sales_total_check" CHECK (
  "total" >= 0
);
