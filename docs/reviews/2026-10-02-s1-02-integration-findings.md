# S1-02 — Hallazgos de integración, origen y motivo de los ajustes

Fecha: 2026-10-02. Snapshot: `661eaf416d67ea4c0b97fe08f13c08abe78011d1`.

Relacionado: [spec S1-02](../superpowers/specs/2026-10-02-s1-02-tenant-isolation-integration-design.md).

La spec escrita fue aprobada el 2026-10-02. El [plan de implementación](../superpowers/plans/2026-10-02-s1-02-tenant-isolation-integration.md) asigna cada hallazgo H01–H17 a tareas y pruebas. La sección 7 registra la ejecución local posterior; la evidencia inicial de las secciones 1–6 conserva el estado del snapshot fechado.

## 1. Cómo leer este informe

Este informe explica dónde está cada hallazgo, qué commit introdujo el código relevante, quién figura como autor en Git y por qué se acordó ajustarlo en S1-02. No atribuye intenciones ni responsabilidad personal. Un autor de merge integra cambios, pero no necesariamente escribió las líneas. Las incompatibilidades entre módulos tienen varios antecedentes.

**Estado de las correcciones:** la implementación local se completó y verificó el 2026-10-03. El código quedó en los commits locales `2cc4aa2` (esquema/RLS), `6a04794` (identidad/Repository), `d74419a` (ingesta) y `f6dc98e` (pruebas y CI). La app no se ha desplegado. Las 13 migraciones pendientes sí se aplicaron en Supabase cloud y `upload_mode` permanece pausado; quedan la reconciliación de objetos legacy y las compuertas de Preview, Auth, Sentry y CI.

La atribución se obtuvo con `git log -- <archivo>`, `git show` y `git blame -L`. Las ubicaciones y líneas corresponden al snapshot indicado. Los enlaces a GitHub fijan el commit para que la evidencia no cambie cuando avance la rama. Los nombres se reproducen como figuran en Git, sin incluir correos. Las ausencias de funcionalidad y la configuración de servicios no tienen un autor de línea equivalente: se identifica la entrega relacionada y se explicita ese límite.

Tipos de evidencia:

- **Defecto estático:** contradicción demostrable leyendo código y contrato; no implica reproducción E2E.
- **Incompatibilidad de integración:** componentes válidos por separado no cumplen juntos el contrato esperado.
- **Brecha de prueba/configuración:** falta evidencia o un control; no prueba una fuga real.
- **Límite de alcance:** funcionalidad deliberadamente ausente; no se presenta como bug del autor.
- **Estado operativo:** observado mediante CLI/MCP, no atribuible al autor de una migración.

## 2. Commits y autores comprobados

| Referencia | Autor Git | Cambio relevante |
|---|---|---|
| [acbff8d][C0] | JMCoC | Día Cero, esquema, políticas, contratos y arquitectura |
| [0a467ae][C1] | JMCoC | S1-01, identidad, filtro seguro de Sentry, CI y configuración de pruebas |
| [3d2a2b6][C2] | Juan Pablo | Repository, identidad paralela, UI, pruebas y configuración adicional |
| [04751b3][C3] | Juan Pablo | Merge de develop en la rama Repository; adapta clientes y combina Playwright |
| [e091949][C4] | Diego Alejandro Tolosa Sanchez | Contratos, schemas y validadores iniciales de ingesta |
| [89e4f80][C5] | Diego Alejandro Tolosa Sanchez | Pruebas de ingesta en `tests/unit` y alias de Vitest |
| [ed7bde1][C6] | Diego Alejandro Tolosa Sanchez | Reserva/finalización, mocks y punto de entrada sin worker |
| [eeebd1e][C7] | Diego Alejandro Tolosa Sanchez | Migración `reserve_document` y `size_bytes` |
| [b2a5cb1][C8] | Diego Alejandro Tolosa Sanchez | Reordena la migración y corrige preparación de pruebas pgTAP |
| [bf0ff00][C9] | Diego Alejandro Tolosa Sanchez | Tipos regenerados de la nueva migración |
| [6dde7f0][C10] | Diego Alejandro Tolosa Sanchez | Documentación que difiere compensación y validación real |
| [9795f48][C11] | Juan Pablo | Habilita navegación a Repository |

Los merges [90b04aa][M1] (ingesta), [1fe2ef2][M2] (Repository) y [661eaf4][M3] (navegación) figuran con autor **Juan Manuel Ramirez Agudelo** y committer GitHub. Se registran como integración, no como autoría de todos los hallazgos incorporados.

## 3. Hallazgos

### H01 — Tamaño de Storage leído desde un campo incorrecto

**Tipo/prioridad:** defecto estático; alta para confirmar cargas nuevas.

**Dónde:** [actions.ts, líneas 318–329][S1]; [mock de finalizeUpload, líneas 345–346][S2].

**Origen:** [ed7bde1][C6], Diego Alejandro Tolosa Sanchez. El mismo commit introduce la lectura y el mock.

**Qué ocurre:** la acción fuerza los resultados de `.list()` a objetos `{ name, size }` y compara `stored.size`. El SDK instalado `@supabase/storage-js@2.117.2` define el tamaño en `FileObject.metadata.size`. Para una reserva con tamaño registrado, el campo usado puede ser `undefined` y producir rechazo de un archivo válido. El mock usa el mismo campo incorrecto, por lo que la prueba no detecta la incompatibilidad.

**Motivo del ajuste aprobado:** usar el contrato real del SDK y comprobar los bytes/tamaño/hash al finalizar. Conservar una prueba de integración con respuesta real de Storage; no sustituirla por un cast que silencie TypeScript. Evidencia actual: código + tipos del SDK + documentación; no upload real reproducido.

**Cierre exigido:** A05, A06 y A10 de la spec; original válido confirmado y original discrepante rechazado.

### H02 — Identidad duplicada y semántica de errores incompatible

**Tipo/prioridad:** incompatibilidad de integración; alta para S1-02.

**Dónde:** [identity.service.ts][S3], [acciones Repository][S4], [session.ts de S1-01][S5], `src/modules/identity/errors.ts` y `repository.service.ts:89,192`.

**Origen:** identidad S1-01 en [0a467ae][C1], JMCoC; implementación paralela y comparación de mensajes en [3d2a2b6][C2], Juan Pablo; import/cliente de sesión ajustados en [04751b3][C3], Juan Pablo.

**Qué ocurre:** Repository verifica usuario/Profile por su cuenta y arroja `Error("UNAUTHENTICATED")` o `Error("PROFILE_NOT_FOUND")`; Auth/ingesta utilizan `IdentityError` con código tipado y estados onboarding/anónimo. Repository importa un interno de identity. Sustituir solo el import clasificaría incorrectamente errores controlados porque el consumidor compara el texto del mensaje.

**Motivo del ajuste aprobado:** una fuente de identidad y una interpretación común de errores, adaptando consumidores y pruebas a la vez. La duplicación no demuestra por sí misma un acceso cross-tenant; aumenta divergencia y manejo incorrecto de fallos.

**Cierre exigido:** A01–A04 y A18; sesión ausente, Profile ausente y proveedor caído producen resultados distintos y controlados.

### H03 — Pruebas de Repository excluidas del comando de CI

**Tipo/prioridad:** brecha de pruebas por integración; alta.

**Dónde:** [vitest.config.mts:13][S6], [vitest.config.mjs:7][S7], [.github/workflows/s1-01.yml:39][S8].

**Origen:** suite `tests/unit` y workflow en [0a467ae][C1], JMCoC; configuración `src/**/*.test.ts` en [3d2a2b6][C2], Juan Pablo. [89e4f80][C5], Diego Alejandro Tolosa Sanchez, añade alias y acomoda ingesta, pero no introduce la exclusión original de `src/**`.

**Qué ocurre:** CI ejecuta `pnpm test:unit`, que solo incluye `tests/unit`. Las pruebas de Repository viven en `src/modules/repository/application/repository.service.test.ts` y requieren otra configuración. Un resultado verde del primer comando no comprende ambas suites.

**Motivo del ajuste aprobado:** una entrada inequívoca que ejecute todas las pruebas relevantes. En la revisión pasaron 142 pruebas por la configuración `.mts` y 9 por `.mjs`, ejecutadas separadamente.

**Cierre exigido:** A17; lista de suites en CI incluye Repository, Auth e ingesta.

### H04 — Navegadores de Playwright y preparación de CI desalineados

**Tipo/prioridad:** brecha de configuración; media/alta para el gate.

**Dónde:** [playwright.config.ts:36–41][S9] y workflow S1-01, líneas 56–57.

**Origen:** Edge añadido en [3d2a2b6][C2], Juan Pablo; configuración combinada en [04751b3][C3], Juan Pablo. La instalación de solo Chromium viene de [0a467ae][C1], JMCoC.

**Qué ocurre:** se selecciona `channel: "msedge"`, pero el workflow instala Chromium. El resultado depende de que el runner tenga Edge por otro medio; no hay garantía reproducible en ese YAML. No se ejecutó CI remoto para afirmar que ya falló por esta causa.

**Motivo del ajuste aprobado:** Chromium obligatorio en el gate y Edge opcional con instalación explícita. Evita que un navegador no preparado o un servidor reutilizado de otro entorno invalide la aceptación.

**Cierre exigido:** A17 y A18; ejecución reproducible en runner limpio.

### H05 — E2E pueden pasar sin demostrar apertura ni estados

**Tipo/prioridad:** brecha de prueba; alta para la afirmación de seguridad.

**Dónde:** [repository.spec.ts:24–47][S10].

**Origen:** [3d2a2b6][C2], Juan Pablo.

**Qué ocurre:** abrir archivo depende de `if (count > 0)`; comprobar badge depende de `if (isVisible())`. Las pruebas pueden terminar sin ejercitar esas conductas. Además, buscar `token=` en la URL no demuestra que Storage haya entregado el original. Ese archivo E2E solo usa Admin; no cubre la matriz de tenant/rol, aunque existan unitarias de Member.

**Motivo del ajuste aprobado:** fixtures exigidos, aserciones incondicionales y prueba de acceso real, junto a rechazos por rol/tenant. No se afirma que la app permita a Member acceder; falta demostrar el rechazo en el recorrido integrado.

**Cierre exigido:** A01, A02, A05, A09 y A13.

### H06 — Eventos nuevos descartados por el filtro seguro de Sentry

**Tipo/prioridad:** incompatibilidad de integración; alta para observabilidad.

**Dónde:** [auth-events.ts:66–79][S11], `sentry.server.config.ts`, `src/modules/ingestion/actions.ts:28–36`, `repository.service.ts:99,202`.

**Origen:** filtro de Auth en [0a467ae][C1], JMCoC; emisiones de ingesta en [ed7bde1][C6], Diego Alejandro Tolosa Sanchez; emisiones de Repository en [3d2a2b6][C2], Juan Pablo.

**Qué ocurre:** el filtro global requiere marcador, operación y código permitidos de Auth. Los nuevos `captureException` no cumplen ese contrato y devuelven `null` al pasar por el filtro. Probar únicamente que se llamó a `captureException` no comprueba entrega. No se inspeccionó un evento real en la cuenta Sentry durante esta revisión.

**Motivo del ajuste aprobado:** ampliar el contrato de eventos reconstruidos y sanitizados a los nuevos módulos, manteniendo protección de datos. Desactivar el filtro o dejar pasar excepciones crudas sería una regresión de privacidad.

**Cierre exigido:** A16; prueba del filtro real y recepción de un evento sintético seguro.

### H07 — Comentario de ingesta contradice el RBAC existente en RLS

**Tipo/prioridad:** error documental dentro del código; media.

**Dónde:** [actions.ts:43–48][S12] frente a las políticas de documentos/versiones/chunks en `00001_initial_schema.sql:176–200`.

**Origen:** comentario de [ed7bde1][C6], Diego Alejandro Tolosa Sanchez. Políticas de [acbff8d][C0], JMCoC.

**Qué ocurre:** el comentario dice que RLS solo limita tenant y que Member puede leer una versión de su workspace. Las políticas exigen Admin/QA Lead; esa descripción es incorrecta. La guarda de aplicación sigue siendo apropiada como defensa adicional.

**Motivo del ajuste aprobado:** explicar correctamente las dos fronteras y evitar que una futura modificación elimine o debilite restricciones basándose en ese comentario. No es evidencia de que Member haya podido leer versiones.

**Cierre exigido:** explicación corregida y A01/A13 conservados.

### H08 — La migración integrada no está aplicada en los entornos comprobados

**Tipo/prioridad:** estado operativo; alta para la nueva ingesta.

**Dónde:** [20260930182112_reserve_document.sql][S13]; historia de migraciones local/nube y catálogos consultados por CLI.

**Origen del archivo:** [eeebd1e][C7], Diego Alejandro Tolosa Sanchez; orden corregido en [b2a5cb1][C8], mismo autor; tipos regenerados en [bf0ff00][C9]. Integración por [90b04aa][M1], Juan Manuel Ramirez Agudelo.

**Qué ocurre:** a 2026-10-02 ambas bases solo registran `00001`; no existen RPC ni columna nuevas. Que el código compile con tipos regenerados o que Vercel esté `READY` no hace aparecer esos objetos.

**Motivo del ajuste aprobado:** ejecutar una secuencia reproducible de migración local → validación → nube, incluyendo nuevas migraciones S1-02 y reconciliación. El estado pendiente no se atribuye como error de Diego: Git no demuestra quién tenía que aplicar cambios externos. La migración actual es aditiva y no introduce un nuevo proveedor.

**Cierre exigido:** A15 y aceptación por entorno; sin reset remoto ni seed local.

### H09 — Compensación declarada cerrada, pero diferida y contradictoria

**Tipo/prioridad:** contradicción de arquitectura y límite funcional; alta.

**Dónde:** [arquitectura-base.md:313][S14], frente a su invariante de la línea 177 y `day-zero-protocol.md:43`.

**Origen:** declaración «Cerrada en S1-03» en [6dde7f0][C10], Diego Alejandro Tolosa Sanchez. Obligación previa de compensación en [acbff8d][C0], JMCoC.

**Qué ocurre:** se declara resuelta la compensación porque se dejan reservas huérfanas y su resolución se difiere a S1-07/Sprint 5; el protocolo sigue exigiendo compensar. No otorgar DELETE al navegador protege datos, pero no resuelve el estado de una transferencia fallida. Los permisos SQL de Día Cero no impiden diseñar una recuperación autorizada en servidor.

**Motivo del ajuste aprobado:** estados persistidos, recuperación sobre la misma reserva y limpieza limitada a objetos rechazados/retirados. El usuario aprobó recuperaciones por cualquier Admin/QA del tenant, con hash fijo y concurrencia controlada.

**Cierre exigido:** A08–A12; documentación consistente y cero duplicación lógica.

### H10 — UI de carga ausente; procesamiento deliberadamente sin implementar

**Tipo/prioridad:** límite de alcance, no bug del punto de entrada.

**Dónde:** `src/modules/ingestion/actions.ts`, [processing.ts:1–14][S15], contratos y página Repository. Búsqueda en `src` no encontró consumidor UI de `reserveUpload`/`finalizeUpload` en el snapshot.

**Entrega relacionada:** [ed7bde1][C6], Diego Alejandro Tolosa Sanchez, entrega acciones y función que explícitamente devuelve `uploaded`; [3d2a2b6][C2], Juan Pablo, entrega listado/apertura. Una ausencia en el conjunto no se atribuye a una línea ni prueba incumplimiento personal.

**Qué ocurre:** no hay recorrido de carga desde la UI ni pipeline real. Llamar al punto de entrada no inicia un worker. La interfaz de Repository puede mostrar fixtures `ready`, lo cual no demuestra que se hayan procesado nuevos archivos.

**Motivo del ajuste aprobado:** añadir UI mínima y cerrar transferencia/confirmación para S1-02, conservando parsing/embeddings/worker en S1-04. No se configurará un servicio de procesamiento inexistente ni se presentará `uploaded` como `ready`.

**Cierre exigido:** A05/A06/A09 y mensajes honestos de procesamiento pendiente.

### H11 — Consultas de Repository sin validación completa en frontera

**Tipo/prioridad:** defecto de contrato de entrada; media.

**Dónde:** [repository.actions.ts:12–18][S4], [repository.repository.ts:7–18][S16].

**Origen:** [3d2a2b6][C2], Juan Pablo.

**Qué ocurre:** `RepositoryQuery` es un tipo TypeScript, no valida el input de una Server Action. `Math.max/min` no sustituyen Zod para UUIDs, enums, strings, enteros finitos y campos desconocidos. La validación UUID de `getOriginalUrl` no cubre el listado.

**Motivo del ajuste aprobado:** validar entradas antes de consultar, conservar defaults/NULL y no propagar valores arbitrarios a consultas o eventos. No se ha demostrado SQL injection ni fuga cross-tenant; RLS sigue siendo una frontera independiente.

**Cierre exigido:** A02/A14, incluyendo inputs manipulados y conteos aislados.

### H12 — Fallo técnico tratado como recurso inexistente

**Tipo/prioridad:** defecto estático de clasificación de errores; media.

**Dónde:** [repository.repository.ts:87–99][S17]; consumo en `repository.service.ts`.

**Origen:** [3d2a2b6][C2], Juan Pablo.

**Qué ocurre:** `if (error || !data) return null` mezcla un error de consulta con ausencia. El consumidor devuelve `NOT_FOUND` para ambos. La firma también devuelve NULL ante fallo, perdiendo la causa técnica controlada para observabilidad.

**Motivo del ajuste aprobado:** desconocido/ajeno sigue siendo `NOT_FOUND`; indisponibilidad es `INTERNAL_ERROR`. Esta distinción resulta esencial en recuperación: un timeout no autoriza asumir que un objeto no existe y volver a cargar o eliminar.

**Cierre exigido:** A04/A10/A16, sin exponer errores crudos.

### H13 — UI y mensajes del producto en español

**Tipo/prioridad:** discrepancia de convención de producto; media.

**Dónde:** [page.tsx de Repository][S18], badges, botón de apertura y mensajes de `repository.service.ts`.

**Origen:** [3d2a2b6][C2], Juan Pablo. [9795f48][C11] habilita acceso desde el shell, pero no introduce los textos originales del Repository.

**Qué ocurre:** títulos y estados dicen «Repositorio», «Listo», «Abrir archivo», etc.; el producto está definido en inglés. No es una vulnerabilidad.

**Motivo del ajuste aprobado:** al integrar carga/recuperación, mantener una sola lengua de producto y actualizar E2E a labels accesibles consistentes. La documentación del equipo permanece en español.

**Cierre exigido:** A05 y revisión de los estados de carga/errores.

### H14 — Previews y controles remotos necesitan verificación independiente

**Tipo/prioridad:** estado operativo y brecha de evidencia; alta para aceptar en nube.

**Dónde:** proyecto Vercel `knowledge-decay-monitor`, preview `develop` en `661eaf4`; variables consultadas por MCP sin descifrar valores; workflow GitHub.

**Autor/commit:** no atribuible por Git para configuración remota. El workflow procede de [0a467ae][C1], JMCoC; el código del preview procede del merge [661eaf4][M3], Juan Manuel Ramirez Agudelo. Eso no identifica al autor de variables o protecciones.

**Qué se verificó:** nombres de variables de Auth para producción y preview específicamente `develop`; bucket/RLS básicos en ambas bases; preview `READY`. No se verificaron igualdad de valores entre entornos, protección de ramas, gates de promoción, recepción Sentry o configuración alojada de email.

**Motivo del ajuste aprobado:** matriz explícita de servicios y evidencia por entorno. La nueva recuperación privilegiada requiere además secreto exclusivamente servidor en cada entorno habilitado; la presencia en producción no cubre preview. No se añaden proveedores externos nuevos.

**Cierre exigido:** A06/A16/A17/A18 y runbook de migración/despliegue.

### H15 — Traces de navegador pueden conservar material que el proyecto prohíbe guardar

**Tipo/prioridad:** riesgo de privacidad en pruebas, sin exposición comprobada; alta.

**Dónde:** [playwright.config.ts:26][S19] y E2E de apertura de URL firmada.

**Origen:** `trace: "on-first-retry"` en [3d2a2b6][C2], Juan Pablo; configuración combinada en [04751b3][C3].

**Qué ocurre:** un retry puede activar captura del recorrido Auth/Storage, incompatible con asumir que los artefactos nunca contienen requests, URLs firmadas o contenido. No se inspeccionaron ni se afirma que existan traces filtrados.

**Motivo del ajuste aprobado:** deshabilitar capturas sensibles y redactar aserciones/evidencia que no impriman secretos ni URLs firmadas. Un directorio ignorado por Git no basta para garantizar privacidad de artefactos.

**Cierre exigido:** A13/A16/A17 y revisión de salida de pruebas.

### H16 — El filtro de estado puede cambiar qué versión se presenta como última

**Tipo/prioridad:** defecto estático en evolución multiversión; media.

**Dónde:** [repository.repository.ts:15–18,64–68][S16] y ordenado posterior de versiones en `repository.service.ts:51–58`.

**Origen:** [3d2a2b6][C2], Juan Pablo.

**Qué ocurre:** el filtro se aplica a la relación de versiones antes de elegir la mayor `version_number` recibida. Si una versión antigua cumple el filtro y la última no, se puede presentar la antigua como última. Los fixtures actuales de v1 no demuestran ese fallo en runtime.

**Motivo del ajuste aprobado:** definir y probar que el estado filtrado corresponde a la última versión mostrada, conservando documentos sin activa. Se corrige la consulta existente; no se implementa el workflow v2 ni un nuevo buscador.

**Cierre exigido:** A14 con fixture multiversión local de consulta, sin habilitar escrituras futuras en producto.

### H17 — Firma de ocho bytes incompatible con algunos archivos pequeños permitidos

**Tipo/prioridad:** contradicción estática entre validadores; media.

**Dónde:** `src/modules/ingestion/schemas.ts:31–37` y `validation.ts`, `decodeSignature()`.

**Origen:** [e091949][C4], Diego Alejandro Tolosa Sanchez.

**Qué ocurre:** se admite tamaño desde un byte, pero se exige una firma de exactamente ocho bytes. Un Markdown válido de menos de ocho bytes no puede aportar sus primeros ocho bytes reales. El hallazgo se concretó al revisar la spec escrita; no se ejecutó un caso UI porque no existe aún esa carga.

**Motivo del ajuste aprobado:** mantener los límites acordados y comprobar bytes reales/hash sin exigir un prefijo imposible. No se rellena artificialmente la firma para hacer pasar el validador ni se presenta un prefijo ZIP como prueba de DOCX válido.

**Cierre exigido:** A07 y control real de hash/tamaño.

## 4. Ampliaciones aprobadas que no son errores imputables a commits anteriores

El usuario amplió S1-02 para incluir UI mínima; hash fijado al reservar; estados independientes de procesamiento; reserva idempotente; recuperación por otro Admin/QA; eliminación controlada de un objeto rechazado; reconciliación de datos previos y migración nube. Las capacidades locales quedaron implementadas; la migración cloud sigue en el cutover pendiente. La ausencia de estas garantías en una entrega con otro alcance no se etiqueta retrospectivamente como un defecto personal.

La spec aprobada concreta el aislamiento con rutas temporales por intento y publicación sin sobrescritura en el original canónico. Es una solución técnica para satisfacer la concurrencia aprobada, no un cambio ya realizado por Dev 2. Conserva la razón de su decisión de cargar directamente a Storage por el límite de Vercel.

## 5. Evidencia de la revisión inicial (snapshot 2026-10-02)

La siguiente tabla conserva los controles ejecutados antes de la implementación. La verificación posterior está en la sección 7 y en el acta enlazada allí.

| Control | Resultado observado en la revisión |
|---|---|
| Vitest `.mts` | 17 archivos, 142 pruebas aprobadas |
| Vitest `.mjs` | 1 archivo, 9 pruebas aprobadas |
| `tsc --noEmit` | Aprobado; no equivale a volver a generar tipos Next.js ni a build |
| ESLint | 0 errores, 3 warnings: parámetros sin uso en punto de entrada y contrato typecheck |
| `git diff --check` | Aprobado en la revisión; se repite para estos documentos |
| CLI historial y catálogo local/nube | Migración pendiente y objetos ausentes comprobados |
| MCP Vercel | Preview actual READY y nombres/targets de variables comprobados |
| E2E, build, SQL nuevo, migración aplicada | No ejecutados en esta revisión |
| Configuración remota GitHub y evento real Sentry | No verificados |

Ningún resultado con mocks prueba ausencia de fugas en servicios reales. No se encontró ni se afirma un incidente de exfiltración. Los hallazgos justifican controles y correcciones que deben verificarse.

## 6. Registro del cierre

La sección 7 conserva por Hxx los commits/autores de origen, el cambio local, las pruebas y el resultado por entorno. Las correcciones de código están registradas en `2cc4aa2`, `6a04794`, `d74419a` y `f6dc98e`; el commit de documentación añade este registro. Las operaciones de Supabase cloud se atribuyen al runbook, no a un commit de código. Un hallazgo de código pasa a corregido local solo con evidencia proporcional; una migración escrita sin aplicar no cierra el estado cloud.

Los estados operativos H08/H14 requieren evidencia de servicio; no se inventa un commit que represente un cambio de dashboard. H10 se cerró en su porción UI/carga, manteniendo explícito el límite S1-04. Este registro explica **qué se ajustó y por qué**, sin confundir el diseño aprobado con trabajo ya ejecutado.

[C0]: https://github.com/JMCoC/knowledge-decay-monitor/commit/acbff8d899bd84d23b46de52416aafb3cb0c47d7
[C1]: https://github.com/JMCoC/knowledge-decay-monitor/commit/0a467ae6a6356634f13296eda4c6b559ea00061a
[C2]: https://github.com/JMCoC/knowledge-decay-monitor/commit/3d2a2b64438d155341619132ca2b858d66f8617b
[C3]: https://github.com/JMCoC/knowledge-decay-monitor/commit/04751b3bb901c583f454c870b499e338e3303e69
[C4]: https://github.com/JMCoC/knowledge-decay-monitor/commit/e091949003b608fe2dcf1153b9f852e3e43afa78
[C5]: https://github.com/JMCoC/knowledge-decay-monitor/commit/89e4f807efe4bd44b351176b9c1fbb8cafd1ce35
[C6]: https://github.com/JMCoC/knowledge-decay-monitor/commit/ed7bde12e81ad6815f02e74cf342eca605008fe7
[C7]: https://github.com/JMCoC/knowledge-decay-monitor/commit/eeebd1e8703c1c2e630b5192d187fdababc981f9
[C8]: https://github.com/JMCoC/knowledge-decay-monitor/commit/b2a5cb1ed1d8ea102553f314ae3d58e5108a1f65
[C9]: https://github.com/JMCoC/knowledge-decay-monitor/commit/bf0ff00b87e30fb67e1f6056ddba96155ba48049
[C10]: https://github.com/JMCoC/knowledge-decay-monitor/commit/6dde7f068493070a6bba46447fad40701aa110da
[C11]: https://github.com/JMCoC/knowledge-decay-monitor/commit/9795f48b692c4d51e35fa7d7f9f2994ffb04e0b2
[M1]: https://github.com/JMCoC/knowledge-decay-monitor/commit/90b04aafa0ed5dad4c7a8b23a3ba488c338f7150
[M2]: https://github.com/JMCoC/knowledge-decay-monitor/commit/1fe2ef2f863b90325f1a5df3d152271f50f2630e
[M3]: https://github.com/JMCoC/knowledge-decay-monitor/commit/661eaf416d67ea4c0b97fe08f13c08abe78011d1
[S1]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/src/modules/ingestion/actions.ts#L318-L329
[S2]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/tests/unit/ingestion-actions.test.ts#L345-L346
[S3]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/src/modules/identity/application/identity.service.ts#L4-L35
[S4]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/src/modules/repository/application/repository.actions.ts#L9-L26
[S5]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/src/modules/identity/session.ts
[S6]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/vitest.config.mts#L13
[S7]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/vitest.config.mjs#L7
[S8]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/.github/workflows/s1-01.yml#L39
[S9]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/playwright.config.ts#L36-L41
[S10]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/tests/e2e/repository.spec.ts#L24-L47
[S11]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/src/lib/observability/auth-events.ts#L66-L79
[S12]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/src/modules/ingestion/actions.ts#L43-L48
[S13]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/supabase/migrations/20260930182112_reserve_document.sql
[S14]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/docs/architecture/arquitectura-base.md#L313
[S15]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/src/modules/ingestion/processing.ts#L1-L14
[S16]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/src/modules/repository/infrastructure/repository.repository.ts#L7-L78
[S17]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/src/modules/repository/infrastructure/repository.repository.ts#L87-L99
[S18]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/src/app/%28workspace%29/repository/page.tsx
[S19]: https://github.com/JMCoC/knowledge-decay-monitor/blob/661eaf416d67ea4c0b97fe08f13c08abe78011d1/playwright.config.ts#L26

## 7. Estado de corrección en la implementación S1-02 — 2026-10-03

Las atribuciones originales de commits/autores de cada Hxx permanecen en sus secciones anteriores. Las correcciones locales de código están en `2cc4aa2`, `6a04794`, `d74419a` y `f6dc98e`; esto no implica que la app esté desplegada ni que una configuración remota quede corregida por código.

| Hallazgo | Corrección local y evidencia | Commit corrector | Estado de aceptación |
|---|---|---|
| H01 | Límite de bytes reales, SHA-256 y firma corta en `ingestion/verification.ts`; Storage real publica un original de 10 MiB y la UI lo abre con bytes verificados. Unit e integración completas. | `d74419a` | Cerrado local; repetir en Preview. |
| H02 | Guardia de documento desde identidad pública basada en `getUser()` + Profile; factory duplicada retirada; Repository consume la interfaz pública. Unitarias, integración PostgREST y E2E Member/B. | `6a04794` | Cerrado local; nube pendiente. |
| H03 | Configuración Vitest descubre `src/` y `tests/`; `npm run test:unit`: 35 archivos/217 pruebas. | `f6dc98e` | Cerrado local; ejecución del workflow y protección remotas pendientes. |
| H04 | Chromium requerido por defecto y Edge opt-in; suite E2E Chromium 16/16 pasa localmente. | `f6dc98e` | Cerrado local; CI remoto pendiente. |
| H05 | E2E prueba bytes reales, tenant B aislado, Member Owner sin Repository y recuperación por otro QA. Integración prueba versión ajena como `NOT_FOUND`, Member como `FORBIDDEN` y deniega intentos Storage cross-tenant/Member. Repository deja legacy en “Needs reconciliation” sin CTA no operativa. | `6a04794`, `d74419a` | Cerrado local. |
| H06 | `operation-events.ts` emite `captureOperationFailure`; filtro compartido reconstruye solo campos autorizados. Unitarias exactas + transporte local real de Sentry SDK (Auth + ingestion; evento automático descartado). | `d74419a` | Parcial: recepción y source maps de la cuenta Sentry pendientes. |
| H07 | El comentario incorrecto de actions fue retirado al mover mutaciones detrás de RPC service-only; tests SQL 006/007 cubren rol, tenant y estados. | `2cc4aa2`, `d74419a` | Cerrado local; aceptación cloud pendiente. |
| H08 | 14 migraciones pasan instalación limpia y 12 migraciones S1-02 pasan upgrade desde Dev 2; 9 archivos/198 aserciones en ambos recorridos. Tipos generados coinciden. `migration list` cloud confirma las 13 migraciones aplicadas hasta `20261003214934`; `upload_mode` sigue pausado. Persisten 4 objetos Storage sin versión asociada y la reconciliación no se ha ejecutado. | `2cc4aa2` (código); operación cloud en runbook | Migraciones aplicadas; reconciliación y aceptación de la app cloud pendientes. |
| H09 | Recuperación, CAS, reconciliación legacy y cleanup por intento exacto; carrera real de Storage con respuesta retenida, reaparición tardía sintética y limpiezas repetidas mantienen canónico y estado. | `2cc4aa2`, `d74419a` | Cerrado local; reconciliación/datos operativos cloud pendientes. |
| H10 | UI Upload/Repository envía bytes browser→Storage, expone estados honestos y `uploaded — processing pending`; diez archivos y archivo real de 10 MiB aceptados, sin binario hacia Next. Legacy `Needs reconciliation` no muestra una CTA de recuperación que no puede completar. No se agregó parser/worker. | `6a04794`, `d74419a` | Cerrado local; verificar en Preview. |
| H11 | Schema Zod estricto para consulta Repository; pruebas de entradas inválidas, filtros NULL y orden de latest. | `6a04794` | Cerrado local; nube pendiente. |
| H12 | DB/provider errors permanecen `INTERNAL_ERROR`; ausencia/ajeno se separa como `NOT_FOUND`/denegación y la UI muestra error controlado. Unitarias e integración Repository. | `6a04794`, `d74419a` | Cerrado local; proveedor cloud pendiente. |
| H13 | Textos de producto Repository/Upload en inglés y labels verificadas por Playwright. | `6a04794`, `d74419a` | Cerrado local. |
| H14 | Inventario MCP/CLI fue solo lectura: Preview `develop` carece de `SUPABASE_SERVICE_ROLE_KEY`; `NEXT_PUBLIC_SUPABASE_URL` y `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` sí están configuradas para `develop`. `develop`/`main` siguen sin protección; las migraciones cloud están aplicadas con uploads pausados; Sentry no tiene recepción remota comprobada. | Sin commit de configuración; pendientes operativos | Abierto: completar Preview, Auth hospedado, Sentry y protecciones CI, y desplegar/evidenciar la revisión. |
| H15 | `trace`, video y screenshots Playwright desactivados; filtro Sentry elimina request/extra/user/breadcrumbs. | `d74419a`, `f6dc98e` | Cerrado en configuración/prueba local; remoto pendiente. |
| H16 | Vista `security_invoker` elige latest antes de filtrar; integración Repository cubre múltiples versiones, NULL, conteos y tenants. | `2cc4aa2`, `6a04794` | Cerrado local; cloud pendiente. |
| H17 | Firma `min(8,size)` y Markdown de un byte pasan validación, hash, Storage, publicación canónica y descarga. | `d74419a` | Cerrado local. |

El acta [s1-02-acceptance.md](../testing/s1-02-acceptance.md) separa pruebas locales, observación remota y bloqueos. La implementación local y los hallazgos corregibles por código están cerrados y versionados. El ticket global sigue abierto por los objetos legacy sin reconciliar y las partes remotas de H03/H04/H06/H10/H14/H15: completar Preview, validar Sentry y Auth hospedado, y proteger los gates de CI. El esquema cloud ya está migrado, pero `upload_mode` permanece pausado y la app no se ha desplegado.

### Hallazgo de la revisión independiente final — CTA legacy

La revisión encontró que la página ofrecía “Recover upload” también para versiones legacy con `upload_state IS NULL`. Ese camino está sujeto a reconciliación pausada y no entrega un target normal al navegador, así que la acción no podía terminar la carga. Se ocultó la CTA para esas filas y se conserva el estado “Needs reconciliation”; una prueba de página cubre ambas condiciones. La misma revisión señaló una brecha de prueba, sin fuga confirmada: no había un POST Storage con sesión Member/otro tenant a una ruta temporal ajena. Se añadieron ambos intentos al acceptance HTTP local; Storage los deniega y el objeto sigue ausente. La corrección de UI está en `6a04794` y las pruebas de Storage en `d74419a`; esto no cambia la atribución de los commits de origen.

## 8. Reparación de Storage local — 2026-10-03

Este hallazgo corresponde al entorno local de Supabase Storage; **no se atribuye a un commit ni a un desarrollador del repositorio**. La instancia anterior fijaba `storage-api:v1.77.5` y Postgres `17.6.1.166`; su tabla interna registraba las migraciones 66 `objects-current-version-index` y 72 `drop-bucketid-objname-index`.

En esa instancia, el índice `idx_objects_current_version` usaba la collation predeterminada, aunque Storage emitía `ON CONFLICT (bucket_id, name COLLATE "C") WHERE archived_at IS NULL`; el `EXPLAIN` exacto fallaba con `42P10` y el upload devolvía HTTP 500. Una instalación separada con los mismos pines y archivos del proyecto creó el índice con `COLLATE "C"`, aceptó el target exacto y completó un upload HTTP real seguido de cleanup. La evidencia confirma que la definición persistida en el volumen anterior era incompatible. Es compatible con una deriva de una migración interna ya registrada, pero no identifica la versión histórica exacta que creó ese índice.

Se detuvo el proyecto anterior sin `--no-backup`, por lo que sus volúmenes locales permanecen. `supabase/config.toml` ahora usa `project_id = "knowledge-decay-monitor-s1-02"`; se actualizó el nombre esperado del contenedor en `tests/support/local-supabase.ts`. El nuevo stack arrancó en los puertos habituales con las versiones fijadas, su índice de migration 66 contiene `COLLATE "C"` y el upload real pasa. La clave pública existente de `.env.local` siguió coincidiendo. No se alteró el esquema interno Storage ni se cambió ningún servicio cloud.

La prueba focal pasó 1/1. Su primera ejecución posterior a la reparación encontró una expectativa incorrecta: Storage `remove()` puede responder `error = null` y una lista vacía cuando RLS no permite el borrado. La prueba ahora confirma esa respuesta y verifica con el cliente de servicio que el objeto permanece. La referencia de [`remove()`](https://supabase.com/docs/reference/javascript/file-buckets-remove) indica que el borrado requiere `DELETE` y `SELECT`; la guía de [diseño del esquema Storage](https://supabase.com/docs/guides/storage/schema/design) recomienda tratar sus tablas como solo lectura.

La inspección de solo lectura del 2026-10-03 encontró únicamente `00001`; el runbook posterior registra la aplicación cloud de la migración Dev 2 y las 12 migraciones S1-02, hasta `20261003214934`, con `upload_mode` pausado. No se aplicaron seed ni se borraron registros u objetos; cuatro objetos Storage permanecen sin versión asociada y fuera de la reconciliación actual. Los índices Storage remotos incluyen `COLLATE "C"`. Vercel MCP, con `decrypt=false`, confirmó las claves públicas de Preview/`develop` y la ausencia de `SUPABASE_SERVICE_ROLE_KEY`; los valores permanecen sin leer. No se desplegó la app ni se modificaron Vercel, Auth, Sentry o GitHub.

Tras el aislamiento local, la integración completa pasó 11/11 archivos y 15/15 pruebas; Chromium pasó 16/16. El stack descartable validó instalación limpia (14 migraciones) y upgrade desde Dev 2 (12 migraciones S1-02), cada uno con 9 archivos/198 aserciones SQL aprobadas. El upload de 10 MiB, publicación, descarga autorizada, denegaciones y recovery también pasan localmente. El detalle está en [el acta](../testing/s1-02-acceptance.md). La reparación local del volumen no tuvo commit de repositorio ni autor de código; la configuración reproducible del project id y del harness quedó en `2cc4aa2` y `f6dc98e`. Se conservó el volumen previo y no se alteró el esquema interno Storage.
