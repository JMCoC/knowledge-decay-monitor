# Primer vertical — runbook de corte

Estado del runbook: **preparado; corte bloqueado**. Último inventario: 2026-10-09. Este procedimiento cubre migraciones, función de embeddings, Preview, Production y la recuperación acotada de las cuatro versiones remotas existentes. No autoriza por sí mismo una escritura remota.

## Gate para iniciar el corte

No comenzar Task 8 hasta que el SHA candidato tenga la suite completa verde y la política de embeddings aprobada supere las pruebas de nueve y 32 chunks, el batch de diez archivos y las mediciones en frío/caliente. La spec fija una llamada por texto y concurrencia máxima dos por intento; no se cambian modelo, concurrencia, timeout, cuota ni reintentos automáticamente. El último E2E completo terminó 31/33 y falló en documentos de múltiples chunks y en la recuperación de 32 chunks. Véase el [reporte de aceptación](./first-vertical-acceptance.md).

El inventario actual no está listo para corte: el remoto no tiene `embed`, hay tres migraciones pendientes y Vercel no tiene `INGESTION_INTERNAL_TOKEN`. El modo remoto observado está `active`; las cuatro versiones confirmadas siguen `uploaded` y sin puntero activo. No iniciar el despliegue hasta refrescar y reconciliar este estado.

## Inventario observado

| Sistema | Estado observado | Consecuencia |
|---|---|---|
| Supabase remoto `cdyjtoheovbvewewicaa` | 14 migraciones hasta `20261003214934`; `embed` no desplegada | Hay que revisar y aplicar solo las tres migraciones del dry-run y desplegar la función con JWT verificado. |
| Supabase local | 17 migraciones, hasta `20261009024913`; `migration list --local` confirma que ya están aplicadas | No ejecutar reset ni volver a aplicar migraciones locales. |
| Dry-run remoto | `20261006172303_finish_processing.sql`, `20261009024630_first_vertical_processing_guard.sql`, `20261009024913_first_vertical_repository_lease_read.sql` | Este conjunto debe coincidir en una nueva consulta inmediatamente antes de `db push`. No añadir `--include-all`. |
| Datos remotos | `upload_control=active`; 4 documentos; 4 versiones `confirmed/uploaded`; 0 `processing`, 0 `processing_failed`, 0 `ready`, 0 documentos con puntero activo | Preservar esos cuatro documentos. No resetear, sembrar ni borrar originales. |
| Vercel | Proyecto `knowledge-decay-monitor`; deployment más reciente `dpl_Cpb8gEASzBBe16WcH3ZMArc4Tw1R` figura `READY`, SHA `1f179d9fec12bce304b534ca71e37bd6aa84c765`, sin `target` confirmado por la consulta | No es evidencia de que el SHA candidato esté desplegado o aceptado, ni rollback compatible confirmado. |
| Variables Vercel (solo nombres y targets) | URL y publishable key Supabase, `SUPABASE_SERVICE_ROLE_KEY`, `SENTRY_AUTH_TOKEN` y `NEXT_PUBLIC_SENTRY_DSN` existen en Preview/Production. `INGESTION_INTERNAL_TOKEN` no aparece. `APP_ORIGIN` existe en Production y en Preview solo para la rama `develop`. | Provisionar el token interno en Preview y Production por un canal seguro. El flujo aprobado calcula `APP_ORIGIN` por deployment; verificar su override y callback exactos para el PR. Nunca registrar valores. |
| GitHub | `main` y `develop` tienen `enforce_admins`; `required_status_checks=null`; main pide una aprobación, develop ninguna; rulesets vacíos | Añadir el contexto exacto `Quality gates` a ambas ramas conservando la protección y revisores. Verificar por GET después de aplicar. |

El deployment workflow inyecta el target, release SHA y origen calculado al construir; en el deploy pasa `APP_ORIGIN` y `KDM_DISABLE_SENTRY=0`. `SENTRY_AUTH_TOKEN` se limita al build. No crear variables públicas para suplir secretos del servidor. La aplicación sí exige `INGESTION_INTERNAL_TOKEN` para procesar y reintentar.

## Preflight inmediatamente antes de cualquier escritura

1. Confirmar por MCP/CLI el proyecto y URL de Supabase, el modo de upload, la lista de funciones, el conteo agregado de estados y las migraciones aplicadas. Consultar Vercel por nombres/targets solamente; no recuperar ni imprimir valores. Comprobar en GitHub el SHA del candidato, jobs del workflow, protecciones y reglas.
2. Repetir el dry-run:

   ```powershell
   npx pnpm@12.5.1 exec supabase db push --project-ref cdyjtoheovbvewewicaa --dry-run --skip-vault
   ```

   Detenerse si cambia la lista de migraciones, aparecen funciones o datos no inventariados, o las migraciones locales y remotas divergen de forma distinta a las tres pendientes de la tabla.
3. Confirmar un deployment Preview del SHA probado, los callbacks de Auth necesarios para el dominio exacto del PR, las variables de servidor requeridas y el buzón controlado de aceptación. El workflow de Preview solo acepta un PR abierto, no draft, del mismo repositorio.
4. Antes de pausar, identificar por ID/SHA un deployment compatible para rollback y designar al responsable de la ventana. El deployment que hoy aparece más reciente no tiene target confirmado y no está validado como rollback. Mantener IDs y evidencia mínima; no copiar contenido documental, hashes completos de usuarios, tokens, URLs firmadas ni valores de variables al reporte.

## Aplicación en Preview — solo tras superar el gate

1. Pausar temporalmente upload en el proyecto confirmado y comprobar el resultado por lectura:

   ```sql
   update private.upload_control
   set mode = 'paused', updated_at = clock_timestamp()
   where singleton
   returning mode;
   ```

2. Con el dry-run recién revisado, aplicar solo las migraciones enumeradas y desplegar `embed`:

   ```powershell
   npx pnpm@12.5.1 exec supabase db push --project-ref cdyjtoheovbvewewicaa --skip-vault
   npx pnpm@12.5.1 exec supabase functions deploy embed --project-ref cdyjtoheovbvewewicaa
   ```

   Mantener la verificación JWT de la función. No usar `--include-seed`, `--include-roles`, `--prune`, `--no-verify-jwt` ni reset remoto. Confirmar historial, RPC, permisos, vista Repository, función desplegada y una medición sintética de una entrada con concurrencia dos; no persistir vectores de prueba en datos compartidos.
3. Si una operación falla, mantener upload pausado, no promover y recuperar la aplicación compatible previa. Conservar las migraciones aplicadas y los datos; corregir mediante una migración aditiva. No revertir esquema con SQL manual.
4. Desplegar Preview únicamente por el workflow del repositorio. Exigir `Quality gates` y job Preview sobre el mismo SHA; verificar `READY`, proyecto, URL y metadatos de `githubCommitSha`, `kdmTestedSha`, `kdmRepository` y `kdmTarget`.
5. Ejecutar la matriz completa del reporte con usuarios y workspaces sintéticos. Debe cubrir Auth y recovery por correo, tres formatos, nueve/32 chunks, lote de diez, filtros/paginación, apertura del original, expiración de URL a 300 s, roles/tenant, límites, Start/Retry y lease. Comprobar estados, puntero, chunks, dimensiones, hash y eventos Sentry. Los fallos controlados deben dejar cero chunks y ningún puntero.
6. Retirar solamente los fixtures propios por IDs exactos. Después de la aceptación, acordar y verificar el modo de upload antes de continuar; restaurar `active` si era el modo previo. Production requiere Preview aprobado y una autorización vigente de corte.

## Production y versiones existentes

1. Integrar el candidato mediante PR. El SHA resultante de `main` debe pasar `Quality gates`; comprobar ese SHA, el job Production y el deployment promovido al dominio real. No inferir que el SHA de Preview y el de Production coinciden.
2. Repetir Auth/recovery, aceptación de Repository, embeddings y Sentry desde el dominio Production con cuentas sintéticas distintas a Preview. Confirmar environment `vercel-production` y release SHA en el evento seguro de Sentry. Una respuesta HTTP 200 o un deployment `READY` no sustituye estos recorridos.
3. Antes de tocar datos existentes, volver a consultar las cuatro versiones `confirmed/uploaded`, confirmar elegibilidad e IDs y pedir aprobación operativa para procesarlas. Procesar una versión por vez mediante Admin/QA autorizado o el endpoint interno autenticado. Conservar versión y ruta originales; verificar `ready/active` o fallo controlado, conteos y ausencia de versiones duplicadas. No borrar los cuatro documentos.
4. Restaurar el modo de upload acordado y comprobarlo por lectura. Registrar cualquier advisory de Supabase sin mezclarlo con la aceptación funcional; una violación real de aislamiento bloquea el cierre.

## Rollback y datos

Ante un fallo de compatibilidad, runtime, Auth, Storage, embeddings o aislamiento, detener promoción y mantener upload pausado mientras se recupera un deployment compatible. No borrar ni recrear documentos existentes, no ejecutar seeds/reset, no revertir migraciones aplicadas y no desactivar autenticación del endpoint. Una corrección de esquema debe ser aditiva. Registrar deployment anterior, SHA, migraciones que sí se aplicaron, estado final de upload y criterio fallido.

## Referencias

- [Reporte de aceptación y evidencia](./first-vertical-acceptance.md)
- [Spec aprobada](../superpowers/specs/2026-10-08-first-vertical-closure-design.md)
- [Plan de ejecución](../superpowers/plans/2026-10-08-first-vertical-closure.md)
- [S1-08: protección y despliegue](./s1-08-cutover.md)
- [S1-08: pasos para publicar y cerrar](./s1-08-publicacion-y-cierre.md)
- [Supabase: RPC SECURITY DEFINER ejecutables por anon](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)
- [Supabase: RPC SECURITY DEFINER ejecutables por authenticated](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)
- [Supabase: protección de contraseñas filtradas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)
