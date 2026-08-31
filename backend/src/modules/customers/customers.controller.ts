import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Customer } from '@prisma/client';
import { CreditoPorReturn, CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { SearchCustomerQueryDto } from './dto/search-customer-query.dto';

@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  buscar(@Query() query: SearchCustomerQueryDto): Promise<Customer[]> {
    return this.customersService.buscar(query.q, query.incluirInactivos);
  }

  @Post()
  crear(@Body() dto: CreateCustomerDto): Promise<Customer> {
    return this.customersService.crear(dto);
  }

  // Ticket nuevo (post Release Candidate) — sin @Roles(): mismo criterio
  // que el resto del módulo (crear/buscar tampoco lo tienen).
  @Patch(':id')
  actualizar(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCustomerDto,
  ): Promise<Customer> {
    return this.customersService.actualizar(id, dto);
  }

  @Get(':id/credito')
  creditoDisponible(
    @Param('id', ParseIntPipe) id: number,
  ): Promise<CreditoPorReturn[]> {
    return this.customersService.creditoDisponible(id);
  }
}
