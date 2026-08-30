# Backup diario (T0.6)

Implementa BLUEPRINT.md §9.10 ("Problema 2 — Los backups del plan
gratuito no son confiables"). El workflow vive en
`.github/workflows/backup.yml`.

## Qué hace

Una vez por día (06:00 UTC = 03:00 hora argentina), y también a mano
desde la pestaña **Actions** de GitHub (`workflow_dispatch`):

1. `pg_dump` contra la base de producción.
2. Cifra el dump con GPG simétrico (AES256), passphrase desde un
   secret del repositorio.
3. Sube el archivo cifrado a un bucket S3-compatible externo
   (Cloudflare R2 o Backblaze B2 — BLUEPRINT recomienda cualquiera de
   los dos, ambos con capa gratuita suficiente).
4. Borra del bucket los backups con más de 30 días — retención mínima
   exigida por el blueprint.

Si falta cualquiera de los 6 secrets necesarios, el workflow falla de
entrada con un mensaje explícito (`::error::`) en vez de correr a
medias o producir un dump vacío.

## Secrets a configurar (Settings → Secrets and variables → Actions)

Ninguno de estos existe todavía — hay que crearlos antes de que el
workflow pueda correr contra una base real. **Nunca van en el código ni
en `.env`/`.env.example`** (BLUEPRINT §9.9).

| Secret | Qué es |
|---|---|
| `BACKUP_DATABASE_URL` | Connection string de la base de **producción** (Neon). Recomendado: un usuario de solo lectura dedicado al backup, no el mismo que usa la app — así un secret filtrado no puede escribir nada. |
| `BACKUP_ENCRYPTION_PASSPHRASE` | Passphrase larga y aleatoria para el cifrado GPG del dump. Generarla una sola vez (`openssl rand -base64 32`, por ejemplo) y **guardarla aparte** (gestor de contraseñas) — sin ella, los backups cifrados son irrecuperables, ni siquiera por quien los subió. |
| `BACKUP_S3_ENDPOINT` | URL del endpoint S3-compatible (ej. `https://<account-id>.r2.cloudflarestorage.com` para R2). |
| `BACKUP_S3_BUCKET` | Nombre del bucket dedicado a backups. |
| `BACKUP_S3_ACCESS_KEY_ID` | Access key del bucket (permisos mínimos: leer/escribir/borrar solo en ese bucket, no la cuenta completa). |
| `BACKUP_S3_SECRET_ACCESS_KEY` | Secret key correspondiente. |

## Verificar que está funcionando

1. Después de configurar los 6 secrets, disparar el workflow a mano
   (Actions → "Backup diario" → "Run workflow") y confirmar que termina
   en verde.
2. Confirmar en el bucket que apareció un archivo
   `manitas-backup-YYYY-MM-DD.sql.gpg` del tamaño esperado (no 0 bytes).
3. Confirmar que las notificaciones de fallo de Actions están
   activadas en la cuenta de GitHub que administra el repo (Settings →
   Notifications → Actions) — un backup que falla en silencio no sirve
   de nada.

## Ensayo real hecho en la Fase 16 (Release Candidate)

Antes de dar por construido este ticket se corrió el ciclo completo
contra la base de dev real (Docker local): `pg_dump` → cifrar → **el
archivo cifrado descifrado da un `diff` vacío contra el dump
original** → restaurar contra una base nueva → conteo de filas
idéntico tabla por tabla (`users`, `settings`, `expense_categories`,
`variants`, `products`). El mecanismo funciona de punta a punta.

Un detalle real que salió de ese ensayo: si el cliente `pg_dump` que
corre el workflow es más nuevo que el Postgres de destino, el dump
incluye una directiva de sesión (`SET transaction_timeout`, propia de
versiones nuevas) que un servidor más viejo no reconoce — aparece como
un `ERROR: unrecognized configuration parameter` al restaurar, **pero
no afecta los datos** (confirmado con los conteos de filas). El
workflow ya fija `postgresql-client-16` (la misma versión mayor que
`docker-compose.yml`) para evitarlo — si en el futuro se restaura
contra un Postgres de una versión distinta y aparece ese mismo error,
es ese desajuste de versión, no una corrupción del backup.

## Restaurar un backup (manual, para una emergencia real)

Esto es **solo el comando** — la prueba real de que la restauración
funciona de punta a punta, contra una base nueva, es responsabilidad de
la Fase 17 del protocolo de build (`docs/build-protocol/17-*.md`,
"Backup restore drill"), no de este documento.

```bash
# 1. Bajar el backup cifrado del bucket (reemplazar fecha y endpoint).
aws s3 cp s3://<bucket>/manitas-backup-2026-08-30.sql.gpg ./backup.sql.gpg \
  --endpoint-url https://<endpoint>

# 2. Descifrar (pide la passphrase de BACKUP_ENCRYPTION_PASSPHRASE).
gpg --decrypt --output backup.sql backup.sql.gpg

# 3. Restaurar contra una base VACÍA (nunca contra una con datos reales
#    encima — pisa todo lo que encuentra).
psql "$DATABASE_URL_DESTINO" < backup.sql
```

## Por qué GitHub Actions y no el backup del proveedor

BLUEPRINT §9.10: los planes gratuitos de hosting (Render, Neon) tienen
retención mínima o nula — no es algo que se pueda mitigar configurando
mejor el proveedor, hay que tener una copia propia, fuera de esa
infraestructura, desde el primer día que haya un dato real cargado.
