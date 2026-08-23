import {
  Body,
  Controller,
  Get,
  ParseIntPipe,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { UsersService, SafeUser } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';

// Sin guards todavía: AuthGuard y RolesGuard se registran a nivel de
// aplicación en T1.3 (ver modulo-auth-spec.md, sección 3) y protegen estas
// rutas retroactivamente, sin tocar este archivo.
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  create(@Body() dto: CreateUserDto): Promise<SafeUser> {
    return this.usersService.create(dto);
  }

  @Get()
  findAll(): Promise<SafeUser[]> {
    return this.usersService.findAll();
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUserDto,
  ): Promise<SafeUser> {
    return this.usersService.update(id, dto);
  }

  @Patch(':id/password')
  resetPassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdatePasswordDto,
  ): Promise<SafeUser> {
    return this.usersService.resetPassword(id, dto.password);
  }
}
