// Seguridad (fase 10): qué campos censura pino en cada línea de log.
// req.headers.cookie lleva el JWT de sesión (access_token); el
// Set-Cookie de la respuesta de /auth/login lo lleva también, en texto
// plano, cuando se emite una sesión nueva. Sin esto, cualquiera con
// acceso de lectura a los logs puede secuestrar una sesión activa. Ver
// state/reports/modulo-auth-secaudit-2026-08-23.md, hallazgo 2.
export const LOG_REDACT_PATHS: string[] = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
];
