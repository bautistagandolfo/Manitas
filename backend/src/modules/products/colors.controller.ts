import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Color } from '@prisma/client';
import { ColorsService } from './colors.service';
import { CreateColorDto } from './dto/create-color.dto';
import { UpdateColorDto } from './dto/update-color.dto';

@Controller('colors')
export class ColorsController {
  constructor(private readonly colorsService: ColorsService) {}

  @Get()
  findAll(): Promise<Color[]> {
    return this.colorsService.findAll();
  }

  @Post()
  create(@Body() dto: CreateColorDto): Promise<Color> {
    return this.colorsService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateColorDto,
  ): Promise<Color> {
    return this.colorsService.update(id, dto);
  }
}
