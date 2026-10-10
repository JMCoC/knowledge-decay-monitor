# S2-01 — acta de aceptación local

Fecha: 2026-10-10

- Workspace: `C:\KDM\knowledge-decay-monitor`
- Rama: `feature/analysis_schema_contracts`
- Base registrada: `f34ed0386a2975fa7efdd463487ec4019a192c67`
- Estado: implementación guardada en tres commits locales; sin push.

## Alcance implementado

Se añadieron los contratos públicos e internos de análisis, incluida una consulta de selección limitada a nombre, categoría, owner y paginación (la elegibilidad ready/active la determina el servidor), fixtures tipados, las seis tablas de persistencia, validación diferida del alcance/evidencia, permisos RLS por Profile persistido, restricciones por columna y cuatro proyecciones `security_invoker`. Las migraciones son:

- `20261010192119_s2_01_analysis_tables.sql`
- `20261010193514_s2_01_analysis_integrity.sql`
- `20261010194238_s2_01_analysis_security.sql`
- `20261010195500_s2_01_finding_initial_state.sql`

El flujo no implementa saldo, proveedor de inferencia, worker, retry operativo, finalización contable ni notificaciones por correo. `analyses.error_code` queda interno; la proyección pública comunica `ANALYSIS_FAILED` para ejecuciones fallidas.

## Evidencia local

| Control | Resultado |
|---|---|
| `npx pnpm@12.5.1 lint` | PASS; 0 errores y 4 advertencias previas en `tests/support/local-sql-session.ts`, `tests/unit/upload-maintenance.test.ts` y `tests/unit/upload-store-finalization.test.ts` |
| `npx pnpm@12.5.1 typecheck` | PASS |
| `npx pnpm@12.5.1 test:unit` | PASS; 58 archivos, 411 pruebas |
| `npx pnpm@12.5.1 test:db` | PASS; 15 archivos, 430 aserciones |
| `npx pnpm@12.5.1 check:database-types` | PASS; tipos coinciden con el esquema local |
| `npx pnpm@12.5.1 test:fixtures` | PASS; login Auth, REST, aislamiento, descargas firmadas y bucket privado |
| `npx pnpm@12.5.1 test:integration` | PASS tras el guard de findings; 17 archivos, 30 pruebas |
| `node scripts/with-local-supabase.mjs integration tests/integration/analysis-isolation.test.ts` | PASS; 3 pruebas focalizadas con fixtures service_role |
| `node scripts/with-local-supabase.mjs integration tests/integration/analysis-concurrency.test.ts` | PASS; 4 pruebas de concurrencia |
| `node scripts/with-local-supabase.mjs build` | PASS; build de producción y generación de rutas |
| `node scripts/with-local-supabase.mjs e2e tests/e2e/auth tests/e2e/repository.spec.ts tests/e2e/repository-filters.spec.ts` | PASS; 18 pruebas de regresión Auth/Repository |
| `git -c core.whitespace=cr-at-eol diff --check` | PASS |

Las migraciones se aplicaron únicamente al Supabase local. Las pruebas HTTP y SQL usaron fixtures sintéticos con limpieza acotada; no se hizo reset ni seed durante esta certificación, ni se cambiaron datos remotos.

Tras la regresión de navegador se verificaron y limpiaron con `cleanupLocalUser` tres workspaces y siete usuarios Auth sintéticos creados por esa corrida; la consulta final confirmó que no quedaban.

## Upgrade S1 → S2

`scripts/check-analysis-upgrade.mjs` exige `CI=true` y `GITHUB_ACTIONS=true`, rechaza contenedores o volúmenes existentes del mismo `project_id`, prepara una copia temporal de los archivos Supabase versionados con solo las migraciones S1, y conserva en memoria hashes de filas S1 seleccionadas, permisos, políticas, bucket y bootstrap. Luego aplica S2 desde el checkout original, ejecuta `supabase test db` y detiene el stack que identifica mediante las etiquetas de proyecto y `workdir`, con `--no-backup`.

El runner **no se ejecutó completo en esta máquina** porque el stack local ya existía. Se verificaron sus dos salidas seguras: rechazo fuera de CI mediante la prueba unitaria y rechazo del stack activo con `Refusing to reuse an existing local stack.`. Los hashes SQL, el inventario semilla y la aserción de seguridad S2 se ejecutaron de forma read-only contra el esquema local actual. El clean upgrade S1→S2 y su cleanup real siguen pendientes de ejecución en el workflow CI; no se presenta esta verificación local como prueba de upgrade.

## Pendientes de aceptación

- El workflow CI aún no ha ejecutado el runner contra un stack descartable. La evidencia aparecerá cuando se publique y corra el candidato.
- No hay consumidores S2 implementados ni propietarios disponibles en este checkout; la revisión externa de contratos queda pendiente. No se envió ninguna comunicación externa.
- Se crearon tres commits locales para persistencia/contratos, verificación CI y documentación. No se hizo push, merge, despliegue ni migración remota.

Next muestra la advertencia existente de instrumentación `onRouterTransitionStart`; la configuración Vite de integración también muestra una advertencia sobre el futuro `configLoader: native`. Ninguna bloqueó las pruebas.
