import type { Request } from 'express';
import type { UserRole } from '@prisma/client';

export interface RequestUser {
  id: number;
  rol: UserRole;
}

export interface AuthenticatedRequest extends Request {
  user?: RequestUser;
}
