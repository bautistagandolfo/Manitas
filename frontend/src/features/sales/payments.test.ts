import { describe, expect, it } from 'vitest';
import { saldoPendienteCents, sumPaymentsCents, vueltoCents } from './payments';
import type { DraftPayment } from './payments';

describe('sumPaymentsCents', () => {
  it('suma varios pagos en centavos enteros, sin drift de punto flotante', () => {
    const payments: DraftPayment[] = [
      { id: '1', metodo: 'EFECTIVO', monto: '0.10' },
      { id: '2', metodo: 'TARJETA_DEBITO', monto: '0.20' },
    ];
    expect(sumPaymentsCents(payments)).toBe(30);
  });

  it('sin pagos, devuelve 0', () => {
    expect(sumPaymentsCents([])).toBe(0);
  });
});

describe('saldoPendienteCents', () => {
  it('total menos lo ya pagado', () => {
    const payments: DraftPayment[] = [
      { id: '1', metodo: 'EFECTIVO', monto: '300.00' },
    ];
    expect(saldoPendienteCents(100000, payments)).toBe(70000);
  });

  it('llega a 0 cuando lo pagado cubre el total exacto', () => {
    const payments: DraftPayment[] = [
      { id: '1', metodo: 'EFECTIVO', monto: '1000.00' },
    ];
    expect(saldoPendienteCents(100000, payments)).toBe(0);
  });

  it('nunca queda negativo, aunque se haya pagado de más', () => {
    const payments: DraftPayment[] = [
      { id: '1', metodo: 'EFECTIVO', monto: '1500.00' },
    ];
    expect(saldoPendienteCents(100000, payments)).toBe(0);
  });
});

describe('vueltoCents', () => {
  it('lo que entregó el cliente menos lo que aplica ese pago', () => {
    expect(vueltoCents(10000, 8000)).toBe(2000);
  });

  it('entregó justo: vuelto 0', () => {
    expect(vueltoCents(8000, 8000)).toBe(0);
  });

  it('nunca negativo, aunque entregó menos de lo que aplica el pago', () => {
    expect(vueltoCents(5000, 8000)).toBe(0);
  });
});
