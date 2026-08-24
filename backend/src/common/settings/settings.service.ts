import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Setting, SettingTipo } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

// BLUEPRINT §10: los 4 parámetros que la dueña puede cambiar sin tocar
// código. Lee/escribe siempre con `this.prisma` directo, nunca recibe el
// `tx` de quien llama (a diferencia de stock.service.ts/
// cash-register.service.ts): acá no hay ninguna escritura que tenga que
// participar de la transacción de negocio de otro módulo — `sales`/
// `returns` solo LEEN un valor de configuración para decidir una regla
// (tope de descuento, plazo de devolución), nunca lo modifican como parte
// de su propia operación. Bajo READ COMMITTED cada lectura ya ve el
// último valor confirmado; el riesgo de que cambie a mitad de una
// transacción ajena es el mismo que el de cualquier configuración
// editable en caliente, y no amerita la complejidad de threadear `tx` a
// través de un servicio que ningún módulo va a escribir dentro de su
// propia transacción.
//
// Solo actualiza (`set*`): los 4 parámetros ya vienen sembrados (ver
// `prisma/seed.ts`) — no hay forma de crear una clave nueva por acá, para
// que un typo en la clave falle con 404 en vez de crear silenciosamente
// una fila de configuración que nadie va a leer nunca.
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getBool(clave: string): Promise<boolean> {
    const row = await this.findOrThrow(clave, SettingTipo.BOOL);
    return row.valor === 'true';
  }

  async getInt(clave: string): Promise<number> {
    const row = await this.findOrThrow(clave, SettingTipo.INT);
    return parseInt(row.valor, 10);
  }

  async getDecimal(clave: string): Promise<Prisma.Decimal> {
    const row = await this.findOrThrow(clave, SettingTipo.DECIMAL);
    return new Prisma.Decimal(row.valor);
  }

  async setBool(
    clave: string,
    valor: boolean,
    userId: number,
  ): Promise<Setting> {
    return this.update(
      clave,
      SettingTipo.BOOL,
      valor ? 'true' : 'false',
      userId,
    );
  }

  async setInt(clave: string, valor: number, userId: number): Promise<Setting> {
    if (!Number.isInteger(valor)) {
      throw new BadRequestException(`${clave} tiene que ser un número entero`);
    }
    return this.update(clave, SettingTipo.INT, String(valor), userId);
  }

  async setDecimal(
    clave: string,
    valor: Prisma.Decimal.Value,
    userId: number,
  ): Promise<Setting> {
    return this.update(
      clave,
      SettingTipo.DECIMAL,
      new Prisma.Decimal(valor).toString(),
      userId,
    );
  }

  private async findOrThrow(
    clave: string,
    tipoEsperado: SettingTipo,
  ): Promise<Setting> {
    const row = await this.prisma.setting.findUnique({ where: { clave } });
    if (!row) {
      throw new NotFoundException(
        `No existe el parámetro de configuración "${clave}"`,
      );
    }
    this.assertTipo(row, tipoEsperado);
    return row;
  }

  private async update(
    clave: string,
    tipoEsperado: SettingTipo,
    valor: string,
    userId: number,
  ): Promise<Setting> {
    const existing = await this.findOrThrow(clave, tipoEsperado);
    return this.prisma.setting.update({
      where: { clave: existing.clave },
      data: { valor, updatedByUserId: userId },
    });
  }

  // No debería pasar nunca en uso normal (cada clave tiene un único tipo
  // fijo desde el seed) — protege contra el error real de usar el getter/
  // setter equivocado para una clave (ej. `getInt('permitir_venta_sin_stock')`,
  // que es BOOL), en vez de devolver un `NaN`/`false` silencioso.
  private assertTipo(row: Setting, tipoEsperado: SettingTipo): void {
    if (row.tipo !== tipoEsperado) {
      throw new InternalServerErrorException(
        `"${row.clave}" es de tipo ${row.tipo}, no ${tipoEsperado} — revisá qué método de SettingsService estás usando`,
      );
    }
  }
}
