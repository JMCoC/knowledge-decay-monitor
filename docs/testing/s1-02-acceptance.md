# S1-02 — Acta de aceptación local y límites

Fecha de revisión: 2026-10-04 UTC. Rama `feature/tenant_isolation`, base `661eaf4`. La implementación está registrada en `2cc4aa2`, `6a04794`, `d74419a` y `f6dc98e`; la aplicación todavía no se ha desplegado. Las 13 migraciones cloud sí se aplicaron y `upload_mode` permanece pausado; el detalle está en el [runbook de corte](s1-02-cutover.md).

## Evidencia local

| Control | Resultado | Límite |
|---|---|---|
| `npm run lint` | 0 errores, 6 warnings | Dos en `processing.ts`; cuatro en tests existentes/nuevos de Repository, ingesta y mantenimiento. |
| `npm run typecheck` | Aprobado | Genera tipos Next.js y ejecuta TypeScript; no valida despliegue. |
| `npm run test:unit` | 35 archivos, 217 pruebas aprobadas | Incluye validación, RBAC, consultas, recuperación UI y privacidad de eventos. |
| `npm run test:db` | 9 archivos, 198 aserciones aprobadas | Ejecutado en Supabase local. También se aprobó en instalación limpia y en upgrade desde la base de Dev 2. |
| `npm run check:database-types` | Tipos generados localmente idénticos a `src/types/database.ts` | La generación usa el esquema local; no certifica cloud. |
| `npm run test:fixtures` | Aprobado: Auth, aislamiento REST, descargas y denegaciones | Prueba fixtures locales; no aplica seed ni cambios remotos. |
| Build local | Aprobado con `node scripts/with-local-supabase.mjs build` | No equivale a un build de Vercel. |
| `npm run test:e2e:auth` | 16/16 Chromium aprobadas | Incluye Auth, Repository, QA de otra sesión recuperando, 10 archivos, upload real de 10 MiB, lectura de bytes canónicos y rechazo de 10 MiB + 1. |
| `npm run test:integration` | 11 archivos, 15 pruebas aprobadas | Incluye PostgREST, Storage real, roles/tenant, escrituras temporales denegadas, finalización, respuestas perdidas, recuperación y cleanup. |
| `npm run test:auth:restart` | Aprobado | Comprueba persistencia local del template tras reiniciar Supabase; no valida SMTP/Auth alojado. |
| Sentry SDK con transporte local | Eventos sintéticos de Auth/ingesta aprobados; evento automático descartado | No demuestra recepción en la cuenta Sentry. |

La aceptación de upload comprueba que bytes del navegador viajan directamente a Supabase Storage; Next recibe solo metadata. Se subió un original de 10 MiB y un lote de 10 archivos, se verificó y abrió el original canónico, y se rechazó 10 MiB + 1 antes de transferir. La medición de las peticiones POST de Next confirma que ningún cuerpo binario se acercó al límite de Vercel de 4.5 MB. Esto prueba el diseño local del flujo; el despliegue Preview todavía debe repetir esa aceptación.

La suite E2E de uploads corre serial porque sus casos activan/desactivan una bandera global de la base local. El estado de una carga interrumpida se comprueba en la región del formulario, separada de filas históricas del Repository. La repetición completa Chromium terminó con 16/16 pruebas aprobadas.

La prueba de recuperación muestra que otro QA del mismo workspace puede reanudar con los mismos bytes, que un archivo distinto se rechaza antes de escribir en Storage, que un Member recibe `FORBIDDEN` y que un Admin de otro workspace obtiene el mismo `NOT_FOUND` genérico usado para una versión ausente. Las comprobaciones no revelan hashes ni URLs firmadas.

Las pruebas Storage intentan escribir en la ruta temporal pendiente con sesión Member y Admin de otro workspace antes de la transferencia permitida; ambas peticiones se deniegan y el cliente de servicio confirma que no quedó objeto. Para una fila legacy sin estado/hash, Repository conserva “Needs reconciliation” y no muestra una acción “Recover upload” que no pueda completar el protocolo normal.

## Supabase local y migraciones

El error local `42P10` provenía del índice interno persistido en el volumen anterior de Storage. El stack previo se detuvo conservando sus volúmenes; se inició el proyecto local `knowledge-decay-monitor-s1-02` en una configuración separada. Storage creó su índice con `COLLATE "C"` desde la migración interna vigente y aceptó el upload real. No se editó el esquema administrado `storage.objects` ni se cambió Supabase cloud.

Se verificaron ambas trayectorias de esquema en el stack descartable `.artifacts/s1-02-clean-install`:

- Instalación limpia: 14 migraciones aplicadas, desde `00001` hasta `20261003214934_s1_02_upload_resume_reference_guard`.
- Upgrade: primero se restableció a `20260930182112` (base de Dev 2); luego se aplicaron las 12 migraciones S1-02 pendientes hasta la misma versión final.
- Después de cada trayectoria, las 9 pruebas SQL pasaron con 198 aserciones. La migración `20261003214934_s1_02_upload_resume_reference_guard` también está aplicada al Supabase local principal y sus tipos están regenerados.

El workspace de pruebas `.artifacts` es local e ignorado. Para el corte remoto se usó `--linked` con project-ref explícito; no se hizo reset y no se aplicaron seeds ni roles. Los volúmenes locales anteriores se conservaron.

## Estado remoto después de aplicar migraciones

- **Supabase cloud:** se aplicaron las 13 migraciones que estaban pendientes, desde `20260930182112` hasta `20261003214934`, en dos fases con ref explícito. `migration list` confirma las 14 migraciones del proyecto aplicadas. Los dry runs y pushes no incluyeron seeds ni roles. El upload permanece `paused` (`uploads_enabled=false`). Conteos posteriores: 2 workspaces, 0 documentos, 0 versiones y 4 objetos del bucket `documents` sin versión asociada. No se borraron datos ni se leyeron los bytes de esos objetos.
- **Backup:** `supabase backups list` devolvió `backups=null`, `pitr_enabled=false`; el usuario confirmó que los archivos y registros actuales no requieren conservación. No se creó un backup lógico.
- **Vercel:** siguen existiendo deployments anteriores: Production en `main` (`01516ddb`) y el más reciente de `develop` en `661eaf4`. Los cambios locales de S1-02 no se han desplegado. La revisión previa encontró que faltaba `SUPABASE_SERVICE_ROLE_KEY` en Preview y no comparó los valores de URL/origin, así que no se confirmó si esos deployments usan este Supabase; si lo usan, sus cargas antiguas no son compatibles con las políticas nuevas.
- **GitHub:** `develop` y `main` aparecían sin protección; Preview/Production sin reglas de protección y con un workflow activo. No se alteraron settings ni se disparó un workflow remoto.
- **Sentry:** no se verificaron recepción remota, evento almacenado ni source maps.

## Pendiente para el cierre de extremo a extremo

La implementación y aceptación local de S1-02 están completas, y el historial de migraciones cloud ya está aplicado. El ticket global sigue abierto por estas compuertas de servicios compartidos:

1. Desplegar S1-02 a Preview con el secreto server-only y origin/URL correctos; mantener uploads pausados hasta completar la matriz de roles, denegaciones y el upload/lectura real de 10 MiB. Decidir si se limpian los 4 objetos sin versión.
2. Verificar Auth alojado, el evento sintético seguro y source maps en Sentry.
3. Configurar checks requeridos/protección de ramas en GitHub y demostrar que bloquean una ejecución fallida de CI.

Las migraciones aplicadas no equivalen a aceptación cloud de la aplicación: Preview/Production, Auth, Storage, Sentry y GitHub todavía requieren sus validaciones.
