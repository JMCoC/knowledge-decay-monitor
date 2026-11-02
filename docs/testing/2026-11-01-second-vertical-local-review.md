# Segundo vertical: revisión y prueba local antes de S2-11

Fecha: 2026-11-01. Base revisada: `b7cc147067b6fbbe29a0581a92970a9ac49d6b81` → `d8e5a23`.
Rama: `feature/analysis_completion_failure_notifications`. S2-11 no se implementó.

## Cambios integrados

El historial de primer padre contiene **cinco merges**, aunque se esperaban cuatro:

| PR / merge | Responsabilidad y consumidores |
|---|---|
| #24 / `bb1518a` | S2-07: Cerebras → Groq, prompt y esquema de salida, validación de citas y smoke real. Lo consume el worker de análisis; requiere ambas claves y ambas URLs. |
| #25 / `1437532` | S2-08: staging, publicación de hallazgos/evidencias, liquidación de créditos, eventos y coordinación de locks. Lo consumen los adaptadores del worker y las vistas de lectura. |
| #26 / `fe4ba66` | Seguimiento de S2-08 y documentación de sus comprobaciones/deudas. |
| #27 / `13fa5a2` | S2-09: confirmación de costo, recuperación de comando por idempotencia, estado persistido, Credits y retry tras liberación. Conecta UI → Server Actions → RPC → dispatch Edge. |
| #28 / `d8e5a23` | S2-10: lista, filtros y paginación de hallazgos; panel de evidencia y apertura de la versión original autorizada. Consume proyecciones bajo sesión/RLS. |

Se revisaron los cambios conectados a selección, estimación, ejecución, proveedor, persistencia, estados, créditos y evidencias, junto con contratos, migraciones y pruebas. No constituye una auditoría exhaustiva de cada línea de los 93 archivos modificados.

## Hallazgos de revisión

1. **Bloqueante, corregido localmente: errores del proveedor sin persistir.**
   `src/modules/analysis/worker/finalization.ts` todavía lanzaba la excepción «S2-08b … not available» para un resultado fallido. `runAnalysisJob` la capturaba y devolvía `failed`, pero la fila seguía `processing`, sin código público ni liquidación. Las pruebas de Edge usaban un adaptador de prueba que sí llamaba a `fail_analysis`; la prueba unitaria del adaptador real esperaba la excepción.
   Se conectó el adaptador real al RPC ya existente, preservando fencing y mensajes controlados. `PROVIDER_UNAVAILABLE` vuelve a `queued` con reserva; `ESTIMATE_STALE` termina en `failed`, libera la reserva y crea el evento. Dos regresiones de integración fallaron antes del cambio y pasaron después. No hubo cambios de esquema ni de contratos.
2. **Navegación, corregida localmente:** el breadcrumb `Analysis` de la página de hallazgos enlazaba a `/analysis`; se confirmó HTTP 404 en Chromium. Ahora apunta al destino existente `/analysis/run`.
3. **Contexto de evidencia, corregido localmente:** `findingId` se consultaba por workspace sin comprobar que el detalle perteneciera al `analysisId` de la URL. Se reprodujo en Chromium: una lista vacía de un análisis abría el panel de un hallazgo de otro análisis del mismo workspace. La página ahora verifica `detail.analysisId === analysisId`. RLS sigue aislando otros tenants.

Los tres cambios se mantienen locales, sin commit ni push. Las dos correcciones de página no alteran contratos ni datos.

## Entorno preparado

- Supabase local conservó los 13 documentos y 4 análisis originales después de migrar.
- Se aplicaron, sin reset: `20261021164507`, `20261021181000` y `20261023170850`.
- `.env.local` apunta al stack local y contiene manifiesto de ejecución y token de dispatch. Se preservaron las otras variables existentes. Sentry quedó deshabilitado para las pruebas locales.
- `.env.analysis.local` contiene el token interno correspondiente, URLs de proveedores y espacios vacíos para tus dos claves. Está ignorado por Git.
- IA simulada: `ANALYSIS_FAKE_PROVIDER=1`. **Persistencia y finalización reales:** `ANALYSIS_FAKE_PERSISTENCE=0` y `ANALYSIS_FAKE_FINALIZATION=0`. El proveedor simulado devuelve cero hallazgos por defecto.
- Worker de ingesta: checkout separado `C:\KDM\kdm-demo-worker`, commit `c1a1e6e`. Su modelo `Supabase/gte-small` usa la caché ya existente. No se cambió ese checkout.
- Recuperación local `kdm-analysis-recovery` habilitada cada minuto. URL interna Docker y token en Vault local; no se configuró ningún entorno remoto.

| Servicio | Dirección / comprobación |
|---|---|
| App | http://127.0.0.1:3000/login |
| Studio | http://127.0.0.1:54323 |
| Correo local de Auth | http://127.0.0.1:54324 |
| Ingesta | http://127.0.0.1:8788/health → `200`, `ready` |
| Edge de análisis | http://127.0.0.1:54321/functions/v1/analyze; requiere token interno |

Los procesos arrancados por el agente están activos durante esta sesión. Para futuros arranques, abrir tres terminales desde la raíz y mantenerlas abiertas:

```powershell
Set-Location C:\KDM\knowledge-decay-monitor
node .artifacts/start-review-local.mjs ingestion
```

```powershell
Set-Location C:\KDM\knowledge-decay-monitor
node .artifacts/start-review-local.mjs edge
```

```powershell
Set-Location C:\KDM\knowledge-decay-monitor
node .artifacts/start-review-local.mjs app
```

Estos lanzadores son ayudas de esta máquina dentro de `.artifacts`, ignoradas por Git. El worker se ejecuta desde `kdm-demo-worker`, con credenciales del stack local inyectadas en memoria. No arranques un segundo proceso si el puerto ya está ocupado. En una terminal iniciada por ti, `Ctrl+C` permite detenerla antes de reiniciar. Si necesitas reiniciar el Edge iniciado por el agente, pídele que lo reinicie después de guardar las claves.

La app utiliza el build de producción comprobado. Tras editar código, detener app, ejecutar `node scripts/with-local-supabase.mjs build` y volver a iniciarla. Para desarrollar S2-11 posteriormente se puede usar `pnpm dev` en lugar del proceso de producción, conservando el mismo `.env.local`.

## Tus credenciales de IA

1. Entra a [Cerebras Cloud](https://cloud.cerebras.ai/) y crea una API key en tu cuenta/proyecto. La [guía oficial](https://inference-docs.cerebras.ai/quickstart) describe el acceso y usa `qwen-3.8-27b`, el modelo configurado en este checkout.
2. Crea una key en [Groq Console](https://console.groq.com/keys). Consulta [Quickstart](https://console.groq.com/docs/quickstart) y [modelos disponibles](https://console.groq.com/docs/models); este checkout usa `openai/gpt-oss-20b` como fallback.
3. Verifica permisos, cuota y acceso a esos modelos en tus cuentas. El consumo del proveedor y los créditos internos de KDM son contabilidades diferentes. No necesitas la cuenta del otro desarrollador para usar claves propias.
4. Edita **solo localmente** `.env.analysis.local`. Completa `CEREBRAS_API_KEY` y `GROQ_API_KEY`; conserva las dos URLs. El adaptador exige las cuatro variables, aunque Cerebras sea el proveedor principal. No hace falta una clave de OpenAI para este análisis.
5. Antes de cambiar el modo del Edge, ejecuta el smoke con datos sintéticos y sin imprimir claves:

```powershell
Set-Location C:\KDM\knowledge-decay-monitor
node --env-file=.env.analysis.local --import tsx scripts/analysis-provider-smoke.ts
```

   Esperado: `RESULT: PASS`, salida 0. Comprueba ambos proveedores válidos, principal inválido con fallback válido y ambos inválidos. Este smoke llama a los proveedores y puede consumir cuota; no demuestra por sí solo el recorrido UI completo. Error 2 indica configuración/red; error 1 indica un caso que no cumplió la expectativa. Guarda únicamente metadata sanitizada.
6. Cambia `ANALYSIS_FAKE_PROVIDER=0` en `.env.analysis.local`, guarda y reinicia el proceso **Edge**. Deja los otros dos flags en 0. La app no necesita las claves de los proveedores. No reutilices un análisis ya completado para evaluar el cambio: inicia uno nuevo desde la UI.

## Prueba manual desde la interfaz

1. Abre `/login` y usa tu usuario **local** Admin o QA Lead. Si prefieres aislar la prueba, registra un usuario y crea un workspace nuevo. Los correos se inspeccionan en el buzón local. **Comprueba:** llegas a la app y tienes acceso a Repository y Run Analysis.
2. Abre `/credits` y anota Available/Reserved y el historial. **Comprueba:** existe saldo suficiente para la estimación; no edites el ledger manualmente para eludir controles.
3. En Repository carga `.artifacts/deployment-source.md` y `.artifacts/deployment-comparison.md`, de uno en uno. Asigna nombres distinguibles, categoría Policy y Owner si lo deseas. **Esperado:** «Uploaded — processing pending» y luego `ready`/versión activa. **Comprueba:** el worker responde `ready` y la lista deja de mostrar procesamiento. Si permanece pendiente, revisa primero `.artifacts/review-ingestion.log`.
4. Abre el original de cada archivo. **Comprueba:** abre la versión cargada y las horas difieren (09:00 frente a 11:00). La URL firmada es temporal; no la guardes ni la compartas como evidencia.
5. En `/analysis/run`, pestaña **Documents to analyze**, selecciona el documento source. En **Compare against**, selecciona comparison. **Comprueba:** el resumen contiene exactamente esas dos versiones; no incluyas otros documentos del workspace.
6. Pulsa **Calculate Estimated Cost**. **Comprueba:** aparece el costo y no se reservan créditos por estimar. Cambia la selección y comprueba que exige recalcular; después restaura la selección y estima otra vez.
7. Pulsa **Proceed to Run Analysis**, revisa el costo y cancela una vez. **Comprueba:** cancelar no inicia un análisis ni crea una reserva. Abre de nuevo y pulsa **Confirm and run** una sola vez.
8. **Esperado:** URL `/analysis/<uuid>` y estados `Queued → Processing → Completed` (los estados rápidos pueden no ser visibles). Guarda ese ID. Recarga y comprueba que conserva el mismo análisis, alcance e iniciador. La UI hace polling durante unos dos minutos; después usa **Refresh status** si hace falta.
9. En Completed pulsa **View Analysis Findings**. **Con IA simulada:** lista vacía; esto no prueba consistencia documental. **Con IA real:** inspecciona los hallazgos que produzca; una contradicción explícita ayuda a evaluar el resultado, pero no garantiza que el modelo la devuelva. No inventes un hallazgo si no aparece.
10. Si hay hallazgos, filtra tipo/severidad y abre **View evidence**. **Comprueba:** citas exactas, nombre/versión y apertura del original correspondiente. Cierra con Escape y prueba un filtro sin coincidencias. La asignación y los cambios de estado de revisión no forman parte del recorrido implementado aquí.
11. Vuelve a Credits. **Comprueba:** un análisis exitoso tiene una sola reserva y un solo consumo por su costo fijo; no un consumo por cada fragmento ni un cobro por upload.
12. Para probar un fallo controlado, usa un workspace de prueba, guarda tu configuración y habilita temporalmente `ANALYSIS_FAKE_PROVIDER=1`, `ANALYSIS_FAKE_FAIL_AT_CALL_INDEX=0`, `ANALYSIS_FAKE_FAIL_CODE=ESTIMATE_STALE`, conservando persistencia/finalización en 0. Reinicia Edge e inicia un análisis nuevo. **Esperado:** `Failed`, reserva liberada y botón Retry disponible. Quita las dos variables de fallo, reinicia Edge y usa **Retry Analysis**, revisa el nuevo costo y confirma. **Comprueba:** se crea otro ID enlazado al fallido; el original no se reescribe. Finalmente restaura `ANALYSIS_FAKE_PROVIDER=0` para IA real.

## SQL de comprobación en Studio local

Sustituye el UUID por el análisis de tu prueba. No exportes texto privado, tokens, vectores ni Vault.

```sql
select id,status,fixed_cost,attempt_count,error_code,retry_of_analysis_id,
       created_at,started_at,finished_at,next_attempt_at
from public.analyses where id = '<analysis-id>'::uuid;

select event_type,amount,created_at
from public.credit_ledger where analysis_id = '<analysis-id>'::uuid
order by created_at,event_type;

select type,status,count(*)
from public.notification_events where analysis_id = '<analysis-id>'::uuid
group by type,status;

select count(*) as findings from public.findings
where analysis_id = '<analysis-id>'::uuid;

select jobname,active,schedule from cron.job
where jobname = 'kdm-analysis-recovery';
```

Un `analysis_completed`/`analysis_failed` en `pending` demuestra creación del evento, **no envío de correo**. Ese envío pertenece al trabajo pendiente de S2-11. No se probó Resend ni se enviaron correos de negocio.

## Evidencia ejecutada y límites

| Control | Resultado |
|---|---|
| Unitarias después de la corrección | 108 archivos, **885 pruebas PASS** |
| SQL local | 30 archivos, **1.205 pruebas PASS** |
| Integración: run, locks, finalización | 9 pruebas iniciales PASS; finalización ampliada a 4/4 PASS tras reproducir 2 fallos antes del fix |
| Integración adicional | 21/22 en ejecución compartida; el único fallo fue sweep sin trigger mientras E2E creaba trabajos en la misma cola. Repetición aislada del archivo worker: **5/5 PASS** |
| Chromium S2-09/S2-10 | **5/5 PASS**: duplicación/reload, login, hallazgos/evidencia/lista vacía, retry y acceso Member/cross-tenant |
| Recorrido completo adicional | Chromium subió dos Markdown; el worker separado generó versiones activas con embeddings reales; la UI estimó, confirmó y finalizó vía Edge con IA simulada y persistencia real. Se verificó `Reserved → Consumed`, lista vacía y limpieza de fixtures. |
| Regresión de contexto/navegación | Antes: panel de evidencia ajena visible y enlace `/analysis`. Después de reconstruir y reiniciar: panel ajeno ausente y enlace `/analysis/run`; recorrido completo PASS otra vez. |
| Typecheck y build | PASS; build reconstruido con corrección y configuración local |
| ESLint | 0 errores; 3 advertencias preexistentes en pruebas de upload. Archivos de la corrección sin errores de lint |
| Recovery local | Cron activo; llamadas locales observadas con HTTP 202. Eso demuestra aceptación, no procesamiento de un trabajo por sí solo |

Las suites de Edge/sweep comparten una cola global local: ejecutarlas secuencialmente y sin pruebas UI que creen otros trabajos. La causa de interferencia es una inferencia consistente con el fallo `queued:none:0` y la repetición aislada exitosa; no se capturó el ID exacto que tomó el sweep concurrente.

No se validaron proveedores con tus claves, calidad de IA real, correo de negocio, entorno alojado ni aceptación de S2-11. El contenedor local de logs `supabase_vector` reiniciaba; los servicios de datos/Auth/Storage y pruebas funcionaron. Ese contenedor es el recolector de logs y no es la extensión PostgreSQL `pgvector` usada por embeddings.

Evidencia sanitizada en `.artifacts/review-*.log`; no incluir `.env*` ni `.artifacts` en commits. Cambios de producto: adaptador real, página de hallazgos y pruebas de finalización.
