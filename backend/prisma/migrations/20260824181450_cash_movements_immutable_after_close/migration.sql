-- RN-8 / BLUEPRINT §5.5 (literal): "Cerrada una sesión, sus movimientos
-- son inmutables. Se bloquea a nivel de base de datos toda escritura de
-- cash_movements con session_id de una sesión CERRADA."
--
-- Hasta esta migración esa inmutabilidad solo existía a nivel de
-- aplicación (CashRegisterService.registrarMovimiento, que ya bloquea la
-- fila de sesión con SELECT ... FOR UPDATE antes de leer su estado). Este
-- trigger la refuerza a nivel de base como defensa en profundidad — mismo
-- criterio que el CHECK de signo de cash_movements (migración inicial):
-- ninguna constraint de base es la única barrera, pero tampoco falta.
--
-- Corre dentro de la misma transacción que el INSERT/UPDATE/DELETE que
-- protege, así que ve el estado de la sesión ya bloqueado por el
-- SELECT ... FOR UPDATE que el servicio toma antes — no necesita su
-- propio lock.
CREATE OR REPLACE FUNCTION cash_movements_block_if_session_closed()
RETURNS TRIGGER AS $$
DECLARE
  v_estado "CashRegisterSessionEstado";
  v_session_id INTEGER := COALESCE(NEW.session_id, OLD.session_id);
BEGIN
  SELECT estado INTO v_estado
  FROM cash_register_sessions
  WHERE id = v_session_id;

  IF v_estado = 'CERRADA' THEN
    RAISE EXCEPTION 'No se puede escribir cash_movements de una sesión de caja cerrada (session_id=%)', v_session_id;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cash_movements_immutable_after_close
BEFORE INSERT OR UPDATE OR DELETE ON "cash_movements"
FOR EACH ROW EXECUTE FUNCTION cash_movements_block_if_session_closed();
