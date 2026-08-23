import type { CookieOptions } from 'express';

export const ACCESS_TOKEN_COOKIE = 'access_token';
export const ACCESS_TOKEN_TTL = '12h'; // BLUEPRINT §9.6
export const ACCESS_TOKEN_MAX_AGE_MS = 12 * 60 * 60 * 1000;

// En producción, frontend (Cloudflare Pages) y backend (Render) viven en
// dominios distintos: la cookie es cross-site, así que necesita
// SameSite=None — y los navegadores exigen Secure junto con None. En
// desarrollo (localhost:5173 / localhost:3000) alcanza con Lax, y Secure
// tiene que estar apagado porque el dev server no corre en HTTPS.
export function buildAccessTokenCookieOptions(
  isProduction: boolean,
): CookieOptions {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  };
}
