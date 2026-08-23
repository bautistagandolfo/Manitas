// Solo para POST /auth/login (QA adversarial, fase 08): es la única ruta
// pública sin sesión de todo el sistema, y validateUser() corre argon2
// siempre — sin límite de intentos, fuerza bruta y DoS de CPU quedan
// abiertos. No se aplica global a propósito: el resto de las rutas ya
// exige sesión o rol, que es una barrera mucho más fuerte que un límite
// por IP. 20/min dificulta fuerza bruta real sin bloquear a alguien
// reintentando su propia contraseña un par de veces.
export const LOGIN_THROTTLE = {
  name: 'login',
  ttl: 60_000,
  limit: 20,
} as const;
