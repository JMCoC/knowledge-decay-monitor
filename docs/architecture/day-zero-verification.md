# Validación del Día Cero

Fecha: 2026-09-25. Entorno: Windows, Node.js 24.11.0, pnpm 12.5.1, Supabase CLI 2.117.0, Docker 29.1.2 y PostgreSQL local 17 (imagen Supabase 17.6.1.167).

## Resultado

| Control ejecutado | Resultado observado |
|---|---|
| Instalación con `pnpm install --frozen-lockfile` | Correcta; dependencias y lockfile sin cambios |
| Prueba de esquema antes de crear la migración | 5/5 fallaron por ausencia de las tablas, como se esperaba |
| Migración + seed en Supabase local | Correctos |
| `supabase db reset --local` después del primer arranque exitoso | Recreó base, aplicó `00001_initial_schema.sql`, cargó seed y subió cuatro originales |
| `supabase test db --local` | 4 archivos, **78 pruebas aprobadas**, también después del reset |
| `node scripts/check-local-fixtures.mjs` | **PASS**, también después del reset |
| `supabase gen types typescript --local --schema public` | Generó `src/types/database.ts` desde la base real |
| `next typegen` seguido de `tsc --noEmit` | Correctos, salida 0 |
| `eslint .` | Correcto, salida 0 |
| `git diff --check` | Sin errores de whitespace |

Se ejecutaron los binarios instalados en `node_modules/.bin`; `package.json` expone las mismas operaciones como `typecheck`, `test:db` y `test:fixtures`. Los cambios no agregan dependencias.

## Qué comprueban las pruebas

- RLS activa en las cinco tablas; Admin y QA Lead limitados a su tenant.
- Lecturas directas de tablas y Storage; un ID conocido de otro tenant no concede acceso.
- INSERT/UPDATE cross-tenant rechazados o sin filas afectadas; DELETE directo no concedido.
- Member no accede al repositorio, versiones, chunks ni originales, incluso siendo Owner.
- No hay escalamiento de rol, cambio de tenant ni falsificación de éxito del procesamiento por usuarios autenticados.
- Los FKs impiden Owner, versión y chunk de otro tenant incluso escribiendo con privilegios.
- Versiones fallidas sin activación; puntero activo coherente con la versión; activación conjunta transaccional.
- Eliminar un Profile propietario deja Owner NULL y conserva el tenant del documento.
- Bootstrap con nombres inválidos, usuario sin sesión, usuario ya vinculado, email obtenido de Auth y prevención de workspace huérfano ante una segunda solicitud.
- Cuatro usuarios Auth con identidades email y tres vectores sintéticos de 384 dimensiones.

La prueba HTTP inicia sesión con los cuatro usuarios del seed y consulta documentos por REST. Descarga tres originales mediante URLs firmadas autorizadas (Admin A, QA A y Admin B), rechaza tres solicitudes de firma (A → B, B → A y Member → A) y comprueba que el bucket no expone el original por URL pública. No imprime claves, JWTs, URLs firmadas ni contenido de archivos.

## Hallazgos corregidos durante la validación

1. **MIME del seed de Storage:** la CLI envía Markdown como `text/plain; charset=utf-8`. El bucket rechazaba el fixture con `InvalidMimeType`; se añadieron las variantes UTF-8 de texto en SQL y TOML. Las descargas reales posteriores pasaron.
2. **Tipos globales de Next.js:** `tsc --noEmit` en un checkout nuevo falló por `LayoutProps`. La documentación local de Next.js 16.3.5 y Context7 confirman `next typegen`. El script `typecheck` ahora genera esos tipos antes de compilar.

## Límites y estado local

- El primer arranque completo falló porque Analytics/Logflare no alcanzó estado saludable. El stack usado para validar arrancó con `supabase start -x logflare,vector`. La causa interna de Logflare no se diagnosticó; no se afirma que esté reparado. El servicio de logs llamado `vector` es distinto de `pgvector`, que sí se instaló y probó.
- Supabase local se deja ejecutándose: API `http://127.0.0.1:54321`, Studio `http://127.0.0.1:54323`. Para detenerlo conservando datos: `npx pnpm@12.5.1 exec supabase stop`. No se inició el servidor Next.js.
- Next.js emitió una advertencia de deprecación en la integración Sentry existente: `withSentryConfig` importado desde `@sentry/nextjs`. No bloqueó los controles; su actualización queda para el propietario de observabilidad.
- No se ejecutó un build de producción, Vitest ni Playwright. No hay todavía UI Auth/Repository, validadores Zod de acciones, parser, worker, embeddings reales, retry operativo, flujo E2E ni workflow CI de Sprint 1 implementados en esta entrega.
- Las pruebas no ejercitan solicitudes concurrentes de bootstrap ni pipeline; la serialización del bootstrap se implementa mediante bloqueo de la fila Auth y debe extenderse con pruebas de concurrencia al desarrollar S1-01.
- No se aplicaron migraciones a Supabase alojado, ni se crearon cuentas remotas, secretos de hosting, commits o pushes. El PRD, los tickets y `objetivo.md` preexistentes permanecieron intactos.

La guía operativa y las acciones externas están en [day-zero-protocol.md](day-zero-protocol.md).
