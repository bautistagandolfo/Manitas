import {
  MiddlewareConsumer,
  Module,
  NestModule,
  OnModuleInit,
  ValidationPipe,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE, HttpAdapterHost } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Express } from 'express';
import { validateEnv, type EnvConfig } from './config/env.schema';
import { LOG_REDACT_PATHS } from './config/logger.config';
import { PrismaModule } from './prisma/prisma.module';
import { HealthModule } from './health/health.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProductsModule } from './modules/products/products.module';
import { StockModule } from './modules/stock/stock.module';
import { CashRegistersModule } from './modules/cash-registers/cash-registers.module';
import { SalesModule } from './modules/sales/sales.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { CustomersModule } from './modules/customers/customers.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { AuthGuard } from './common/auth/auth.guard';
import { RolesGuard } from './common/auth/roles.guard';
import { jsonOnlyMiddleware } from './common/security/json-only.middleware';
import { OriginCheckMiddleware } from './common/security/origin-check.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => ({
        pinoHttp: {
          level: config.get('LOG_LEVEL', { infer: true }),
          // Seguridad (fase 10): sin esto, el JWT de sesión (header
          // cookie del request, y también el Set-Cookie de la respuesta
          // de login) quedaba en texto plano en cada línea de log —
          // cualquiera con acceso de lectura a logs podía secuestrar
          // cualquier sesión activa, incluida OWNER, hasta por 12h. Ver
          // state/reports/modulo-auth-secaudit-2026-08-23.md, hallazgo 2.
          redact: {
            paths: LOG_REDACT_PATHS,
            censor: '[REDACTED]',
          },
          transport:
            config.get('NODE_ENV', { infer: true }) === 'development'
              ? { target: 'pino-pretty', options: { singleLine: true } }
              : undefined,
        },
      }),
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    ProductsModule,
    StockModule,
    CashRegistersModule,
    SalesModule,
    ReturnsModule,
    ExpensesModule,
    CustomersModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
    // Orden importa: AuthGuard puebla request.user antes de que RolesGuard
    // lo necesite.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule, OnModuleInit {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  // X-Powered-By (fase 10, hallazgo 5): Express lo vuelve a agregar al
  // finalizar cada respuesta sin importar qué haya hecho un middleware
  // antes (removeHeader manual de la fase 08, y hasta helmet() como
  // middleware) — se confirmó agregando helmet() en configure() y
  // viendo que el header seguía presente en la respuesta OPTIONS del
  // preflight de CORS. `app.disable('x-powered-by')` es la única forma
  // que realmente lo saca siempre: es un setting de la app, no algo que
  // se pueda revertir por orden de middleware. onModuleInit corre tanto
  // en bootstrap() (main.ts) como en los tests de integración
  // (TestingModule + app.init()), así que no hace falta duplicarlo.
  onModuleInit(): void {
    this.httpAdapterHost.httpAdapter
      .getInstance<Express>()
      .disable('x-powered-by');
  }

  configure(consumer: MiddlewareConsumer): void {
    // helmet: headers básicos de seguridad (X-Frame-Options,
    // X-Content-Type-Options, etc. — fase 10, hallazgo 3) que no
    // existían. Vía configure() (no en main.ts) para que también corra
    // en los tests de integración, que arman la app con TestingModule +
    // createNestApplication() sin pasar por bootstrap().
    // OriginCheckMiddleware: fase 10 de `sales` (hallazgo HIGH matizado
    // de la fase 09, CSRF) — segunda barrera independiente de CORS, ver
    // el comentario del archivo.
    consumer
      .apply(
        helmet(),
        jsonOnlyMiddleware,
        OriginCheckMiddleware,
        cookieParser(),
      )
      .forRoutes('*');
  }
}
