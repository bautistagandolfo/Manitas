import type { Request } from 'express';

export interface IdempotentRequest extends Request {
  idempotencyKey?: string;
}
