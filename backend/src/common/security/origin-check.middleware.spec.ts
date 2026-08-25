import type { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { OriginCheckMiddleware } from './origin-check.middleware';
import type { EnvConfig } from '../../config/env.schema';

// Fase 10 (security remediation) — hallazgo HIGH matizado de la fase 09
// (CSRF, sección 9 del reporte de auditoría de `sales`): mismo criterio de
// mock que el resto del proyecto (Prisma/servicios mockeados a mano, sin
// librería extra).
function buildConfig(frontendUrl: string): ConfigService<EnvConfig, true> {
  return {
    get: jest.fn().mockReturnValue(frontendUrl),
  } as unknown as ConfigService<EnvConfig, true>;
}

function buildRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    headers: {},
    ...overrides,
  } as Request;
}

interface MockResponse {
  status: jest.Mock<MockResponse, [number]>;
  json: jest.Mock<MockResponse, [unknown]>;
}

function buildResponse(): MockResponse {
  const res = {} as MockResponse;
  res.status = jest.fn<MockResponse, [number]>().mockReturnValue(res);
  res.json = jest.fn<MockResponse, [unknown]>().mockReturnValue(res);
  return res;
}

describe('OriginCheckMiddleware', () => {
  const FRONTEND_URL = 'https://manitas.example.com';

  it('sin header Origin (mismo origen, o un cliente no-browser como los tests): deja pasar, sin tocar la respuesta', () => {
    const middleware = new OriginCheckMiddleware(buildConfig(FRONTEND_URL));
    const req = buildRequest({ headers: {} });
    const res = buildResponse();
    const next = jest.fn<void, []>();

    middleware.use(req, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('Origin que coincide EXACTAMENTE con FRONTEND_URL: deja pasar', () => {
    const middleware = new OriginCheckMiddleware(buildConfig(FRONTEND_URL));
    const req = buildRequest({ headers: { origin: FRONTEND_URL } });
    const res = buildResponse();
    const next = jest.fn<void, []>();

    middleware.use(req, res as unknown as Response, next as NextFunction);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('Origin de un sitio distinto: 403 "Origen no autorizado", next() nunca se llama', () => {
    const middleware = new OriginCheckMiddleware(buildConfig(FRONTEND_URL));
    const req = buildRequest({
      headers: { origin: 'https://evil.example.com' },
    });
    const res = buildResponse();
    const next = jest.fn<void, []>();

    middleware.use(req, res as unknown as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      statusCode: 403,
      message: 'Origen no autorizado',
    });
  });

  it('Origin literal "null" (sandboxed iframe, vector típico para esquivar allowlists): rechazado igual, no es un caso especial', () => {
    const middleware = new OriginCheckMiddleware(buildConfig(FRONTEND_URL));
    const req = buildRequest({ headers: { origin: 'null' } });
    const res = buildResponse();
    const next = jest.fn<void, []>();

    middleware.use(req, res as unknown as Response, next as NextFunction);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'método no mutante (%s) con Origin distinto: deja pasar, el chequeo es solo para POST/PUT/PATCH/DELETE',
    (method) => {
      const middleware = new OriginCheckMiddleware(buildConfig(FRONTEND_URL));
      const req = buildRequest({
        method,
        headers: { origin: 'https://evil.example.com' },
      });
      const res = buildResponse();
      const next = jest.fn<void, []>();

      middleware.use(req, res as unknown as Response, next as NextFunction);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    },
  );

  it.each(['PUT', 'PATCH', 'DELETE'])(
    'método mutante (%s) con Origin distinto: rechaza igual que POST',
    (method) => {
      const middleware = new OriginCheckMiddleware(buildConfig(FRONTEND_URL));
      const req = buildRequest({
        method,
        headers: { origin: 'https://evil.example.com' },
      });
      const res = buildResponse();
      const next = jest.fn<void, []>();

      middleware.use(req, res as unknown as Response, next as NextFunction);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    },
  );
});
