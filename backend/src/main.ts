import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import type { EnvConfig } from './config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.useGlobalFilters(new GlobalExceptionFilter());

  const config = app.get(ConfigService<EnvConfig, true>);

  app.enableCors({
    origin: config.get('FRONTEND_URL', { infer: true }),
    credentials: true,
  });

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
