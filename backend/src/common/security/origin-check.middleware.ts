import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { EnvConfig } from '../../config/env.schema';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Fase 10 (security remediation de `sales`, hallazgo HIGH matizado de la
// fase 09 — `state/reports/modulo-sales-secaudit-2026-08-25.md`, sección
// 9): `jsonOnlyMiddleware` ya bloquea el vector de CSRF vía <form> HTML
// nativo (nunca manda `application/json`), pero el vector de fetch()/XHR
// cross-origin con `Content-Type: application/json` real dependía
// ENTERAMENTE de que el preflight de CORS (`app.enableCors`, `main.ts`)
// rechazara el origen del atacante — una propiedad de la configuración
// de `FRONTEND_URL`, no del código, sin ningún chequeo independiente que
// la respaldara si esa variable se configura mal en algún entorno.
//
// Este middleware es una segunda barrera, independiente de CORS: para
// cualquier request que muta estado, si el navegador mandó un header
// `Origin` (siempre lo manda en un request cross-origin real — un
// request del mismo origen o hecho por un cliente no-browser, como los
// tests de integración, no lo manda), tiene que coincidir exactamente
// con `FRONTEND_URL`. `sameSite: 'none'` en producción (`auth-cookie.ts`,
// necesario porque frontend y backend viven en dominios distintos) ya
// quitó la protección nativa del navegador contra esto — esta es la
// que la reemplaza, sin depender de una única variable de CORS bien
// puesta para estar protegido.
@Injectable()
export class OriginCheckMiddleware implements NestMiddleware {
  constructor(private readonly config: ConfigService<EnvConfig, true>) {}

  use(req: Request, res: Response, next: NextFunction): void {
    if (!MUTATING_METHODS.has(req.method)) {
      next();
      return;
    }

    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }

    const frontendUrl = this.config.get('FRONTEND_URL', { infer: true });
    if (origin !== frontendUrl) {
      res.status(403).json({
        statusCode: 403,
        message: 'Origen no autorizado',
      });
      return;
    }

    next();
  }
}
