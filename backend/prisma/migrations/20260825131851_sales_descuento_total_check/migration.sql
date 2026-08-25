-- T4.3 (fase 06 de `sales`, sección 3): defensa en profundidad para el
-- tope duro de la venta (invariante 4, RN-4) — `0 <= descuento_total <=
-- subtotal`. El servicio ya lo valida antes de escribir, este CHECK es
-- la segunda barrera, mismo criterio que `cash_movements_monto_sign_check`
-- (fase 01): ninguna constraint de base es la única defensa, pero tampoco
-- falta.
ALTER TABLE "sales" ADD CONSTRAINT "sales_descuento_total_check" CHECK (
  "descuento_total" >= 0 AND "descuento_total" <= "subtotal"
);
