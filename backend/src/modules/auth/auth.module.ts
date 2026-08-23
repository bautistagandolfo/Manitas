import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerModule } from '@nestjs/throttler';
import type { EnvConfig } from '../../config/env.schema';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ACCESS_TOKEN_TTL } from './auth-cookie';
import { LOGIN_THROTTLE } from './auth-throttle';

// JwtModule se re-exporta (mismo objeto en imports y exports) para que
// AuthGuard, registrado global en AppModule, pueda inyectar JwtService sin
// que AppModule tenga que configurar su propia copia por separado.
const jwtModule = JwtModule.registerAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvConfig, true>) => ({
    secret: config.get('JWT_SECRET', { infer: true }),
    signOptions: { expiresIn: ACCESS_TOKEN_TTL },
  }),
});

const throttlerModule = ThrottlerModule.forRoot([LOGIN_THROTTLE]);

@Module({
  imports: [jwtModule, throttlerModule],
  controllers: [UsersController, AuthController],
  providers: [UsersService, AuthService],
  exports: [jwtModule, UsersService, AuthService],
})
export class AuthModule {}
