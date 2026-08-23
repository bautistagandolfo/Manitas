import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { Size } from '@prisma/client';
import { SizesService } from './sizes.service';
import { CreateSizeDto } from './dto/create-size.dto';
import { UpdateSizeDto } from './dto/update-size.dto';

@Controller('sizes')
export class SizesController {
  constructor(private readonly sizesService: SizesService) {}

  @Get()
  findAll(): Promise<Size[]> {
    return this.sizesService.findAll();
  }

  @Post()
  create(@Body() dto: CreateSizeDto): Promise<Size> {
    return this.sizesService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSizeDto,
  ): Promise<Size> {
    return this.sizesService.update(id, dto);
  }
}
