import {
  Body,
  Controller,
  Get,
  ParseIntPipe,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { UsersService, SafeUser } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdatePasswordDto } from './dto/update-password.dto';
import { Roles } from '../../common/auth/roles.decorator';

// Gestión de usuarios: OWNER-only en todas sus rutas (BLUEPRINT §5.1,
// module-auth-spec.md sección 8). AuthGuard + RolesGuard corren global.
@Roles(UserRole.OWNER)
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
