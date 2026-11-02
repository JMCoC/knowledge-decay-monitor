# S2-11 — Notificaciones terminales de análisis

Fecha: 2026-11-01. Responsable: Juan Manuel. Estado: aprobado por el usuario el 2026-11-01 como base del plan; implementación y despliegue no iniciados.

Revisión independiente de planificabilidad: completada el 2026-11-01, sin preguntas bloqueantes. Se comprobaron los destinos de los enlaces relativos y la ausencia de errores de whitespace. No se ejecutaron pruebas de producto, envíos ni cambios de configuración.

## 1. Propósito y decisiones acordadas

El iniciador de un análisis debe conocer su resultado aunque cierre sesión o salga de KDM. S2-11 convierte los eventos terminales de S2-08 en correos breves, privados y recuperables mediante Resend. El análisis y su contabilidad ya han finalizado cuando comienza esta entrega.

El usuario confirma que el recorrido actual funciona, Supabase local está actualizado y dispone de credenciales propias de Cerebras y Groq. Esto constituye el punto de partida declarado; este diseño no vuelve a certificar ese recorrido. La captura aportada muestra `knowledge-decay-monitor.online` verificado en Resend; el usuario confirma que Resend ya sirve para recuperar contraseñas.

Decisiones confirmadas en la conversación:

- Remitente: `Knowledge Decay Monitor <notifications@knowledge-decay-monitor.online>`.
- Es aceptable revisar avisos pendientes cada minuto y realizar el primer intento aproximadamente en la siguiente revisión.
- La especificación precede al plan. El usuario aprobó el diseño completo el 2026-11-01.

El resto de decisiones concretas de este documento fueron propuestas técnicas del agente y quedaron aceptadas con la aprobación del documento. Las reglas atribuidas al ticket o al PRD no son decisiones nuevas.

## 2. Fuentes y base observada

- [Ticket S2-11](../../Tickets/sprint-2-ai-analysis.md#s2-11--notificaciones-de-análisis-completado-o-fallido): destinatario autorizado, Resend, privacidad, lease, reintentos, idempotencia, pruebas y recepción real.
- [PRD](../../PRD/knowledge-decay-monitor-prd-final.md), §§24, 40, 51, 63, 66 y 68; [acuerdo del vertical S2](../../PRD/sprint-2-ai-analysis-slice.md), §§4–7.
- [Arquitectura base](../../architecture/arquitectura-base.md), [ADR-001](../../architecture/adr/ADR-001-monolito-modular.md) y [Día Cero](../../architecture/day-zero-protocol.md): monolito modular, ownership y clientes privilegiados. La [verificación histórica](../../architecture/day-zero-verification.md) no prueba el estado actual.
- [Diseño de S2-08](2026-10-21-s2-08-analysis-finalization-spec.md): eventos en la transacción terminal y entrega a cargo de S2-11.
- [Revisión local del 2026-11-01](../../testing/2026-11-01-second-vertical-local-review.md): continuidad del vertical y correcciones locales pendientes.

El checkout contiene `notification_events` con estados `pending/sent/failed`, `attempt_count` entre 0 y 3, `next_attempt_at`, `sent_at`, códigos controlados y unicidad `(analysis_id, type, recipient_id)`. Sus FKs relacionan análisis y destinatario con el mismo workspace. No se encontró un despachador de correo de negocio implementado.

La recuperación de contraseña llama a `client.auth.resetPasswordForEmail` en `src/modules/identity/actions.ts`. No es un adaptador de envío reutilizable para eventos de negocio. Se reutilizan cuenta y dominio; S2-11 incorpora su propia integración privada con Resend y conserva la configuración de Auth.

El patrón de scheduling ya existe en `20261017230309_s2_05_analysis_recovery.sql`: `pg_cron`, `pg_net`, Vault y llamada autenticada a una Edge Function. El login actual devuelve `/app` o `/onboarding`; el layout de workspace redirige a `/login` sin conservar un análisis destino. La continuidad del enlace requiere un cambio acotado.

## 3. Alcance y exclusiones

Se entregan exclusivamente `analysis_completed` y `analysis_failed` al iniciador persistido, tanto Admin como QA Lead. Un análisis completado sin findings también genera su aviso. Los errores de intentos intermedios del análisis no generan correos: se consume el evento terminal, no cada fallo del proveedor de IA.

Incluye despachador, migración aditiva, adaptador Resend, dos plantillas versionadas, continuidad del login, observabilidad saneada, pruebas deterministas y demostración de recepción real de ambos mensajes.

Quedan fuera High finding, asignaciones, aprobaciones, digest de 23:00 UTC, preferencias, avisos dentro de la aplicación, reenvío manual, traducciones, adjuntos y tracking de apertura/clic. Tampoco se cambia Cerebras/Groq, la inferencia, findings, ledger o el workflow de recuperación de contraseña. No se amplía S2-11 para resolver la deuda histórica de proveedor/modelo efectivo mencionada en S2-08: esa atribución no corresponde al alcance funcional del ticket y deberá quedar en tracking separado.

No se añaden webhooks de Resend en esta entrega. La aplicación distinguirá aceptación del API de recepción comprobada; incorporar después una proyección de entrega/rebote requiere su propio contrato.

## 4. Comportamiento del correo y del enlace

Dos plantillas de código, HTML sencillo y alternativa de texto plano, versión inicial `s2-11-terminal-v1`. Su contenido no depende de un LLM ni de templates remotos editables.

| Evento | Subject | Mensaje y acción |
|---|---|---|
| `analysis_completed` | `Your analysis is complete` | `Your analysis is complete. Sign in to review the results.` Botón `View analysis`. |
| `analysis_failed` | `Your analysis could not be completed` | `Your analysis could not be completed. Sign in to review its status and available next steps.` Botón `View analysis`. |

Contexto permitido: referencia UUID del análisis y fecha terminal original en UTC, etiquetada como `Completed at` o `Failed at`. No incluir nombres de workspace/documentos/personas, número o severidad de findings, explicaciones, citas, snapshots, coste, saldo, motivos técnicos ni datos del proveedor. El cuerpo del aviso fallido no promete que un reintento sea posible ni invita a ejecutarlo desde el correo.

Cada correo se dirige a una sola dirección; sin CC/BCC, reply-to personalizado, adjuntos, URLs firmadas, enlaces de acceso automático ni tokens de Auth. El mensaje informa de un resultado persistido; no confiere permisos.

El enlace se construye con el `APP_ORIGIN` validado del entorno y la ruta `/login?analysisId=<uuid>`. Con sesión válida, login lleva directamente a `/analysis/<uuid>`. Sin sesión, conserva el UUID durante el formulario y, tras autenticar, abre esa página. La página de estado conserva su acceso a findings cuando corresponde.

Se admite únicamente un UUID de análisis; no se introduce un parámetro genérico de redirección. Rechazar valores repetidos, arrays, URLs, rutas, escapes y UUIDs inválidos, usando el destino normal de login. El login sin parámetro mantiene su comportamiento. Un usuario sin Profile continúa a onboarding; este ticket no incorpora persistencia del destino a través del registro o del bootstrap. Un usuario de otro tenant o Member puede autenticarse, pero la lectura del análisis mantiene los errores controlados y la autorización existente.

Implementación propuesta para limitar impacto: validar el parámetro en la página de login, pasarlo como propiedad al formulario y derivar allí exclusivamente `/analysis/<uuid>` después de un login exitoso cuyo destino normal sea `/app`. Se preservan el contrato `LoginInput` y el resultado `/app | /onboarding` de la acción existente. La navegación nunca sustituye RLS ni autorización del servidor.

## 5. Frontera de ejecución y disparo

El núcleo vive en `src/modules/notifications/`; la frontera técnica es `supabase/functions/dispatch-notifications/`. `analysis` produce eventos en SQL y `notifications` los consume. No se llama a la API de correo desde la finalización del análisis, la UI o una Server Action del usuario. No hay HTTP interno para comunicar módulos.

Un job `kdm-notifications-dispatch` invoca la Edge Function cada minuto. Reutiliza las extensiones y el patrón existentes, con secretos y job propios; no modifica `kdm-analysis-recovery`. No se requiere un segundo disparo inmediato: la cadencia aceptada cubre el caso inicial y la recuperación.

Contrato del disparador propuesto:

- `POST /functions/v1/dispatch-notifications`, cuerpo `{}` de máximo 1 KiB; no admite destinatarios, tenant, correos, contenido o URLs enviados por el caller.
- Bearer interno propio `NOTIFICATIONS_INTERNAL_TOKEN`, mínimo 32 caracteres, validado por el handler antes de consultar datos. No reutilizar el token de análisis ni enviar una nueva clave `sb_secret_...` como Bearer. `verify_jwt = false` solo para esta función; eso no elimina su autenticación en código.
- `202 { accepted: true }` tras autenticar y comprobar configuración, con ejecución acotada mediante `EdgeRuntime.waitUntil`. El 202 no declara que se haya enviado correo. Respuestas controladas: 401 no autorizado, 405 método, 400 entrada y 503 deshabilitado/no preparado, sin detalles de secretos.
- URL de función y token en Vault para cron; secreto de Resend exclusivamente en el runtime Edge. Validar destinos del scheduler igual que el patrón existente: host Supabase del proyecto o destinos Docker locales explícitos y ruta exacta.

Valores iniciales propuestos: máximo 5 eventos por invocación, concurrencia máxima 2, presupuesto de ejecución 45 s, timeout de Resend 10 s y lease de 90 s por evento. Las consultas privilegiadas y actualizaciones tienen timeouts acotados. No reclamar más trabajo si el tiempo restante no permite resolver destinatario, enviar y persistir. Las invocaciones pueden solaparse: los leases y la selección atómica impiden reclamar la misma fila simultáneamente.

El minuto es una expectativa con configuración válida, capacidad disponible y sin backlog; no garantiza entrega de extremo a extremo en 60 s. El runtime o Resend pueden añadir demora. No se duerme dentro de la función para esperar reintentos.

## 6. Persistencia, ownership y contratos internos

Se conserva `notification_events` como outbox de S2-08. Una migración nueva añade el estado técnico necesario; no se reescriben migraciones integradas ni funciones terminales para introducir envío de correo.

En el evento se necesitan `operation_id` y `lease_expires_at` para fencing y recuperación. Se conserva `pending` mientras existe un intento en curso: no se añade un estado público `processing`. Las restricciones deben impedir leases incompletos y estados terminales con trabajo enviable pendiente.

Una relación privada, una fila por evento, conserva el sobre de envío inmutable, la clave idempotente, `first_submission_at`, el identificador de Resend cuando se conoce y el estado de reporte de fallo a Sentry. El sobre contiene solo los campos necesarios para reproducir exactamente la petición: from, to, subject, html y text, incluidos origen, plantilla y fecha terminal fijados. Es información operativa privada, no un artefacto de diagnóstico; contiene la dirección necesaria para entregar y no se exporta a logs, Sentry o evidencia.

La inicialización del sobre se persiste bajo el token vigente antes de llamar a Resend y se reutiliza aunque cambien la plantilla o la configuración. El código nunca regenera contenido diferente con la misma clave. Los nombres y tipos SQL finales, índices y funciones se concretan en el plan, manteniendo estas responsabilidades:

| Operación privilegiada | Garantía |
|---|---|
| Reclamar siguiente evento | `FOR UPDATE SKIP LOCKED`, selección vencida, incremento atómico del intento y lease exclusivo. Retorna IDs y contexto mínimo del evento. |
| Preparar sobre | Confirma análisis/evento/iniciador/tenant y estado terminal concordantes; inserta una sola vez con token vigente. |
| Confirmar aceptación | Solo token y lease vigentes; pasa a `sent`, fija `sent_at`, guarda ID de Resend y limpia lease/espera/error. Repetir confirmación idéntica no crea efectos. |
| Registrar fallo de intento | Solo token vigente; fija código seguro y próximo intento o termina `failed`; limpia lease. |
| Recuperar expirados | Invalida token anterior y programa reintento o termina `failed` según presupuesto; no envía correo dentro de SQL. |
| Reportar fallo terminal | Reclama avisos `failed` no reportados y marca reporte aceptado por el transporte de Sentry; no altera intentos de correo. |

Funciones `SECURITY DEFINER` con `search_path` vacío y GRANT explícitos; invocación de delivery solo por `service_role`. Configurar cron requiere credenciales operativas privilegiadas, nunca sesión de usuario. Tablas privadas y outbox siguen inaccesibles a `anon/authenticated`, incluso mediante relaciones o RPC nuevas. Las funciones no aceptan un workspace del caller como prueba de autorización.

Regenerar `src/types/database.ts` desde Supabase local tras la migración. `TerminalNotification` sigue siendo el contrato mínimo productor/consumidor; nuevos tipos de lease, sobre y resultados son internos del módulo y no amplían DTO públicos. No exponer Auth admin, Resend o worker mediante barrels cliente.

## 7. Destinatario autorizado y cambios de cuenta

Antes de cada envío se comprueba que `recipient_id = analyses.initiator_id`, que análisis/evento/Profile comparten workspace y que el tipo corresponde a `completed` o `failed`. El Profile debe conservar rol Admin o QA Lead. Usar identidad de Auth persistida para comprobar que el usuario existe y obtener su dirección actual; nunca metadata del navegador ni una dirección de override.

La dirección de Auth debe ser válida y concordar con `profiles.email`, comparadas tras trim y sin distinguir mayúsculas. El sobre fija exactamente la dirección canónica de Auth. Un usuario eliminado o explícitamente bloqueado, un Profile ausente, un cambio de tenant/rol, una dirección inválida o una discrepancia de emails termina como `RECIPIENT_UNAVAILABLE`, sin llamar a Resend. No se introduce una nueva obligación global de confirmar email distinta de la política de Auth existente.

Si el sobre ya existe y cambia la dirección autorizada, no se envía al email anterior ni se cambia el destinatario usando la misma clave: termina `RECIPIENT_UNAVAILABLE`. Una indisponibilidad temporal de Auth/DB se trata como error interno reintentable, no como prueba de que el usuario desapareció. La comprobación ocurre inmediatamente antes de llamar al proveedor; no se promete revocación atómica de un correo ya en tránsito si el permiso cambia después.

## 8. Intentos, recuperación e idempotencia

`attempt_count` cuenta intentos de despacho reclamados: inicial más hasta dos reintentos, máximo 3. Cada intento permite como máximo una petición de envío a Resend; el adaptador no hace retries ocultos. Un crash después de reclamar puede consumir un intento aunque no se alcance a efectuar HTTP. Esto evita bucles ilimitados tras fallos inciertos.

Backoff propuesto: primer retry no antes de 1 minuto tras el fallo; segundo no antes de 5 minutos tras el segundo fallo. El scheduler añade su propia cadencia. Para HTTP 429 se puede ampliar la espera mediante un `Retry-After` válido y acotado; nunca reducirla ni dormir en el worker.

Red, timeout, 429 y 5xx son reintentables. Otros non-2xx y una respuesta 2xx sin ID válido se registran como `DELIVERY_FAILED` y pueden consumir el mismo presupuesto, sin interpretar el mensaje libre del proveedor. Destinatario permanentemente no autorizado termina sin más envíos. Fallos de resolución/persistencia son `INTERNAL_ERROR`. No ampliar los tres códigos existentes para almacenar bodies externos.

Un lease vencido se invalida y su intento se considera incierto. Con presupuesto restante se programa el backoff correspondiente; con tres intentos consumidos se marca `failed`. No hay un cuarto envío para resolver un crash tras el tercer intento. Un worker antiguo no puede confirmar, preparar, fallar o reprogramar tras perder su lease.

Clave propuesta: `kdm-terminal/<event_id>/v1`, estable por evento. Resend conserva claves idempotentes durante 24 horas. Se fija una ventana local conservadora de **23 horas desde `first_submission_at`**, persistido antes del primer HTTP posible. No se vuelve a llamar al proveedor fuera de esa ventana; el aviso termina `failed/DELIVERY_FAILED`. Un evento viejo que nunca se intentó puede tener su primer envío ahora: la ventana no se mide desde su creación.

La comprobación de ventana se hace inmediatamente antes de cada HTTP e incluye el timeout de 10 s. Si la respuesta aceptada llega y el lease sigue vigente, se confirma aunque haya cambiado el minuto del scheduler. Si se pierde la respuesta o la confirmación DB, el siguiente intento usa la misma petición y clave. Un conflicto de idempotencia se considera fallo controlado y revela un defecto; no se genera otra clave para saltarlo.

La unicidad SQL evita dos entregas lógicas. Lease, fencing, contenido estable y clave del proveedor reducen duplicados físicos. No se promete exactly-once: puede perderse una respuesta, agotarse el presupuesto tras una aceptación externa o vencer la ventana del proveedor. `failed` significa que KDM no pudo confirmar el envío; en un resultado incierto el destinatario podría haber recibido el correo. `sent` significa API aceptado con ID válido, no recepción en bandeja ni lectura.

S2-11 no registra efectos contables, no cambia estado del análisis ni findings y no invoca `run_analysis`, `fail_analysis` o liquidación de créditos.

## 9. Adaptador Resend y privacidad

HTTP nativo con `fetch` inyectable; no se incorpora un SDK de correo. Usar el endpoint fijo `https://api.resend.com/emails`, Bearer privado e `Idempotency-Key`; JSON con from, to como array de un elemento, subject, html y text. Desactivar seguimiento de apertura y clic en la configuración efectiva de esta integración.

`redirect: "error"`, timeout también durante lectura del body y límite de respuesta 64 KiB. El éxito exige status 2xx y un identificador de proveedor válido; se conserva ese identificador de forma privada para conciliación manual. El cuerpo externo no se propaga a excepciones públicas, logs o telemetría. No se permite cambiar el host mediante una entrada del request. En pruebas el transporte se inyecta.

La clave debe permitir únicamente envío y estar restringida al dominio verificado cuando se configure. Una credencial propia para el despachador facilita su rotación sin afectar a Auth. El valor lo configura el usuario fuera de Git; no se solicita en la conversación ni se obtiene de archivos de credenciales para redactar este diseño.

## 10. Observabilidad y Sentry

La implementación debe conectar el runtime Edge con Sentry: `console.log` y un sink simulado no satisfacen el reporte del ticket. Usar un adaptador oficial compatible con Deno y las garantías de filtrado del proyecto; fijar y verificar su versión durante el plan/implementación. No importar `@sentry/nextjs` o código Node dentro del bundle Edge.

Extender de forma aditiva el catálogo seguro compartido con módulo `notifications`, operaciones `dispatch/deliver/recover/alert` y los códigos `DELIVERY_FAILED/RECIPIENT_UNAVAILABLE`, reutilizando `INTERNAL_ERROR`. `correlation_id` puede ser el UUID estable del evento y `attempt_id` el token del intento. Se mantienen environment, release SHA y runtime `edge`. No hace falta enviar IDs de tenant, correos ni información del análisis para correlacionar el fallo con la outbox privada.

Prohibidos request/response crudos, URL de correo o de Auth, headers, direcciones, asunto/cuerpo, nombres, secretos, documentos, snapshots y excepciones libres. Desactivar captura automática de request, breadcrumbs, sesiones, trazas, logs y adjuntos; verificar el envelope final completo con marcadores sintéticos, siguiendo S1-08. La configuración actual necesita una extensión explícita: el filtro existente no reconoce todavía `notifications` ni sus códigos.

Al entrar en `failed`, persistir la necesidad de reporte y emitir el error saneado. El scheduler recupera reportes pendientes después de un crash o fallo de transporte. Esa recuperación no llama a Resend ni incrementa `attempt_count`; se aplica el mismo fencing a su claim. Marcar el reporte solo tras aceptación del transporte, usando un event ID estable derivado del UUID para reducir duplicaciones. No se promete entrega exactly-once de telemetría ni se reabre un correo fallido para corregir Sentry.

Una configuración incompleta devuelve 503 antes de reclamar correo. El runbook debe distinguir job deshabilitado, invocación rechazada, backlog, fallo de entrega y fallo de reporte a Sentry. Solo se muestran IDs y agregados saneados.

## 11. Configuración, activación y backlog

Configuración propuesta de Edge: `NOTIFICATIONS_ENABLED` (por defecto deshabilitado), `NOTIFICATIONS_INTERNAL_TOKEN`, `RESEND_API_KEY`, `NOTIFICATIONS_FROM`, `APP_ORIGIN`, URL/clave privilegiada de Supabase y DSN/environment/release de Sentry. Los valores de entorno públicos y privados mantienen su separación; ninguna clave queda en `NEXT_PUBLIC_*`.

Vault guarda `notifications_function_url` y `notifications_internal_token`. La migración instala funciones y esquema, pero no almacena secretos, crea credenciales reales ni habilita envíos. La activación posterior valida configuración y crea un solo job idempotentemente; desactivar impide nuevos claims y elimina el job. Una petición ya entregada a Resend no se puede retirar mediante el flag.

Al habilitar se procesan también los eventos pendientes anteriores que sigan autorizados. No se borran, marcan como enviados ni descartan silenciosamente: el correo lleva la fecha terminal original. El runbook exige inventariar el backlog por IDs/tipos/fechas antes de activar para conocer cuántos avisos históricos pueden salir. El alcance actual es escribir este diseño; no se activa ningún entorno en esta sesión.

Las pruebas reales usan cuentas iniciadoras cuyo email persistido sea un buzón controlado. No se reenvían fixtures a una dirección arbitraria ni se modifica el usuario destino desde el navegador. Los correos locales de recuperación capturados en Mailpit no prueban recepción de estos avisos vía Resend.

El link de una prueba local puede usar loopback para el operador de esa máquina; un correo alojado debe usar el origen HTTPS de su entorno. No se presenta el envío desde un Edge local como prueba de un despliegue remoto.

## 12. Evidencia y aceptación

| Nivel | Comprobación necesaria |
|---|---|
| Unitarias | Dos templates y contenido mínimo; fecha e ID estables; validación de destinatario; congelación del sobre; timeout/límite/redirect; clasificación de errores; retries y ventana de 23 h; redacción de logs y envelope de Sentry. |
| SQL/RLS | Unicidad; FKs de tenant; claim concurrente; máximo 3 intentos; backoff; recuperación; token obsoleto sin efecto; sobre inmutable; terminales coherentes; ausencia de permisos anon/authenticated sobre outbox, privado y RPC. Regeneración de tipos. |
| Integración determinista | Eventos terminales creados por S2-08; duplicado de evento y de invocación; fallo y éxito; crash antes de HTTP y después de aceptación; respuesta/confirmación perdida; lease reclamado; crash en tercer intento; deadline del proveedor vencido; cambio de email/rol/tenant; Auth inaccesible; reporte Sentry recuperable. HTTP fake claramente identificado. |
| Invariantes del análisis | Comparar estado, findings y entradas/importes de ledger antes y después del envío, retries y agotamiento; no hay consumo/liberación adicional ni reversión de completed. |
| Navegador | Link con sesión y sin sesión; login retorna al mismo análisis; completed/failed; tenant ajeno, Member e ID inexistente; query manipulada; login normal y recovery sin regresiones. Verificar texto y navegación reales con Playwright. |
| Proveedor real | Recibir un correo completed y otro failed en buzón controlado, comprobar asunto, contenido mínimo, fecha, autenticación y destino. Guardar metadata saneada y evidencia redactada; HTTP 200/202 o estado sent solos no bastan. |
| Sentry real | Provocar con proveedor fake un agotamiento controlado, usando el adaptador/runtime real de Sentry y un evento sintético; comprobar recepción filtrada por correlación, environment y release. Separar esta prueba de un fallo real de Resend. |
| Checks del candidato | Lint, typecheck, unitarias relevantes, SQL, integración, build y Playwright apropiados; `git diff --check`. Informar SHA, comandos, resultados y límites; no afirmar cierre por documentación o pruebas históricas. |

Casos de recepción real pueden generarse con finalización real y análisis sintéticos controlados; un aviso failed no exige romper las credenciales de IA del entorno. Usar controles fake únicamente en el entorno local que ya los permite y distinguirlo de un análisis con proveedores IA reales. La aceptación integral con Cerebras, Groq y todo el corpus sigue siendo S2-12.

S2-11 se cierra cuando su despachador integrado satisface seguridad/concurrencia/privacidad y se documentan ambas recepciones y el reporte saneado de fallo. Registrar por separado pruebas locales, fakes, correo real, Sentry real y remoto. Si falta alguna dependencia o evidencia requerida, se declara pendiente; no se sustituye por un estado Done.

## 13. Trabajo que concretará el plan

El plan derivará migraciones, firmas SQL y tipos, implementación por capacidad, pruebas de concurrencia/crash, integración Edge, continuidad de login, configuración y runbook. Elegirá la versión del adaptador oficial de Sentry compatible con el runtime y ajustará límites de lotes con evidencia, sin cambiar alcance, privacidad o presupuesto de tres intentos. No se crean ahora dependencias, carpetas de producto, código, migraciones o tests.

Se preservan los cambios locales existentes en finalización, página de findings, pruebas y documentación. No se incluyen credenciales ni snippets ajenos. Este documento no solicita commit, push, merge, envío de correos, instalación o modificación remota.

## 14. Documentación externa consultada

Consultada mediante Context7 el 2026-11-01; la sintaxis concreta deberá contrastarse de nuevo al implementar si cambian versiones. Orbit identificó `POST https://api.resend.com/emails` como envío individual con idempotencia; su breve no verifica dominios, por lo que ese requisito se apoya aquí en la captura y en la futura configuración efectiva.

- [Resend: Send email](https://resend.com/docs/api-reference/emails/send-email): HTTP, payload e idempotencia con retención de 24 h.
- [Resend: clave restringida a dominio](https://resend.com/docs/knowledge-base/setting-up-resend-for-multi-tenants): permiso de envío y dominio.
- [Resend: dominio del remitente](https://resend.com/docs/knowledge-base/403-error-domain-mismatch): coincidencia del from con el dominio verificado.
- [Supabase: scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions): cron, pg_net y Vault.
- [Supabase: auth headers](https://supabase.com/docs/guides/functions/auth-headers): límites de `verify_jwt`.
- [Supabase: nuevas API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys): distinguir API key de un token interno de aplicación.
- Guía local de Next.js 16.3.5: `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/redirect.md`. La continuidad propuesta evita redirecciones externas y preserva el mecanismo de sesión existente.
