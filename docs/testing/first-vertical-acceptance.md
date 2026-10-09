# Primer vertical — reporte de aceptación

Fecha de corte del reporte: 2026-10-09. Rama `fix/adjustment_vertical_slice`; el código de Task 6 todavía tiene cambios locales sin commit. SHA base actual: `363fe8af9625e335638f0bdbff420f6af19984b2`.

**Veredicto: abierto. No ejecutar corte remoto ni declarar el vertical terminado.** El recorrido E2E completo quedó en 31/33. Fallaron documentos de nueve y 32 chunks y la recuperación de una lease de 32 chunks. La política aprobada mantiene una llamada por texto y concurrencia máxima dos por intento; no se ha cambiado modelo, límite, timeout ni reintentos para ocultar el resultado.

## Evidencia local

| Área | Resultado | Alcance y límite |
|---|---|---|
| Unit tests | 464/464 | Incluye parser/chunker reales, límites, dispatch, presupuesto, fencing y errores. |
| SQL local | 236/236 | Supabase local; sin reset de la base. |
| Integración local | 20/20 | 14 archivos, limpieza sintética y modo upload restaurado a `active`. |
| TypeScript y tipos | `typecheck` y comparación de tipos generados pasan | El esquema local incluye las migraciones nuevas. |
| ESLint | Archivos modificados pasan | El lint global encontró cuatro errores `require()` en el artefacto ignorado `.artifacts/vertical-audit/probes.cjs` y warnings ajenos; el artefacto no se modificó. |
| Build | Build de producción pasa | Ejecutado contra el código de aplicación actual. |
| E2E completo | **31/33; falla** | Nueve y 32 chunks terminan `processing_failed`; la recuperación tras caída del runtime tampoco vuelve a `ready` en la ejecución completa. El runtime registró respuestas HTTP 546 / `WORKER_LIMIT`. |
| E2E focalizados | Pasa para formatos base, lote de diez, archivo de 10 MiB con fallo controlado, URL firmada expirada a 300 s y recuperación aislada tras caída | La recuperación aislada no reemplaza la suite completa: el mismo recorrido falla bajo carga de la suite. |
| Warm-up local | 8 muestras, concurrencia máxima 2, 4.168 ms; una ejecución pasó | No demuestra estabilidad para documentos de múltiples chunks ni bajo la suite completa. |

La suite completa sí deja evidencia útil de Auth, aislamiento, UI, apertura de originales, límites y upload por lote. No compensa los fallos de aceptación de embeddings. El modo `upload_control` local quedó `active`; no se eliminó información local ni los datos ajenos.

## Inventario remoto, 2026-10-09

| Área | Observación | Estado para aceptación |
|---|---|---|
| Migraciones | Remoto hasta `20261003214934`; local hasta `20261009024913`. El dry-run lista `20261006172303_finish_processing`, `20261009024630_first_vertical_processing_guard` y `20261009024913_first_vertical_repository_lease_read`. | Pendiente. Ninguna migración remota fue aplicada. |
| Edge Functions | No hay funciones desplegadas; falta `embed`. | Pendiente. |
| Datos | `upload_control=active`; 4 documentos y 4 versiones `confirmed/uploaded`; 0 `processing`, 0 `processing_failed`, 0 `ready`, 0 punteros activos. | Preservar; no procesados ni modificados durante este inventario. |
| Vercel | Proyecto `knowledge-decay-monitor`; deployment más reciente `dpl_Cpb8gEASzBBe16WcH3ZMArc4Tw1R` está `READY`, pero la respuesta no confirma `target` ni corresponde al SHA candidato de esta rama. | No es evidencia de aceptación ni rollback compatible confirmado. |
| Configuración Vercel | `INGESTION_INTERNAL_TOKEN` no aparece en Preview ni Production. URL/publishable key y `SUPABASE_SERVICE_ROLE_KEY` sí aparecen en ambos targets. `APP_ORIGIN` aparece en Production y Preview restringido a `develop`; el workflow calcula e inyecta el origen del PR. `SENTRY_AUTH_TOKEN` y `NEXT_PUBLIC_SENTRY_DSN` aparecen en Preview/Production. | Provisionar token interno antes del nuevo deployment. Verificar overrides y callback del PR. No se leyeron valores. |
| GitHub | `main` y `develop`: sin required status checks; rulesets vacíos. `enforce_admins` activo; main requiere una aprobación y develop ninguna. | Falta exigir el check `Quality gates` conservando protecciones actuales. |
| Auth remoto | No se ejecutó recuperación por correo contra los dominios Preview/Production. | Pendiente; requiere buzón controlado y callback exacto. |
| Sentry | El runner local desactiva Sentry. No se validó recepción persistida en `development`, `vercel-preview` ni `vercel-production`. | Pendiente; requiere evento real, correlation ID, environment y release SHA. |

No se ejecutaron escrituras remotas, migraciones, deploy de función, cambios de variables/protecciones, promoción, pausa de uploads ni operaciones sobre los cuatro documentos. El inventario por MCP y el dry-run son lecturas; no prueban compatibilidad de runtime. Aún falta designar al responsable de la ventana e identificar un deployment anterior compatible por ID/SHA para rollback.

## Matriz de cierre

| Criterio | Estado | Evidencia que falta o condición |
|---|---|---|
| Registro, login, logout y roles en local | Parcialmente aprobado | Los E2E locales pasan; falta recorrido remoto en Preview y Production. |
| Upload Markdown, DOCX y PDF textual | Parcialmente aprobado | Los recorridos focalizados pasan; repetir en Preview y Production. |
| Nueve y 32 chunks con vectores completos | **Fallido** | La suite completa recibe `WORKER_LIMIT`; decidir una capacidad segura antes de cambiar implementación y repetir en frío/caliente. |
| Lote de diez archivos y límite 10 MiB | Aprobado localmente | Diez versiones pequeñas llegan a `ready`; el archivo fuera de presupuesto falla sin chunks/puntero y conserva original. Falta remoto. |
| Start/Retry, lease y caída del runtime | Parcialmente aprobado | Retry tras caída pasa aislado; falla al procesar 32 chunks en suite completa. Falta aceptación remota. |
| Filtros, paginación y aislamiento entre tenants | Aprobado localmente | Suites locales pasan; repetir ambos sentidos en Preview y Production. |
| Original y URL firmada de 300 s | Aprobado localmente | Apertura después de expiración con URL nueva pasa; falta remoto. |
| CI completo del SHA candidato | **Fallido/no disponible** | No hay SHA candidato committeado para Task 6 y la ejecución local completa falla 2/33. |
| Esquema/function en Supabase remoto | Pendiente | Tres migraciones y `embed` por desplegar tras superar los gates. |
| Sentry real en tres entornos | Pendiente | Evento persistido y saneado con environment/release por entorno. |
| Recuperación de los cuatro documentos remotos existentes | Pendiente | Revalidar IDs/estado y elegibilidad; aprobación operativa; procesar uno por uno y comprobar puntero/conteos sin crear versiones. |
| Protecciones de integración | Pendiente | Exigir `Quality gates` en `main` y `develop`; verificar por GET. |

## Advisories observados

Security Advisor reportó que `public.rls_auto_enable()` es `SECURITY DEFINER` y ejecutable por `anon` y `authenticated`, y que `public.bootstrap_workspace(text,text)` es ejecutable por `authenticated`. También reportó desactivada la protección de contraseñas filtradas. No se modificaron estas funciones ni la configuración de Auth; revisar intención y alcance antes de Production. Referencias: [anon puede ejecutar SECURITY DEFINER](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable), [authenticated puede ejecutar SECURITY DEFINER](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable) y [contraseñas filtradas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

Performance Advisor reportó 9 claves foráneas sin índice y 2 índices sin uso. Son observaciones informativas; no se cambiaron índices como parte de esta aceptación.

## Siguientes gates

1. Resolver la revisión de capacidad de embeddings sin cambiar silenciosamente la política aprobada. Hasta entonces, mantener fallida la fila de chunks y detener Task 8.
2. Ejecutar de nuevo los E2E focalizados y la suite completa sobre el candidato; obtener CI verde y fijar su SHA.
3. Configurar `INGESTION_INTERNAL_TOKEN` para Preview y Production por un canal secreto. Verificar project ref, publishable/service-role keys, origen por deployment, callbacks y buzón controlado sin escribir valores en el reporte.
4. Aplicar las protecciones y migraciones remotas, desplegar `embed` con JWT verificado y aceptar Preview siguiendo el [runbook](./first-vertical-cutover.md). Si cualquier gate falla, no promover.
5. Repetir la aceptación en Production; luego revisar y recuperar, solo con autorización operativa, las cuatro versiones existentes.

El cierre requiere todas las filas aprobadas en el entorno correspondiente. Un build, deployment `READY`, suite parcial o historial de Día Cero no prueba el recorrido de extremo a extremo.
