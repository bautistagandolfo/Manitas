import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// T2.13/AMB-12 (RESUELTA): plantilla propia, CSV como texto plano en el
// body — no multipart/form-data (sin agregar multer, sin infraestructura
// de upload que no existe en ningún otro lado del proyecto). El
// frontend (pantalla, ticket futuro) lee el archivo elegido con
// `File.text()` y manda el contenido acá.
export class ImportCatalogDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5_000_000)
  csv!: string;
}
