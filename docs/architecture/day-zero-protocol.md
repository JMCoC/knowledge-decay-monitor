# Protocolo Anti-Bloqueo — Día Cero

Estado: diseño aprobado para los tres pilares de `objetivo.md`. Esta base no implementa los ocho tickets del Sprint 1 ni sus flujos E2E. Las decisiones se apoyan en el PRD y los tickets; ante una discrepancia, no cambiar un contrato silenciosamente.

La [arquitectura base del equipo](arquitectura-base.md) desarrolla estos acuerdos en contexto, contenedores, módulos, dependencias, un contrato completo y el Walking Skeleton. [ADR-001](adr/ADR-001-monolito-modular.md) registra la decisión de monolito modular y sus consecuencias.

## 1. ARTEFACTO 1 — Esquema y contratos

- Migración: `supabase/migrations/00001_initial_schema.sql`.
- Tipos de la base: `src/types/database.ts`, generados desde la base local, versionados y consumidos estáticamente. No requieren conectarse a Supabase para compilar.
- Contratos entre módulos: `src/types/contracts.ts`. Son contratos TypeScript, no validadores de runtime ni una afirmación de que las operaciones ya estén implementadas.
- Pruebas SQL: `supabase/tests/database/*.test.sql` (esquema, RLS, integridad y bootstrap).
- Prueba HTTP local: `scripts/check-local-fixtures.mjs` (Auth, REST, Storage y URLs firmadas).

El generador representa `pgvector` como `string` en el contrato de base. Dev 2 valida 384 números finitos y serializa el vector para persistirlo; el DTO de base no debe cambiarse manualmente a `number[]`. Los tipos `Insert`/`Update` reflejan el esquema y no sustituyen Zod ni los permisos SQL.

### Frontera de seguridad

Las cinco tablas tienen RLS. `profiles.id = auth.users.id` y un único `workspace_id` fijan la pertenencia. Las funciones privadas consultan la identidad con `auth.uid()`, sin aceptar un tenant del navegador como autorización. No se utiliza metadata editable de Auth para determinar el rol.

`document_versions` y `document_chunks` repiten `workspace_id` deliberadamente: claves foráneas compuestas impiden asociar hijos a otro tenant, incluso cuando un proceso privilegiado omite RLS. Owner debe pertenecer al mismo workspace. Al borrar el Profile, solo `owner_id` pasa a NULL; el documento conserva su tenant.

Admin y QA Lead pueden leer documentos, versiones y chunks de su tenant. Member no puede leerlos durante Sprint 1: todavía no existen asignaciones. Owner es metadata, no una asignación ni una autorización. Incorporar asignaciones con una migración y pruebas positivas/negativas en Sprint 3.

Profiles: Admin/QA ven los perfiles de su tenant para elegir Owner; Member solo ve su propio perfil. Nadie puede cambiar su rol o tenant directamente. La creación inicial utiliza `bootstrap_workspace(workspace_name, full_name)`: autentica, bloquea el usuario, obtiene su email de Auth y crea Workspace + Admin en una transacción. Invitar, cambiar roles y eliminar usuarios quedan fuera del Día Cero.

Se conceden permisos explícitos; no se depende de los GRANT por defecto de Supabase. `anon` no tiene acceso a las tablas. Los helpers `SECURITY DEFINER` viven en `private`, con `search_path` vacío y ejecución restringida. La clave de servicio es exclusivamente de servidor y evita RLS: cada worker debe resolver el documento/tenant de la versión persistida antes de trabajar. Nunca copiar esa clave a `NEXT_PUBLIC_*`.

### Estados y escritura

- `uploaded → processing → ready | processing_failed` es el contrato del pipeline de Dev 2.
- Una versión no `ready` conserva `version_status = NULL`.
- A lo sumo una versión es `active` por documento. Su ID debe coincidir con `documents.active_version_id` al terminar la transacción.
- La activación se realiza en una única transacción después de persistir todos los chunks. No encadenar dos requests independientes de Supabase para cambiar versión y puntero.
- El esquema comprueba coherencia de estados y relaciones. No puede demostrar que un worker haya ejecutado correctamente parsing o embeddings: las pruebas del pipeline corresponden a S1-04.
- El usuario puede crear documentos y versiones `uploaded` de su tenant; actualizar metadata permitida del documento. Cambiar estados, activar versiones y escribir chunks está reservado al backend privilegiado. `Database.Update` describe columnas SQL, no permisos del usuario.
- Retry reutiliza documento, versión y archivo; solo el pipeline cambia estados. Dev 3 solicita la operación y muestra el resultado; Dev 2 la ejecuta con control de concurrencia. Replace File y aprobación de v2+ no se implementan aquí.

### Storage

Bucket privado `documents, máximo 10 MiB por archivo (10 × 1024 × 1024 bytes). Formatos: PDF, DOCX y Markdown. S1-03 valida hechos declarados (extensión, tamaño, MIME coherente, firma de 8 bytes en memoria); S1-04 valida el contenido real al parsear. El MIME del bucket no demuestra que el archivo sea válido, y una firma de prefijo no distingue un DOCX de un ZIP genérico ni dice nada de un Markdown.

Ruta: `<workspace_id>/<document_id>/<version_id>/original.<ext>`. La política exige una versión registrada cuyo `storage_path` coincida exactamente, además del tenant y rol. Conocer un prefijo no permite abrir o escribir archivos sin registro. Primero se reserva documento/versión `uploaded`; luego se carga el objeto sin sobrescritura; después se inicia el pipeline. Dev 2 debe compensar una carga fallida y limpiar reservas/objetos huérfanos.

Signed URL: Dev 3 recibe `versionId`, valida permisos con el cliente de la sesión y usa una duración de 300 segundos. No acepta bucket, ruta o duración arbitrarios del navegador. La URL es un bearer temporal: no incluirla en logs ni persistirla en las tablas.

## 2. ARTEFACTO 2 — Seed y fixtures

`supabase/seed.sql` se ejecuta sobre una base local recién migrada. No es un script de actualización ni se debe ejecutar en un proyecto remoto. Es reproducible mediante reset local; los IDs permanecen estables. Incluye usuarios Auth con identidades email, perfiles, dos tenants, documentos, versiones y chunks.

| Usuario local | Rol | Tenant |
|---|---|---|
| admin.a@example.test | Admin | Workspace A |
| qa.a@example.test | QA Lead | Workspace A |
| member.a@example.test | Member | Workspace A |
| admin.b@example.test | Admin | Workspace B |

Contraseña común de fixtures: `LocalOnly-KDM-2026!`. Son credenciales públicas de desarrollo, nunca cuentas de producción.

| Fixture | Tenant | Procesamiento | Estado funcional | Puntero activo |
|---|---|---|---|---|
| Incident response | A | ready | active | v1 |
| Engineering handbook | A | processing | NULL | NULL |
| Recovery drill | A | processing_failed | NULL | NULL |
| Private policy B | B | ready | active | v1 |

Los vectores son unitarios sintéticos de 384 dimensiones, no embeddings semánticos de `gte-small`. Sirven para probar persistencia/aislamiento; no para evaluar calidad de búsqueda. El documento fallido contiene Markdown válido: el fallo está simulado en SQL y permite probar posteriormente un retry exitoso. El fixture `processing` permanece así hasta que un worker lo procese.

Los archivos reales están bajo `supabase/fixtures/storage/`. `seed.sql` no escribe blobs ni inserta manualmente en `storage.objects`. Se cargan mediante `supabase seed buckets --local`, con la configuración del bucket en `supabase/config.toml`.

La CLI también puede cargar el bucket durante `start`. Su MIME para Markdown incluye `charset=utf-8`; la lista permitida contempla esa variante. Los tests SQL crean metadata de Storage dentro de una transacción que se revierte; solo la prueba HTTP comprueba blobs reales.

## 3. ARTEFACTO 3 — Dominios, ownership y Git

Estructura objetivo; solo se crean archivos con una responsabilidad real. No añadir carpetas vacías, repositorios genéricos, managers o servicios intermediarios.

```text
src/
  app/                         # Composición de rutas
    (auth)/                    # Dev 1
    (workspace)/
      layout.tsx               # Dev 1
      repository/              # Dev 3
  modules/
    identity/                  # Dev 1: sesión y autorización
    workspace/                 # Dev 1: bootstrap y miembros
    ingestion/                 # Dev 2: upload, parsing, embeddings, retry
    repository/                # Dev 3: lista, filtros, signed URLs, estados UI
  lib/supabase/                # Dev 1: clientes de sesión y servidor
  components/shell/            # Dev 1
  types/
    database.ts                # Dev 1 integra cambios de esquema
    contracts.ts               # Dev 1 coordina, consumidores revisan
supabase/
  migrations/                  # Dev 1 coordina orden; autor por ticket
  seed.sql                     # Dev 1
  fixtures/storage/            # Dev 2
  tests/database/              # Dev 1: RLS; Dev 2 añade invariantes de ingesta
tests/e2e/
  auth/                        # Dev 1
  repository/                  # Dev 3, coordinado con Dev 2
.github/workflows/             # Dev 1
```

### Matriz de propiedad

| Archivos/carpeta | Propietario exclusivo | Consumidores / coordinación |
|---|---|---|
| `src/modules/identity/**`, `src/modules/workspace/**` | Dev 1 | Dev 2 y 3 importan API pública |
| `src/app/(auth)/**`, layouts, `src/components/shell/**`, `src/lib/supabase/**` | Dev 1 | Rutas Repository importan el shell |
| `src/modules/ingestion/**`, `supabase/fixtures/**` | Dev 2 | Dev 3 consume upload/retry mediante contrato |
| `src/modules/repository/**`, `src/app/(workspace)/repository/**` | Dev 3 | Usa identidad e ingesta públicas |
| `src/types/**`, `supabase/seed.sql`, `supabase/config.toml` | Dev 1, integrador | Cambios solicitados con ejemplo y prueba |
| `supabase/migrations/00001_initial_schema.sql` | Dev 1 hasta congelar; inmutable después | Todos consumen |
| Cada nueva migración | Autor registrado antes de crearla | Dev 1 revisa orden y tipos |
| `supabase/tests/database/001_day_zero.test.sql`, `002_rls.test.sql`, `004_bootstrap.test.sql` | Dev 1 | Otros añaden archivos propios |
| `supabase/tests/database/003_integrity.test.sql` | Dev 2 | Dev 1 revisa cambios de restricciones |
| `supabase/tests/database/005_ingestion.test.sql` | Dev 2 | Cubre RPC `reserve_document`, `size_bytes` y policies del bucket |
| `supabase/tests/database/010_processing.test.sql` | Dev 2 | Cubre RPC `finish_processing`, CAS claim, aislamiento tenant |
| `supabase/migrations/<ts>_finish_processing.sql` | Dev 2 redacta; Dev 1 revisa orden y regenera tipos | Cerrada en S1-04 |
| `supabase/functions/embed/**` | Dev 2 | Edge Function `supabase.ai.Session('gte-small')`, 384 dims; consumida por `embeddings.ts` |
| `src/app/api/ingestion/process/**` | Dev 2 | Route Handler interno con token `INGESTION_INTERNAL_TOKEN` (server-only) |
| `scripts/check-processing-fixtures.mjs` | Dev 2 | Escenario end-to-end S1-04; requiere Next.js dev + Edge Function |
| `tests/fixtures/processing/**` | Dev 2 | Fixtures DOCX real y PDF vacío (fuera de `supabase/fixtures/storage/` para no romper `seed buckets`) |
| `scripts/check-local-fixtures.mjs` | Dev 1 | Dev 2/3 solicitan nuevos escenarios |
| `tests/e2e/auth/**` | Dev 1 | S1-01 |
| `tests/e2e/repository/**` | Dev 3 | Dev 2 entrega fixtures y readiness del worker |
| Configuración raíz, dependencias, lockfile, observabilidad, workflows CI | Dev 1 | Una modificación coordinada por vez |
| `docs/architecture/day-zero-protocol.md` | Dev 1 | Revisión conjunta al cambiar un contrato |

Cada módulo expone sus funciones desde un `index.ts` cuando exista implementación. Importaciones entre módulos solo desde esa interfaz y `src/types`; nunca desde archivos internos. La fachada expone funciones existentes; no añade una capa de forwarding. `src/app` compone UI y acciones, sin duplicar autorización ni pipeline.

Contratos: identidad devuelve actor verificado; Repository consulta datos con RLS; ingesta recibe `versionId` para retry, vuelve a resolver autorización/tenant y devuelve estado aceptado. El frontend no fabrica un `Actor` para otorgarse permisos. Los contratos permiten usar fixtures mientras otro módulo se implementa; no se añaden bypasses de Auth a producción.

### Protocolo de integración

1. `main` protegida; ramas cortas `feat/s1-03-upload-dev2`, `fix/s1-02-rls-dev1`. Una rama por ticket o entrega pequeña. Integrar a diario mediante PR; evitar una rama por desarrollador durante todo el sprint.
2. Antes de editar un archivo ajeno, solicitar el cambio a su propietario o transferir explícitamente ownership en el ticket. No realizar refactors/formateos globales. Para dependencias y lockfile, Dev 1 integra una solicitud a la vez.
3. Convención de commits: `feat(ingestion): reserve initial version`, `test(rls): reject cross-tenant owner`. Incluir ticket, cambio de contrato y validación en el PR. No commitear secretos, `.env`, puertos particulares ni archivos generados de runtime.
4. Antes de una migración, reservar timestamp UTC y dominio con Dev 1; usar `supabase migration new <dominio>_<cambio>`. No reescribir una migración compartida. Si dos cambios dependen entre sí, fijar orden antes del merge; probar todo desde base vacía.
5. Cambios de contrato: productor propone firma, consumidor revisa y se integra un PR pequeño antes de usarla. Preferir cambios aditivos. Dev 1 regenera `database.ts`; no resolver conflictos de tipos combinando líneas manualmente.
6. Integrar mediante squash, exigir revisión y checks verdes sobre la rama actualizada. CI final de S1-08 debe ejecutar lint, TypeScript, Vitest y pruebas SQL reales de RLS; los E2E de Auth/Workspace y Upload/Repository son requisito del cierre del sprint. Los checks no sustituyen proteger la rama y bloquear despliegues en el proveedor.

No se puede garantizar cero conflictos de Git. Esta política reduce las superficies compartidas y evita que los tres desarrolladores implementen el mismo archivo.

## 4. GUÍA DE ARRANQUE DÍA CERO — Cinco pasos

Ejecutar desde PowerShell en `C:\KDM\knowledge-decay-monitor`. Usar Node.js compatible con `packageManager` y Docker Desktop con motor Linux activo. El repositorio fija pnpm 12.5.1 y el lockfile fija Supabase CLI. No ejecutar `supabase init`: ya existe configuración.

1. **Preparar dependencias.**

   ```powershell
   node --version
   docker info --format '{{.ServerVersion}}'
   npx pnpm@12.5.1 install --frozen-lockfile
   ```

   Esperado: instalación completa sin modificar el lockfile. Si Docker no responde, iniciar Docker Desktop antes de continuar.

2. **Arrancar y reproducir la base local.**

   ```powershell
   npx pnpm@12.5.1 exec supabase start
   npx pnpm@12.5.1 exec supabase db reset --local
   ```

   El reset elimina los datos del proyecto **local** y aplica migración + seed. Usarlo solo sobre fixtures descartables. Esperado: migración y seed sin errores. Si hay puertos ocupados, revisar otro stack local antes de cambiarlos. No usar `--linked` ni un connection string remoto.

   En esta máquina el primer arranque falló por salud de Analytics/Logflare. Si ocurre ese error específico, arrancar con `npx pnpm@12.5.1 exec supabase start -x logflare,vector`. Esta exclusión omite el colector de logs llamado `vector`, **no** la extensión PostgreSQL `pgvector`; Auth, Storage y la base siguen activos. No usar `--ignore-health-check` para esconder fallos de esos servicios.

3. **Cargar originales y revisar fixtures.**

   ```powershell
   npx pnpm@12.5.1 exec supabase seed buckets --local
   ```

   Abrir Studio en `http://127.0.0.1:54323`. Esperado: dos workspaces, cuatro usuarios Auth y cuatro documentos; bucket `documents` privado con cuatro archivos. Studio usa permisos administrativos: ver los dos tenants allí NO valida RLS. Correos locales en `http://127.0.0.1:54324`.

4. **Ejecutar los controles de la base.**

   ```powershell
   npx pnpm@12.5.1 test:db
   npx pnpm@12.5.1 test:fixtures
   npx pnpm@12.5.1 typecheck
   npx pnpm@12.5.1 lint
   ```

   Esperado: pruebas de aislamiento y restricciones aprobadas. `typecheck` ejecuta `next typegen` antes de `tsc --noEmit`: el scaffold usa `LayoutProps`, generado por Next.js, y un checkout nuevo todavía no lo tiene. Dev 1 regenera tipos SQL tras cada migración con `supabase gen types typescript --local --schema public`; guardar la salida UTF-8 en `src/types/database.ts` y revisar el diff. No sobrescribirlo con salida de un comando fallido. Las pruebas SQL/HTTP de fixtures no sustituyen E2E de la aplicación.

5. **Preparar configuración y arrancar Next.js.**

   ```powershell
   npx pnpm@12.5.1 exec supabase status
   npx pnpm@12.5.1 dev
   ```

   El comando `status` muestra credenciales locales: no adjuntar su salida a tickets ni logs. Cuando Dev 1 conecte Auth, crear `.env.local` con `NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` usando la publishable key local (o acordar el nombre anon si el cliente elegido usa legacy keys). La clave privilegiada, si la ingesta la necesita, se llama `SUPABASE_SERVICE_ROLE_KEY`, sin prefijo público. No es necesaria para compilar los tipos. Hoy Next muestra el scaffold existente; todavía no hay formulario de login, Repository ni worker. Cada dev parte de sus fixtures/contratos y de su rama de ticket.

### Acciones externas

- **Ahora:** no hace falta proyecto Supabase alojado, SMTP real, proveedor LLM ni claves para embeddings. Docker local es suficiente para estos artefactos.
- **Al desplegar S1:** Dev 1 crea un proyecto Supabase de desarrollo, comprueba su versión mayor de PostgreSQL y configura las variables del hosting. Aplica las migraciones versionadas con un flujo revisado de `link`/`db push`; nunca sube `seed.sql` ni fixtures de Auth al remoto. No modificar tablas a mano en el Dashboard.
- **Auth remoto:** habilitar email/password, fijar Site URL y URLs exactas de retorno para confirmación/recuperación según las rutas que implemente S1-01; configurar SMTP para correos reales. La configuración local actual usa `127.0.0.1`; no intercambiar `localhost` sin actualizar allowlists. No dar por operativo Forgot Password antes del E2E.
- **Storage remoto:** la migración crea el bucket privado y sus políticas. Verificar privacidad y límite; cargar documentos mediante el flujo autenticado de la aplicación. Nunca usar el seed local de buckets contra remoto.
- **Git/hosting:** configurar protección de `main`, revisores reales y checks obligatorios cuando Dev 1 implemente S1-08. Asignar personas reales a Dev 1/2/3; no se crea un CODEOWNERS con cuentas inventadas. El despliegue debe depender de esos checks.
- **Ingesta:** Dev 2 verifica disponibilidad de `gte-small` en el runtime elegido y ejecuta el pipeline real. Los vectores mock no demuestran disponibilidad del modelo. No se necesita Cerebras/Groq en Sprint 1.
- **Sentry:** ya existe integración base; S1-08 debe comprobar filtrado de secretos, contenido, chunks y URLs firmadas antes de usar documentos reales.

### Fuentes consultadas con find-docs / Context7

- [Flujo local y reset](https://supabase.com/docs/guides/local-development/cli-workflows).
- [Migraciones y seed de Storage](https://supabase.com/docs/guides/local-development/database-migrations).
- [RLS y helpers privados](https://supabase.com/docs/guides/database/postgres/row-level-security).
- [Pruebas de base de datos](https://supabase.com/docs/guides/local-development/testing/overview).
- [Next.js typegen](https://nextjs.org/docs/app/api-reference/cli/next#next-typegen-options), contrastado también con `node_modules/next/dist/docs/01-app/03-api-reference/06-cli/next.md` de la versión 16.3.5 instalada.

La evidencia de ejecución y las limitaciones de esta entrega se registran en `docs/architecture/day-zero-verification.md`.

## 5. Actualización de contratos para S1-02 — 2026-10-03

La base de este protocolo describe el diseño previo a los tickets. Para roles, carga y Repository, la implementación aprobada de S1-02 es la fuente posterior y más específica: [spec](../superpowers/specs/2026-10-02-s1-02-tenant-isolation-integration-design.md), [aceptación local y límites](../testing/s1-02-acceptance.md) y [runbook de corte](../testing/s1-02-cutover.md).

- Identidad y Profile persistido determinan rol y tenant; Owner no concede permiso. Admin/QA pueden usar Repository y upload de su tenant; Member no accede a documentos ni originales.
- El ciclo S1-02 usa reserva idempotente service-only, intento temporal por transferencia, verificación de bytes/hash y publicación inmutable del original canónico. Las rutas y hashes no se exponen a la UI ni a consultas públicas.
- Upload y procesamiento no son equivalentes: S1-02 deja `processing_status = uploaded`, sin estado funcional ni puntero activo. Parser, embeddings, chunks y activación transaccional permanecen en S1-04; Retry Processing sigue en S1-07.
- La recuperación y limpieza trabajan sobre el intento temporal exacto; nunca eliminan documentos/versiones o un canónico. Otro Admin/QA del mismo tenant puede reanudar tras comprobar hash/tamaño persistidos con RPC service-only. La reconciliación legacy precede cualquier apertura.
- El bucket local `documents` limita a 10 MiB y las cargas del navegador van directo a Storage para no cruzar el límite de body de 4.5 MB de Vercel. El `42P10` del volumen local anterior se resolvió con un proyecto local aislado que aplicó la migración administrada de Storage; la aceptación actual prueba Storage real y carga de 10 MiB. Consulta el acta vigente; no debilitar RLS ni modificar índices internos administrados por Storage.
- La instalación local actual contiene migraciones S1-02 hasta `20261003214934`. Se validaron instalación limpia y upgrade desde Dev 2. Esto no implica aplicación cloud. No usar `--linked`, `db push` remoto, seed o reset cloud como verificación local.
