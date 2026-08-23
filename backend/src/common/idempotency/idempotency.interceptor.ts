import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import type { IdempotentRequest } from './idempotent-request';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

// BLUEPRINT §9.7: "El cliente manda una cabecera Idempotency-Key (un UUID
// que genera al abrir el formulario, no al enviarlo) ... Un interceptor
// común lo maneja para todas las rutas de escritura." Se usa junto con
// @IdempotencyKey() en el controller — este interceptor exige y valida
// el header antes de que el handler corra; el decorator lo expone.
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<IdempotentRequest>();
    const header = request.headers[IDEMPOTENCY_KEY_HEADER];
    const key = Array.isArray(header) ? header[0] : header;

    if (!key || key.trim().length === 0) {
      throw new BadRequestException('Falta el header Idempotency-Key');
    }

    request.idempotencyKey = key;
    return next.handle();
  }
}
