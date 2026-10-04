# S1-02 — Runbook de corte Supabase/Vercel

Este runbook registra el corte local y remoto. No contiene credenciales ni valores de variables. El 2026-10-04 UTC se aplicaron en Supabase las 13 migraciones pendientes, en dos fases y al ref explícito `cdyjtoheovbvewewicaa`. El usuario confirmó que los archivos y registros existentes no necesitan conservarse; el plan Free no ofrece un backup físico disponible ni PITR. No se borraron registros ni objetos durante esta ejecución.

## Registro de ejecución

| Fase | Timestamp UTC | App SHA | Migraciones/esquema | Modo | Resultado/evidencia |
|---|---|---|---|---|---|
| Expansión local | 2026-10-03, ejecución local | `661eaf4` + cambios sin commit | `20260930182112_reserve_document`, `20261003044516_s1_02_upload_expand` | `paused` | `test:db` aprobado; el bloqueo local `42P10` se resolvió usando una instalación local aislada con migración Storage interna limpia. |
| Corte local | 2026-10-03, ejecución local | `661eaf4` + cambios sin commit | `20261003045927_s1_02_upload_cutover`, `20261003051326_s1_02_upload_rpc_fix`, `20261003114725_s1_02_upload_conflict_fix`, `20261003124137_s1_02_upload_cleanup_marker`, `20261003130519_s1_02_upload_resume_target`, `20261003131708_s1_02_legacy_reference_provenance`, `20261003134628_s1_02_rpc_conflict_state`, `20261003143620_s1_02_legacy_reconciliation`, `20261003143823_s1_02_legacy_reconciliation_fix`, `20261003150154_s1_02_repository_projection`, `20261003214934_s1_02_upload_resume_reference_guard` | `active` en fixtures locales; la prueba restaura `paused` | `test:db`, integración, upload Storage real de 10 MiB y recuperación aprobados localmente. |
| Instalación limpia local | 2026-10-03, stack descartable | `661eaf4` + cambios sin commit | 14 migraciones, de `00001` a `20261003214934` | No aplica | Reset limpio y `test db`: 9 archivos/198 aserciones aprobados. |
| Upgrade local desde Dev 2 | 2026-10-03, stack descartable | `661eaf4` + cambios sin commit | Base `20260930182112`; luego 12 migraciones S1-02 hasta `20261003214934` | No aplica | Upgrade y `test db`: 9 archivos/198 aserciones aprobados. |
| Preflight cloud (solo lectura) | 2026-10-03 | Sin despliegue asociado | Proyecto `Knowledge Decay Monitor`, ref `cdyjtoheovbvewewicaa`, estado `ACTIVE_HEALTHY`. Antes del cambio solo `00001` estaba aplicada. Conteos: 2 workspaces, 0 documentos, 0 versiones y 4 objetos en `documents`. `backups list`: `backups=null`, `pitr_enabled=false`. | Sin escritura | Destino confirmado por CLI. Los 4 objetos no tenían versión asociada. El usuario confirmó que los datos existentes eran descartables. |
| Expansión cloud | 2026-10-04 UTC | `661eaf4` + cambios locales sin commit | `20260930182112_reserve_document`, `20261003044516_s1_02_upload_expand` | `paused` | Dry run y `db push` aprobaron exactamente estas 2 migraciones. Sin seed ni roles. `migration list` confirmó ambas aplicadas. |
| Corte cloud | 2026-10-04 UTC | `661eaf4` + cambios locales sin commit | Las 11 migraciones restantes, desde `20261003045927_s1_02_upload_cutover` hasta `20261003214934_s1_02_upload_resume_reference_guard` | `paused` | Dry run y `db push` aprobaron exactamente 11 migraciones. Sin seed ni roles. Historial remoto completo hasta `20261003214934`; `uploads_enabled=false`. Conteos posteriores: 2 workspaces, 0 documentos, 0 versiones; los 4 objetos siguen en Storage sin versión asociada. |
| Activación Vercel/Sentry/GitHub | — | — | — | — | Pendiente: dominio verificado, pero Preview carece de secreto server-only y no se comparó el valor de origin/Supabase URL; `develop`/`main` no están protegidas y Preview/Production no tienen protection rules; recepción Sentry no verificada. |

El modo local debe consultarse al iniciar el runbook; las pruebas de integración lo cambian durante su ejecución y lo restauran al terminar. En cloud, el corte dejó `upload_mode = paused`; no asumir que uploads están habilitados.

## Estado y pendientes tras el corte

- **Resuelto solo para desarrollo local:** el volumen anterior tenía un índice interno incompatible con el target `ON CONFLICT ... COLLATE "C"`, lo que causaba `42P10`. Se preservó ese volumen y se cambió el project id local a `knowledge-decay-monitor-s1-02`; el stack aislado creó el índice correcto mediante sus propias migraciones. El upload Storage real, la integración completa y la carga de 10 MiB pasan. No se modificaron índices/policies de `storage.objects` y no se tocó cloud.
- **Backup:** `supabase backups list` devolvió `backups=null` y `pitr_enabled=false` en el plan Free. El usuario indicó que los registros actuales no requieren conservación. No se creó una copia lógica porque contendría datos de Auth y no respaldaría los objetos de Storage.
- **Objetos existentes:** hay 4 objetos del bucket `documents` y 0 filas en `document_versions`; no se leyeron ni borraron los bytes. El modo sigue `paused`. No activar cargas hasta completar el despliegue y decidir si se limpian estos objetos.
- **Reconciliación:** el script `reconcile-legacy-uploads` no se ejecutó. El conteo remoto de versiones es 0; los 4 objetos de Storage no tienen una fila de versión asociada y quedan fuera de la reconciliación de versiones.
- **Aplicación:** Vercel aún muestra un deployment Production sobre `main` (`01516ddb`) y el más reciente de `develop` sobre `661eaf4`; ninguno incluye los cambios locales S1-02. No se compararon los valores de URL/origin, así que no se confirmó si esos deployments usan este Supabase. Si apuntan a él, sus cargas antiguas no son compatibles con las políticas nuevas. No se pausó ni desplegó Vercel.
- **Aceptación pendiente:** comparar URL/origin de Supabase en Preview/Production; desplegar S1-02 y verificar Auth hospedado, matriz de roles, upload/lectura real de 10 MiB y denegaciones; verificar evento y source maps en Sentry; requerir CI y protección en GitHub. No se activaron uploads.

## Procedimiento por fases

### 1. Expansión

1. Confirmar project-ref, organización y base de destino; comparar con el ticket y dejar el identificador revisado en el registro interno, no en logs públicos. **Completado para esta ejecución:** ref `cdyjtoheovbvewewicaa`.
2. Crear `.artifacts/s1-02-expand/supabase/` ignorado por Git con `config.toml` y el historial exacto hasta `20261003044516_s1_02_upload_expand`. No mover ni editar las migraciones fuente.
3. Comparar rutas y hashes de cada archivo copiado con el repo. Ejecutar `migration list` y `db push --dry-run` con el mismo workdir. El dry-run solo puede mostrar la migración pendiente aprobada de Dev 2 y la expansión S1-02.
4. Tras revisión del destino, backup o decisión documentada de que los datos son descartables, dry-run y aprobación explícita de la ventana cloud, aplicar únicamente ese workdir. No incluir seed/roles ni usar `--include-all`, `--include-seed`, `--include-roles` o `--yes`. **Completado en esta ejecución.**
5. Consultar el historial de migraciones, comprobar `mode = paused`, políticas y bucket privado de 10 MiB. La app nueva debe permanecer en pausa para uploads.

Ejemplo para una ventana futura, después de sustituir `<PROJECT_REF_CONFIRMADO>` y revisar el dry-run:

```powershell
node node_modules/supabase/dist/supabase.js db push --workdir .artifacts/s1-02-expand --project-ref <PROJECT_REF_CONFIRMADO> --skip-vault --dry-run
node node_modules/supabase/dist/supabase.js db push --workdir .artifacts/s1-02-expand --project-ref <PROJECT_REF_CONFIRMADO> --skip-vault
```

La CLI local instalada es 2.117.0. No actualizarla incidentalmente. Consultar `db push --help` y `migration list --help` de esa versión antes de la ventana; detenerse si las opciones o la lista no coinciden con este registro.

### 2. Corte, reconciliación y proyección

1. Detener el app antiguo y cualquier escritor/retry en vuelo; capturar evidencia de quiescencia.
2. Preparar `.artifacts/s1-02-cutover/supabase/` con historial hasta expansión y el resto de migraciones revisadas, verificando rutas/hashes. Hacer dry-run y revisar una por una las migraciones pendientes antes de aplicarlas.
3. Aplicar el corte en ventana acordada. Confirmar por SQL que las escrituras antiguas y los accesos de Member/tenant ajeno están denegados.
4. Ejecutar `reconcile-legacy-uploads.mjs --target linked --mode inspect` con project-ref explícito. Revisar contadores/IDs anonimizados. Si faltan datos o hay contenido no verificable, detenerse y mantener pausado; nunca reabrir el bypass viejo.
5. Con aprobación operativa, ejecutar `--mode apply` sobre el mismo destino delimitado y después repetir `inspect`. Verificar que versiones activas, punteros, chunks y estados históricos válidos se conservaron.
6. Regenerar tipos desde el esquema destino y comparar el diff; consultar la vista Repository y las políticas. Mantener el modo pausado hasta superar toda la matriz de roles, almacenamiento y estado.
7. Activar el modo de carga solo mediante el mecanismo administrativo revisado, después de aplicar las políticas finales y demostrar que la app antigua no puede escribir.

### 3. Vercel, Sentry y GitHub

- Verificar Node.js, `maxDuration >= 90s`, origen por entorno y variables de Preview/Production por nombre y scope. Probar que los bytes van directo a Storage y las Server Actions reciben solo metadata. No guardar HAR, signed URLs ni respuestas de proveedor.
- Hacer una transferencia sintética de 10 MiB y otra de 10 MiB + 1, abrir los bytes reales del original confirmado, y descargar el original como Member/tenant ajeno y el temporal como Admin/QA/Member; las últimas deben denegarse.
- Emitir un evento sintético de `ingestion` y uno de `repository`; localizar ambos en Sentry por `correlationId` y comprobar que no hay request, breadcrumbs, usuario, filenames, hashes, contenido, paths o tokens.
- Requerir los checks de CI en `develop`/`main`, proteger el gate de promoción y demostrar bloqueo con una rama efímera controlada. La consulta actual devuelve `Branch not protected` en ambas ramas; no hacer esta escritura remota durante una implementación local.
- Limpiar únicamente usuarios, intentos y objetos sintéticos anotados en el registro. Ejecutar inspect después de limpieza y guardar conteos/estados sanitizados.

### 4. Rollback

Si falla cualquier control, dejar el upload pausado, conservar esquema y datos, y volver a la app compatible previamente acordada. No revertir migraciones destructivamente, no abrir permisos legacy para recuperar disponibilidad y no borrar originales/canónicos. Los links firmados previos pueden seguir válidos hasta vencer (300 segundos); esperar esa ventana antes de afirmar el efecto de una policy nueva.

**Criterio de cierre:** solo cerrar el ticket cuando el historial cloud coincide con las fases registradas, reconciliación fue verificada, Upload 10 MiB y lectura de bytes pasaron en Vercel, las denegaciones de roles/tenant pasaron, Sentry recibió eventos seguros y GitHub bloquea fallos de CI. La evidencia local sola no cierra estas compuertas.
