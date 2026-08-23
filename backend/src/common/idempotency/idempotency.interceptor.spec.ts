import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
} from '@nestjs/common';
import { of } from 'rxjs';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import type { IdempotentRequest } from './idempotent-request';

function buildContext(headers: Record<string, unknown>): {
  context: ExecutionContext;
  request: IdempotentRequest;
} {
  const request = { headers } as unknown as IdempotentRequest;
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
  return { context, request };
}

function buildCallHandler(): CallHandler {
  return { handle: () => of('ok') };
}

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;

  beforeEach(() => {
    interceptor = new IdempotencyInterceptor();
  });

  it('con el header presente, lo deja en request.idempotencyKey y deja pasar', () => {
    const { context, request } = buildContext({ 'idempotency-key': 'abc-123' });
    const handler = buildCallHandler();

    interceptor.intercept(context, handler);

    expect(request.idempotencyKey).toBe('abc-123');
  });

  it('sin el header, rechaza con BadRequestException y no llama al handler', () => {
    const { context } = buildContext({});
    const handle = jest.fn(() => of('no debería llegar acá'));
    const handler: CallHandler = { handle };

    expect(() => interceptor.intercept(context, handler)).toThrow(
      BadRequestException,
    );
    expect(handle).not.toHaveBeenCalled();
  });

  it('con el header vacío o solo espacios, rechaza igual', () => {
    const { context } = buildContext({ 'idempotency-key': '   ' });
    const handler = buildCallHandler();

    expect(() => interceptor.intercept(context, handler)).toThrow(
      BadRequestException,
    );
  });

  it('si el header llega duplicado (array), toma el primer valor', () => {
    const { context, request } = buildContext({
      'idempotency-key': ['primero', 'segundo'],
    });
    const handler = buildCallHandler();

    interceptor.intercept(context, handler);

    expect(request.idempotencyKey).toBe('primero');
  });
});
