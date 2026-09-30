# Guía para agentes — Knowledge Decay Monitor

## Contexto y fuentes

SaaS B2B para detectar contradicciones y obsolescencia en documentación privada. La IA propone, la evidencia demuestra y las personas deciden. La UI del producto es en inglés; la documentación del equipo puede estar en español.

Antes de implementar un ticket, consultar:

- [PRD](docs/PRD/knowledge-decay-monitor-prd-final.md): alcance y reglas del producto.
- [Tickets](docs/Tickets/tickets.md): aceptación de S1-01 a S1-08.
- [Arquitectura base](docs/architecture/arquitectura-base.md), especialmente secciones 3–6, y [ADR-001](docs/architecture/adr/ADR-001-monolito-modular.md): límites y dependencias.
- [Protocolo del Día Cero](docs/architecture/day-zero-protocol.md): contratos, ownership, fixtures y arranque local.
- [Validación del Día Cero](docs/architecture/day-zero-verification.md): evidencia histórica y límites; no demuestra el estado actual del entorno.

Resolver discrepancias explícitamente; no cambiar silenciosamente el PRD, contratos o decisiones compartidas.

## Estado y mapa del repositorio

La base actual contiene Next.js App Router, React, TypeScript estricto, Tailwind CSS y Sentry; esquema, RLS, bootstrap SQL, fixtures y pruebas locales de Supabase. Consultar versiones en `package.json` y `pnpm-lock.yaml`.

- `src/app/`: rutas, layout y ejemplos iniciales de Next.js/Sentry.
- `src/types/contracts.ts`: contratos entre módulos; las interfaces no implican implementaciones disponibles.
- `src/types/database.ts`: tipos generados del esquema SQL. Regenerarlos al cambiar el esquema; no editarlos ni fusionarlos manualmente.
- `supabase/migrations/`: esquema, permisos, restricciones y RPC versionados.
- `supabase/tests/database/`: pruebas SQL de esquema, RLS, integridad y bootstrap.
- `supabase/seed.sql` y `supabase/fixtures/storage/`: datos y originales descartables locales.
- `scripts/check-local-fixtures.mjs`: prueba HTTP local de Auth, REST y Storage.

La UI de Auth/Repository, pipeline de ingesta, worker, embeddings reales, Vitest, Playwright y CI de Sprint 1 siguen pendientes en esta base. Verificar el checkout antes de asumir que existen. No crear carpetas vacías ni integrar proveedores de sprints futuros para simular avance.

## Arquitectura y convenciones

- Mantener el monolito modular por negocio: `identity`, `workspace`, `ingestion` y `repository` bajo `src/modules/` cuando se implementen. `src/app` compone presentación; `src/lib/supabase` contiene clientes técnicos sin reglas de negocio.
- Usar el alias `@/*` para `src/*` según `tsconfig.json`; conservar el estilo de los archivos próximos al cambio.
- Importar entre módulos solo su interfaz pública (`index.ts`, cuando exista) y contratos. Usar funciones internas directas; no introducir HTTP interno, repositorios genéricos ni capas de forwarding.
- `workspace`, `ingestion` y `repository` pueden depender de `identity`; `repository` solicita upload/retry a `ingestion`. Evitar ciclos, `identity → workspace` e `ingestion → repository`.
- Repository lee proyecciones con sesión y RLS; solicita las escrituras al módulo propietario. No modifica chunks ni estados del pipeline.
- Validar entradas en fronteras con Zod cuando se implemente la operación. Los tipos SQL no validan datos ni conceden permisos. Respetar `ActionResult<T>` y mensajes controlados del contrato.
- Separar entradas de cliente de clientes privilegiados, parsers y workers; no exponer código de servidor mediante barrels mixtos.

## Invariantes de seguridad y negocio

- Derivar tenant y rol de la sesión verificada y del Profile persistido. Nunca autorizar con `workspaceId`, `role`, `Actor` o metadata enviados por el navegador.
- Mantener RLS, GRANT explícitos y relaciones que impidan cruces de tenant. La clave de servicio queda exclusivamente en servidor y exige validar el contexto de cada operación privilegiada.
- En S1, Admin y QA Lead acceden al Repository de su workspace; Member no accede a documentos, versiones, chunks u originales. Owner es metadata, no una asignación ni un permiso.
- Bootstrap crea Workspace y Profile Admin en una transacción. Un usuario pertenece como máximo a un workspace.
- Originales en bucket privado `documents`, ruta `<workspace_id>/<document_id>/<version_id>/original.<ext>`. Resolver la ruta desde la versión autorizada; URLs firmadas de la aplicación duran 300 segundos y no se registran ni persisten.
- Upload: PDF textual, DOCX o Markdown; 1–10 archivos, máximo 10 MiB por archivo. Validar contenido además del MIME declarado.
- Pipeline: `uploaded → processing → ready | processing_failed`. Una versión no lista mantiene `version_status = NULL`. Activar v1 y actualizar su puntero en una única transacción después de persistir el procesamiento completo.
- Retry conserva documento, versión y original, reautoriza y controla concurrencia. Upload y retry no consumen créditos de análisis. Compensar fallos parciales entre Storage y PostgreSQL.
- La búsqueda de S1 es por nombre y filtros. Incluir la última versión aunque no exista versión activa, para mostrar documentos fallidos o en procesamiento.
- No exponer secretos, tokens, documentos, chunks, URLs firmadas ni respuestas crudas de proveedores en logs, Sentry o artefactos.

## Comandos y validación

Ejecutar desde la raíz con pnpm 12.5.1, fijado en `packageManager`. Si pnpm no está disponible, usar `npx pnpm@12.5.1` como prefijo equivalente. Seguir el protocolo del Día Cero para requisitos de Node.js, Docker y preparación local.

| Comando | Propósito / requisito |
|---|---|
| `pnpm install --frozen-lockfile` | Instalar sin cambiar el lockfile |
| `pnpm dev` | Servidor de desarrollo |
| `pnpm typecheck` | Generar tipos de Next.js y ejecutar TypeScript sin emitir |
| `pnpm lint` | ESLint |
| `pnpm build` | Build de producción cuando corresponda al cambio |
| `pnpm exec supabase start` | Arrancar el stack local; requiere Docker |
| `pnpm test:db` | Pruebas SQL sobre Supabase local |
| `pnpm test:fixtures` | Prueba HTTP con seed y blobs locales disponibles |

No existe un script genérico `test` en esta base. Ejecutar controles apropiados: typecheck/lint para TypeScript; pruebas SQL y fixtures para permisos, esquema o Storage; build para cambios que afecten la compilación. Para documentación, revisar enlaces, exactitud y `git diff --check`. Informar qué se ejecutó, su resultado y qué quedó sin validar; no presentar checks estáticos o históricos como prueba E2E.

El seed y sus usuarios son solo locales. Un reset elimina datos: usarlo únicamente sobre fixtures descartables y dentro del alcance autorizado. No aplicar el seed al proyecto compartido, usar `--linked` ni ejecutar migraciones remotas como parte de una verificación local. El workaround histórico de Logflare figura en la validación del Día Cero; no asumir que ese fallo sigue vigente.

## Cambios e integración

- Revisar `git status` antes de editar y preservar cambios ajenos. Limitar el diff al pedido; no hacer refactors o formateos globales.
- Respetar la matriz de ownership del Día Cero: Dev 1 coordina identidad, workspace, esquema, tipos y configuración; Dev 2, ingesta; Dev 3, Repository. Coordinar cambios compartidos y revisar contratos con sus consumidores.
- Añadir migraciones nuevas con orden coordinado; no reescribir migraciones compartidas. Mantener esquema, tipos y contratos coherentes.
- Usar ramas cortas por ticket y commits con ámbito, por ejemplo `feat(ingestion): reserve initial version`. Un PR incluye ticket, comportamiento, cambios de contrato y validación.
- No incluir `.env`, secretos ni archivos generados de runtime. No hacer commit, push, merge o despliegue sin que formen parte del pedido autorizado.

<!-- context7 -->
## Documentación vigente de dependencias

Cuando el pedido trate de una biblioteca, framework, SDK, API, CLI o servicio cloud (sintaxis, configuración, migración, depuración específica o setup), consultar Context7 aunque la tecnología sea conocida. Preferirlo a búsquedas web para documentación de bibliotecas. No hace falta para refactoring, scripts desde cero, lógica de negocio, revisión de código o conceptos generales.

1. Resolver: `npx ctx7@latest library <nombre-oficial> "<pregunta-completa>"`.
2. Elegir por nombre, pertinencia, reputación, snippets y puntuación. Si no encaja, ajustar nombre o consulta.
3. Consultar: `npx ctx7@latest docs <libraryId> "<pregunta-completa>"` y basar la respuesta en esa documentación.

Llamar primero a `library`, salvo que el usuario proporcione un ID `/org/project`. Para versiones concretas, usar el ID versionado devuelto. Máximo tres comandos por pregunta; nunca incluir credenciales en consultas. Ejecutar Context7 fuera del sandbox predeterminado, solicitando la autorización de ejecución que corresponda. Ante DNS/ENOTFOUND/fetch failed dentro del sandbox, reintentar fuera. Ante cuota agotada, informar y sugerir `npx ctx7@latest login` o `CONTEXT7_API_KEY`; no sustituir silenciosamente la consulta por conocimiento previo.
<!-- context7 -->

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
