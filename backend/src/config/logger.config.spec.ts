import pino from 'pino';
import { LOG_REDACT_PATHS } from './logger.config';

// QA de seguridad (fase 10): no alcanza con revisar que LOG_REDACT_PATHS
// tenga las strings correctas — un path mal escrito (typo, sintaxis de
// pino equivocada para un header con guión) fallaría en silencio y
// seguiría filtrando el JWT. Este test corre pino de verdad con la
// config real y confirma que el valor sensible desaparece del output.
describe('LOG_REDACT_PATHS', () => {
  function logWithRedaction(logObject: Record<string, unknown>): string {
    const chunks: string[] = [];
    const stream = {
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    };

    const logger = pino(
      { redact: { paths: [...LOG_REDACT_PATHS], censor: '[REDACTED]' } },
      stream as unknown as NodeJS.WritableStream,
    );

    logger.info(logObject, 'request completed');

    return chunks.join('');
  }

  it('censura la cookie de sesión del request', () => {
    const output = logWithRedaction({
      req: { headers: { cookie: 'access_token=eyJhbGciOiJIUzI1NiJ9.secreto' } },
    });

    expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9.secreto');
    expect(output).toContain('[REDACTED]');
  });

  it('censura el Set-Cookie de la respuesta de login', () => {
    const output = logWithRedaction({
      res: {
        headers: {
          'set-cookie': 'access_token=eyJhbGciOiJIUzI1NiJ9.secreto; HttpOnly',
        },
      },
    });

    expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9.secreto');
    expect(output).toContain('[REDACTED]');
  });

  it('censura un Authorization header si alguna vez se usa', () => {
    const output = logWithRedaction({
      req: { headers: { authorization: 'Bearer secreto-de-verdad' } },
    });

    expect(output).not.toContain('secreto-de-verdad');
  });

  it('no toca otros headers no sensibles', () => {
    const output = logWithRedaction({
      req: { headers: { 'user-agent': 'curl/8.19.0', host: 'localhost:3000' } },
    });

    expect(output).toContain('curl/8.19.0');
    expect(output).toContain('localhost:3000');
  });
});
