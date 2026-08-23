# Fase 00 — Setup del proyecto

Se ejecuta **una sola vez**, al principio de todo.

> **Antes de empezar:** leé `BLUEPRINT.md`, sección 9 (stack y estructura).

Creá el esqueleto del proyecto siguiendo exactamente la sección 9 del
`BLUEPRINT.md`.

## Backend

1. Proyecto **NestJS con TypeScript** en modo estricto (`strict: true` en
   `tsconfig.json`).
2. Estructura de carpetas **exactamente** como la sección 9.2 del blueprint.
   Creá las carpetas de módulos vacías, sin implementar nada todavía.
3. **Prisma** instalado y conectado a un Postgres local vía
   `docker-compose.yml` (Postgres para desarrollo, nunca SQLite: hay que
   probar transacciones y bloqueos reales).
4. **Configuración validada con zod** (`@nestjs/config`): si falta una
   variable de entorno, la aplicación **no arranca**. Incluí `.env.example`
   sin valores reales.
5. Filtro global de excepciones con formato de error uniforme.
6. Endpoint `GET /health` que verifique la conexión a la base de datos.
7. Logging estructurado.

## Frontend

8. Proyecto **React + Vite + TypeScript**.
9. Routing y un cliente HTTP configurado (con `credentials: 'include'` para
   la cookie de sesión).
10. Nada de UI de negocio todavía.

## Calidad

11. **ESLint + Prettier** configurados, con una regla que prohíba operar con
    `number` sobre importes (ver blueprint 9.3).
12. **Jest** configurado para unitarios y **Supertest** para integración.
13. **Playwright** instalado para E2E.
14. **GitHub Actions** que en cada push corra: lint, tests y build.
15. `.gitignore` correcto. **Ningún secreto en el repositorio.**

## Validación

- `docker-compose up` levanta Postgres.
- La aplicación arranca y `/health` responde OK.
- El frontend levanta y compila.
- Lint, tests y build pasan en verde.
- El CI pasa en verde.

## Restricciones

- No implementes ninguna tabla, entidad ni lógica de negocio: eso es la
  fase 01.
- No agregues librerías que no estén justificadas por el blueprint.

---

> **Al finalizar:** agregá una fila a `state/STATUS.md` (Fase 00,
> VERDE/BLOQUEADO, hash del commit).
