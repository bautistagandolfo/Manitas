import type { NextFunction, Request, Response } from 'express';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Seguridad (fase 10): un <form> HTML nativo (sin JavaScript) solo puede
// mandar application/x-www-form-urlencoded, multipart/form-data o
// text/plain — nunca application/json. Esos tres son "simple requests"
// del estándar Fetch/CORS: el navegador los manda igual sin importar la
// política de CORS del server (CORS solo le impide al atacante *leer* la
// respuesta, no impide que el server la reciba y la procese con efectos
// reales). Antes de este fix, un <form> cross-site apuntando a POST
// /users con rol=OWNER, disparado con la cookie real de un OWNER
// logueado, creaba una cuenta nueva controlada por el atacante sin que
// la víctima hiciera nada más que abrir una página.
//
// Rechazar acá cualquier Content-Type que no sea application/json en
// rutas que mutan estado cierra el vector por completo: un <form> nunca
// puede producir ese Content-Type, así que cae con 415 antes de llegar a
// ningún DTO o servicio. Una llamada real vía fetch/XHR con
// Content-Type: application/json sigue exigiendo el preflight de CORS
// (que solo permite el origin configurado), así que el frontend legítimo
// no se ve afectado. Ver
// state/reports/modulo-auth-secaudit-2026-08-23.md, hallazgo 1.
export function jsonOnlyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!MUTATING_METHODS.has(req.method)) {
    next();
    return;
  }

  const contentType = req.headers['content-type'];

  if (
    contentType &&
    !contentType.toLowerCase().startsWith('application/json')
  ) {
    res.status(415).json({
      statusCode: 415,
      message: 'Content-Type no soportado: se espera application/json',
    });
    return;
  }

  next();
}
