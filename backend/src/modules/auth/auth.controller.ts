import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AuthService, SafeAuthUser } from './auth.service';
import { LoginDto } from './dto/login.dto';
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_MAX_AGE_MS,
  buildAccessTokenCookieOptions,
} from './auth-cookie';
import type { EnvConfig } from '../../config/env.schema';

// Sin AuthGuard todavía (llega en T1.3): no hay GET /auth/me acá porque
// "¿hay sesión válida?" es exactamente lo que hace el guard. Login y
// logout no necesitan verificar nada, solo emitir/limpiar la cookie.
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SafeAuthUser> {
    const user = await this.authService.validateUser(dto.email, dto.password);

    if (!user) {
      throw new UnauthorizedException('Email o contraseña incorrectos');
    }

    const { token, user: safeUser } = this.authService.issueToken(user);

    response.cookie(ACCESS_TOKEN_COOKIE, token, {
      ...buildAccessTokenCookieOptions(this.isProduction()),
      maxAge: ACCESS_TOKEN_MAX_AGE_MS,
    });

    return safeUser;
  }

  // Idempotente a propósito: un logout nunca debería poder fallar de
  // forma que la persona quede sin saber si cerró sesión (module spec,
  // sección 4).
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) response: Response): { success: true } {
    response.clearCookie(
      ACCESS_TOKEN_COOKIE,
      buildAccessTokenCookieOptions(this.isProduction()),
    );
    return { success: true };
  }

  private isProduction(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }
}
