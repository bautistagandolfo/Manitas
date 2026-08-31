import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Customer, PaymentMetodo, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCustomerDto } from './dto/create-customer.dto';

// Ticket nuevo (post Release Candidate, BLUEPRINT §8.4) — módulo mínimo:
// alta rápida de cliente (mismo patrón que Marca/Talle/Color) y consulta
// de crédito por cliente en vez de por número de comprobante (T5.8,
// AMB-16 — el mecanismo de crédito en sí no cambia, solo cómo se
// encuentra). Cualquier rol autenticado puede crear/buscar (sin dato de
// costo/margen de por medio, mismo criterio que `returns`).
export interface CreditoPorReturn {
  returnId: number;
  numero: number;
  creditoDisponible: Prisma.Decimal;
}

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async crear(dto: CreateCustomerDto): Promise<Customer> {
    try {
      return await this.prisma.customer.create({
        data: {
          nombre: dto.nombre,
          dni: dto.dni,
          telefono: dto.telefono ?? null,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe un cliente con ese DNI');
      }
      throw error;
    }
  }

  // Sin `q`: los últimos cargados primero (mismo criterio de "lo último
  // arriba" que el resto de los listados del sistema, §12.4).
  buscar(q?: string): Promise<Customer[]> {
    const trimmed = q?.trim();
    return this.prisma.customer.findMany({
      where: {
        activo: true,
        ...(trimmed
          ? {
              OR: [
                { nombre: { contains: trimmed, mode: 'insensitive' } },
                { dni: { contains: trimmed.replace(/[.\s-]/g, '') } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  // Ticket nuevo — mismo cálculo exacto que `ReturnsService.consultarCredito`
  // (paso a paso, T5.8/AMB-16), pero para TODAS las devoluciones de un
  // cliente en vez de una sola: es la parte que resuelve el pedido
  // original ("que quede registrado, sin depender de una anotación
  // manual") — buscar por cliente en vez de por número de comprobante.
  // Filtra a las que todavía tienen saldo (>0): una devolución ya
  // consumida del todo no aporta nada a la lista.
  async creditoDisponible(customerId: number): Promise<CreditoPorReturn[]> {
    const cliente = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!cliente) {
      throw new NotFoundException('Cliente no encontrado');
    }

    const devoluciones = await this.prisma.return.findMany({
      where: { customerId },
      select: { id: true, numero: true },
      orderBy: { numero: 'desc' },
    });
    if (devoluciones.length === 0) return [];

    const returnIds = devoluciones.map((d) => d.id);

    const creditoOriginalPorReturn = await this.prisma.returnPayment.groupBy({
      by: ['returnId'],
      where: { returnId: { in: returnIds }, metodo: PaymentMetodo.CREDITO_DEVOLUCION },
      _sum: { monto: true },
    });
    const consumidoPorReturn = await this.prisma.payment.groupBy({
      by: ['returnId'],
      where: { returnId: { in: returnIds }, metodo: PaymentMetodo.CREDITO_DEVOLUCION },
      _sum: { monto: true },
    });

    const originalById = new Map(
      creditoOriginalPorReturn.map((r) => [
        r.returnId,
        r._sum.monto ?? new Prisma.Decimal(0),
      ]),
    );
    const consumidoById = new Map(
      consumidoPorReturn.map((r) => [
        r.returnId,
        r._sum.monto ?? new Prisma.Decimal(0),
      ]),
    );

    const resultado: CreditoPorReturn[] = [];
    for (const devolucion of devoluciones) {
      const original = originalById.get(devolucion.id) ?? new Prisma.Decimal(0);
      const consumido = consumidoById.get(devolucion.id) ?? new Prisma.Decimal(0);
      const disponible = original.minus(consumido);
      if (disponible.greaterThan(0)) {
        resultado.push({
          returnId: devolucion.id,
          numero: devolucion.numero,
          creditoDisponible: disponible,
        });
      }
    }
    return resultado;
  }
}
