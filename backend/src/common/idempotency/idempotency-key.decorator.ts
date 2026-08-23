import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import type { IdempotentRequest } from './idempotent-request';

// Siempre se usa junto con @UseInterceptors(IdempotencyInterceptor), que
// ya validó y dejó la clave en el request — este decorator solo la
// expone como parámetro del handler. El chequeo de acá es un respaldo,
// no la validación principal (si alguien usa el decorator sin el
// interceptor por error, esto lo hace notar en vez de pasar `undefined`
// en silencio).
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<IdempotentRequest>();
    if (!request.idempotencyKey) {
      throw new BadRequestException('Falta el header Idempotency-Key');
    }
    return request.idempotencyKey;
  },
);
