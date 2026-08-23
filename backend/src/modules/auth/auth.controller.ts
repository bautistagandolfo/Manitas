import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
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
import { Public } from '../../common/auth/public.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { RequestUser } from '../../common/auth/authenticated-request';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  @Public()
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

  // Pública también: un logout nunca debería poder fallar por no tener
  // sesión válida (module spec, sección 4) — si exigiera AuthGuard, una
  // cookie ya vencida daría 401 en vez del 200 idempotente que se espera.
  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) response: Response): { success: true } {
    response.clearCookie(
      ACCESS_TOKEN_COOKIE,
      buildAccessTokenCookieOptions(this.isProduction()),
    );
    return { success: true };
  }

  // Requiere sesión (no @Public): lo usa el frontend al cargar la SPA para
  // saber si hay sesión y quién es.
  @Get('me')
  async me(@CurrentUser() currentUser: RequestUser): Promise<SafeAuthUser> {
    const user = await this.authService.findSafeUserById(currentUser.id);

    if (!user) {
      throw new NotFoundException('Usuario no encontrado');
    }

    return user;
  }

  private isProduction(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }
}
