# S1-01 — Registro, autenticación y creación inicial del Workspace

**1. Título del Ticket:** Registro seguro y bootstrap del Workspace

**2. Historia de Usuario (Formato Connextra):**

* **Como** Admin
* **Quiero** registrarme con correo y contraseña, crear mi Workspace e iniciar sesión
* **Para** disponer de un espacio privado desde el cual administrar la documentación de mi organización

**3. Criterios de Aceptación (DoD):**

* El registro utiliza **Supabase Auth con email + password**.
* Un usuario autenticado que todavía no pertenece a un Workspace puede crear uno.
* El usuario que crea el Workspace se registra automáticamente con rol `Admin`.
* Cada usuario puede pertenecer a **un único Workspace** en el MVP.
* Después de crear el Workspace, el usuario accede al shell principal de la aplicación.
* Se implementa navegación base responsive y desktop-first utilizando Next.js, TypeScript y Tailwind.
* Las rutas privadas no son accesibles sin una sesión válida.
* Se incluye flujo de **Forgot Password** usando Supabase Auth.
* Los inputs de creación del Workspace son validados con Zod tanto antes de ejecutar la operación como en el backend/Server Action.
* La creación de Workspace y Profile debe realizarse de forma consistente; no debe quedar un Workspace creado sin su Admin inicial.
* Un usuario autenticado no puede consultar otro Workspace modificando IDs, URLs o requests.
* Las tablas iniciales `workspaces` y `profiles` se crean mediante migraciones SQL versionadas.
* El flujo crítico `register → workspace → authenticated application` cuenta con prueba E2E.
* CI debe ejecutar lint, TypeScript type-check y las pruebas asociadas antes de permitir integración.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Crear el primer Workspace correctamente

  * **Dado** que un usuario se ha registrado mediante email y contraseña
  * **Y** todavía no pertenece a ningún Workspace
  * **Cuando** ingresa un nombre válido y crea su Workspace
  * **Entonces** el sistema crea el Workspace
  * **Y** crea su Profile asociado con rol `Admin`
  * **Y** le permite acceder a la aplicación autenticada.

* **Escenario:** Intentar crear un segundo Workspace

  * **Dado** que un Admin ya pertenece a un Workspace
  * **Cuando** intenta ejecutar directamente la operación de creación de otro Workspace
  * **Entonces** el backend rechaza la operación
  * **Y** no se crea ningún segundo Workspace ni relación adicional.

* **Escenario:** Recuperar una contraseña olvidada

  * **Dado** que existe una cuenta registrada
  * **Cuando** el usuario utiliza la opción `Forgot Password`
  * **Entonces** se inicia el flujo de recuperación soportado por Supabase Auth
  * **Y** el proceso no expone información privada del Workspace.

**5. Notas Técnicas:**

* Supabase Auth es el mecanismo de autenticación del MVP.
* Solo se contempla email/password y recuperación de contraseña; no Google, Microsoft, magic links ni SSO.
* Cada usuario pertenece a exactamente un Workspace y el creador se convierte automáticamente en Admin.
* Usar Server Actions para comandos como creación del Workspace y Zod como contrato de validación.
* El shell debe dejar preparada navegación hacia Repository y posteriores módulos, pero no implementar funcionalidad de sprints futuros.

---

# S1-02 — Aislamiento multi-tenant y autorización por roles

**1. Título del Ticket:** Tenant Isolation y RBAC base

**2. Historia de Usuario (Formato Connextra):**

* **Como** Admin
* **Quiero** que toda la información de mi Workspace esté aislada y que cada rol tenga únicamente sus permisos autorizados
* **Para** proteger la documentación privada de accesos entre organizaciones y usuarios no autorizados

**3. Criterios de Aceptación (DoD):**

* El modelo de `profiles` soporta como mínimo los roles `Admin`, `QA Lead` y `Member`.
* Todas las tablas de negocio creadas durante Sprint 1 se encuentran protegidas mediante RLS.
* `workspace_id` constituye la frontera primaria de tenant.
* Un usuario de Workspace A no puede leer registros pertenecientes a Workspace B.
* Un usuario de Workspace A no puede insertar, actualizar o eliminar registros pertenecientes a Workspace B.
* Admin puede acceder a todos los documentos de su propio Workspace.
* QA Lead puede acceder a todos los documentos de su propio Workspace.
* Member no puede acceder al repositorio global.
* Member no puede acceder a documentos no asignados directamente.
* Member no puede crear nuevos documentos lógicos.
* QA Lead no obtiene capacidades reservadas exclusivamente al Admin.
* La autorización se aplica en base de datos/backend y no depende únicamente de ocultar componentes de UI.
* La aplicación no acepta un `workspace_id` enviado por el cliente como prueba de autorización; el Workspace válido se deriva de la identidad autenticada.
* Existen pruebas automatizadas para lectura y mutación cross-tenant.
* Existen pruebas de Member intentando acceder a un documento no asignado.
* Los tests de RLS forman parte de los quality gates de CI.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Admin consulta recursos de su propio Workspace

  * **Dado** un Admin autenticado perteneciente al Workspace A
  * **Y** existen documentos del Workspace A
  * **Cuando** solicita el repositorio
  * **Entonces** recibe únicamente documentos del Workspace A
  * **Y** ninguna información de otros Workspaces es retornada.

* **Escenario:** Usuario intenta acceder a otro tenant manipulando un identificador

  * **Dado** un usuario autenticado perteneciente al Workspace A
  * **Y** existe un documento perteneciente al Workspace B
  * **Cuando** utiliza directamente el ID del documento del Workspace B
  * **Entonces** RLS impide la lectura
  * **Y** el documento no es expuesto aunque el frontend sea evitado.

* **Escenario:** Member intenta acceder al repositorio global

  * **Dado** un usuario autenticado con rol Member
  * **Cuando** intenta abrir el Repository o consultar directamente sus endpoints
  * **Entonces** la solicitud es rechazada
  * **Y** no recibe documentos que no estén directamente asignados.

**5. Notas Técnicas:**

* El PRD establece explícitamente que **“Workspace A can never access Workspace B”** y que RLS debe proteger incluso cuando se evita la UI.
* Las pruebas mínimas requeridas incluyen lectura y escritura cross-workspace, Member sobre documentos/findings no asignados y restricciones por roles.
* Admin y QA Lead tienen acceso al repositorio global del Workspace; Member no.
* Aunque las invitaciones se implementen posteriormente, durante Sprint 1 deben existir fixtures/seeds de QA Lead y Member para verificar la matriz de autorización.

---

# S1-03 — Carga privada de documentos con metadata y validaciones

**1. Título del Ticket:** Upload seguro de documentos y creación de versión v1

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** cargar documentos internos con su metadata requerida
* **Para** incorporarlos de forma controlada y segura al repositorio de mi Workspace

**3. Criterios de Aceptación (DoD):**

* Admin y QA Lead pueden iniciar la carga de nuevos documentos.
* Member no puede crear un nuevo documento lógico.
* Se aceptan únicamente:

  * PDF con texto extraíble.
  * DOCX.
  * Markdown.
* Cada archivo tiene un límite máximo de **10 MB**.
* Cada operación permite como máximo **10 archivos**.
* Las restricciones se validan en frontend y nuevamente en backend.
* Cada documento requiere:

  * Document Name.
  * Category.
  * Owner.
* Category solo acepta las categorías fijas del MVP:

  * SOP.
  * Policy.
  * Manual.
  * QA Process.
  * Security.
  * Engineering Guideline.
  * Other.
* Owner debe corresponder a un usuario existente dentro del mismo Workspace.
* No es posible utilizar como Owner un usuario perteneciente a otro Workspace.
* El modelo debe admitir posteriormente un Owner `Unassigned` si dicho usuario es eliminado.
* Los archivos se almacenan exclusivamente en **Supabase Storage privado**.
* No se generan URLs públicas permanentes.
* Por cada nuevo documento se crea:

  * un registro en `documents`;
  * un registro inicial en `document_versions`.
* La primera versión recibe automáticamente el número `v1`.
* La versión inicia el pipeline con `processing_status=uploaded`.
* El upload no ejecuta análisis IA.
* El upload no consume créditos.
* La operación utiliza Server Action y payload validado mediante Zod.
* Cada registro queda asociado al `workspace_id` obtenido de la sesión autenticada.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** QA Lead carga documentos válidos

  * **Dado** un QA Lead autenticado en Workspace A
  * **Y** selecciona hasta 10 archivos PDF, DOCX o Markdown menores o iguales a 10 MB
  * **Y** proporciona nombre, categoría y Owner válidos
  * **Cuando** confirma el upload
  * **Entonces** los archivos se almacenan privadamente
  * **Y** se crean sus documentos y versiones v1 asociados al Workspace A
  * **Y** las versiones quedan disponibles para procesamiento.

* **Escenario:** Superar el número máximo de archivos

  * **Dado** un Admin intentando cargar documentos
  * **Cuando** selecciona 11 archivos en el mismo batch
  * **Entonces** el sistema rechaza el batch
  * **Y** informa que el máximo permitido son 10 archivos.

* **Escenario:** Cargar un archivo superior a 10 MB

  * **Dado** un QA Lead seleccionando un PDF de 10.5 MB
  * **Cuando** intenta cargarlo
  * **Entonces** el sistema rechaza el archivo
  * **Y** no crea registros de documento o versión para ese archivo.

* **Escenario:** Intentar asignar como Owner a un usuario de otro Workspace

  * **Dado** un Admin del Workspace A
  * **Y** existe un usuario perteneciente al Workspace B
  * **Cuando** manipula la petición para utilizar ese usuario como Owner
  * **Entonces** el backend rechaza la operación
  * **Y** no crea el documento.

**5. Notas Técnicas:**

* Los tipos admitidos y límites son exactamente PDF textual, DOCX y Markdown, máximo 10 MB por archivo y máximo 10 archivos por batch.
* La metadata obligatoria es Name, Category y Owner; Owner debe pertenecer al Workspace.
* `documents` mantiene la identidad lógica y `document_versions` los archivos físicos/versiones; el versionado es automático.
* Storage debe permanecer privado. El cliente no debe recibir credenciales de servicio ni permisos que eviten RLS.

---

# S1-04 — Procesamiento, chunking e indexación semántica automática

**1. Título del Ticket:** Procesamiento e indexación automática de documentos

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** que los documentos cargados sean procesados e indexados automáticamente
* **Para** dejarlos técnicamente preparados para análisis posteriores sin trabajo manual adicional

**3. Criterios de Aceptación (DoD):**

* Después de un upload válido el procesamiento se inicia del lado servidor.
* El pipeline soporta extracción de texto de:

  * PDF con texto extraíble.
  * DOCX.
  * Markdown.
* El `processing_status` sigue las transiciones definidas:

  * `uploaded`
  * `processing`
  * `ready`
  * o `processing_failed`.
* El archivo se parsea antes de generar chunks.
* El chunking es determinístico.
* El algoritmo prioriza headings y párrafos.
* Los bloques sobredimensionados se dividen solo cuando sea necesario.
* La configuración inicial utiliza:

  * target aproximado de **450 tokens**;
  * overlap de **50 tokens**.
* Cada chunk almacena como mínimo:

  * texto;
  * referencia a la versión;
  * orden;
  * página/sección;
  * heading/título de sección cuando esté disponible;
  * embedding.
* Los embeddings utilizan **Supabase `gte-small`**.
* Los embeddings se almacenan utilizando pgvector.
* Una versión solo pasa a `processing_status=ready` después de completar correctamente parsing, chunking, generación de embeddings y persistencia.
* Los chunks y embeddings mantienen el aislamiento de tenant de la versión/documento de origen.
* Un error durante el procesamiento nunca convierte la versión en `ready`.
* Un fallo de parsing deja la versión en `processing_status=processing_failed`.
* Los fallos de procesamiento no consumen créditos.
* El procesamiento no invoca Cerebras, Groq ni ningún análisis LLM.
* No se persisten datos de un Workspace distinto al Workspace propietario del documento.
* Mientras una versión inicial `v1` se encuentre en `uploaded`, `processing` o `processing_failed`, no debe considerarse funcionalmente activa y su `version_status` permanece sin asignar (`NULL`).
* Mientras la `v1` no haya completado exitosamente el procesamiento, `documents.active_version_id` debe permanecer sin asignar.
* **Regla de transición v1:** si la versión procesada es `v1`, correspondiente a la primera versión de un documento nuevo, únicamente después de completar exitosamente parsing, chunking, generación de embeddings y persistencia debe establecerse `version_status=active`.
* Al activar la `v1`, `documents.active_version_id` debe actualizarse para apuntar a dicha versión.
* La actualización de `version_status=active` y `documents.active_version_id` debe realizarse de forma consistente dentro de la misma operación de persistencia, evitando que el documento apunte a una versión que no esté correctamente procesada.
* Una `v1` con `processing_status=processing_failed` nunca debe quedar con `version_status=active` ni asignarse como `active_version_id`.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Procesar correctamente un DOCX nuevo (v1)

  * **Dado** un DOCX válido cargado en Workspace A que corresponde a la versión `v1`
  * **Y** la versión tiene `processing_status=uploaded`
  * **Y** su `version_status` todavía no está asignado
  * **Y** el documento lógico no tiene `active_version_id`
  * **Cuando** se ejecuta correctamente el procesamiento del documento
  * **Entonces** el texto es extraído
  * **Y** se generan chunks determinísticos
  * **Y** se generan embeddings con `gte-small`
  * **Y** los chunks y vectores son almacenados
  * **Y** la versión termina con `processing_status=ready`
  * **Y** el estado funcional de la versión cambia a `version_status=active`
  * **Y** el documento lógico actualiza `documents.active_version_id` para apuntar a la `v1`.

* **Escenario:** Mantener v1 sin activar mientras se está procesando

  * **Dado** un documento nuevo cuya versión `v1` fue cargada correctamente
  * **Y** su `processing_status=uploaded`
  * **Cuando** el procesamiento cambia a `processing_status=processing`
  * **Entonces** la versión todavía no tiene `version_status=active`
  * **Y** `documents.active_version_id` permanece sin asignar
  * **Y** la versión no puede considerarse lista para análisis.

* **Escenario:** Fallar al procesar un PDF sin texto extraíble

  * **Dado** un PDF correspondiente a una versión inicial `v1` que requiere OCR
  * **Cuando** el sistema intenta procesarlo
  * **Entonces** la extracción de texto no se considera exitosa
  * **Y** la versión queda con `processing_status=processing_failed`
  * **Y** la versión no cambia a `version_status=active`
  * **Y** `documents.active_version_id` permanece sin asignar
  * **Y** la versión no se marca como analizable
  * **Y** no se consumen créditos.

* **Escenario:** Verificar aislamiento de los chunks

  * **Dado** chunks pertenecientes a un documento del Workspace B
  * **Cuando** un usuario autenticado del Workspace A intenta consultarlos directamente
  * **Entonces** RLS bloquea el acceso
  * **Y** ningún texto ni embedding del Workspace B es expuesto.

**5. Notas Técnicas:**

* El pipeline definido por el PRD es Storage → document/version → parsing → deterministic chunking → embeddings → chunks → `ready`.
* La configuración inicial es 450 tokens con 50 de overlap y almacenamiento de ubicación/heading.
* Embeddings: Supabase `gte-small`; recuperación futura mediante pgvector.
* El PRD exige procesamiento **server-side**, pero no obliga a utilizar una Edge Function específica para esta ingesta; esa elección puede mantenerse como decisión de implementación.
* Debe verificarse durante implementación la disponibilidad y condiciones vigentes de `gte-small`, tal como indica el PRD.
* `processing_status` y `version_status` representan dimensiones distintas: el primero indica el estado técnico del procesamiento y el segundo el estado funcional de la versión.
* Para la carga inicial de un documento, `v1` permanece sin estado funcional activo mientras se procesa. Solo después de finalizar correctamente el pipeline pasa a `version_status=active`.
* La combinación que identifica una versión disponible para futuros análisis será `processing_status=ready` + `version_status=active`.
* **Nota sobre la regla de activación:** esta activación automática aplica únicamente para la carga inicial (`v1`) de un nuevo documento realizada por Admin o QA Lead. Las versiones de corrección (`v2`, `v3`, etc.) introducidas posteriormente mediante el workflow de Member en Sprint 3 utilizarán `version_status=pending_approval` y no se activarán automáticamente.
* Una versión inicial con procesamiento fallido permanece asociada a su documento lógico, pero no se convierte en la versión activa hasta que un procesamiento válido finalice satisfactoriamente.


---

# S1-05 — Repositorio y acceso seguro a documentos

**1. Título del Ticket:** Repository privado con acceso seguro a archivos

**2. Historia de Usuario (Formato Connextra):**

* **Como** Admin
* **Quiero** visualizar los documentos disponibles en mi Workspace y abrirlos de forma segura
* **Para** consultar la documentación privada y conocer su estado de procesamiento

**3. Criterios de Aceptación (DoD):**

* Admin y QA Lead pueden abrir la vista Repository.
* Member no puede navegar el Repository global.
* La lista solo contiene documentos pertenecientes al Workspace autenticado.
* Cada entrada muestra, como mínimo:

  * Document Name;
  * Category;
  * Owner;
  * versión actual;
  * estado de procesamiento.
* Una versión `processing` se identifica claramente como todavía no lista.
* Una versión `processing_failed` se identifica como fallida y no analizable.
* Una versión `ready` se identifica como procesada correctamente.
* El usuario puede abrir el archivo original desde el Repository.
* El backend valida nuevamente permisos antes de conceder acceso al archivo.
* El acceso al Storage se realiza mediante URL firmada temporalmente.
* La duración inicial de la signed URL es de aproximadamente **5 minutos**.
* No existe URL pública permanente para un documento.
* Un usuario de Workspace A no puede obtener una URL firmada para un documento de Workspace B.
* Member no puede obtener una URL firmada para un documento no asignado.
* Conocer o adivinar el Storage object path no permite saltarse la autorización.
* Se cubre mediante E2E el flujo `upload → processing → repository → secure open`.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Admin abre un documento procesado

  * **Dado** un Admin del Workspace A
  * **Y** existe un documento `ready` perteneciente al Workspace A
  * **Cuando** lo abre desde el Repository
  * **Entonces** el servidor valida su autorización
  * **Y** genera acceso firmado de corta duración
  * **Y** el Admin puede consultar el archivo privado.

* **Escenario:** Intentar acceder a un documento de otro Workspace

  * **Dado** un usuario del Workspace A
  * **Y** conoce el identificador de un documento del Workspace B
  * **Cuando** solicita acceso al archivo
  * **Entonces** la operación es rechazada
  * **Y** no se genera signed URL.

* **Escenario:** Member intenta navegar el Repository

  * **Dado** un Member autenticado
  * **Cuando** intenta abrir el Repository
  * **Entonces** el sistema bloquea la vista
  * **Y** la misma restricción se mantiene en backend y RLS.

**5. Notas Técnicas:**

* Admin y QA Lead tienen acceso global a los documentos de su Workspace; Member únicamente a recursos asignados.
* Supabase Storage es privado, no puede utilizar URLs públicas permanentes y el acceso debe validarse del lado servidor mediante signed URL; expiración inicial recomendada: 5 minutos.
* El Repository forma parte explícita del Sprint 1 y debe permitir navegar documentación privada ya procesada.

---

# S1-06 — Búsqueda y filtros básicos del Repository

**1. Título del Ticket:** Búsqueda y filtrado de documentos

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** buscar y filtrar los documentos de mi Workspace
* **Para** localizar rápidamente la documentación que necesito revisar

**3. Criterios de Aceptación (DoD):**

* Admin y QA Lead pueden buscar documentos por nombre.
* Se puede filtrar por:

  * Category;
  * Owner;
  * version state.
* Search y filtros pueden utilizarse conjuntamente.
* Los resultados siempre permanecen restringidos al Workspace autenticado.
* Una búsqueda nunca devuelve nombres, contadores o metadata perteneciente a otros Workspaces.
* Las opciones del filtro Owner solo incluyen usuarios válidos del mismo Workspace.
* Las categorías disponibles corresponden a las categorías fijas del MVP.
* Los parámetros de búsqueda/filtro se validan mediante Zod.
* Una búsqueda sin coincidencias muestra un empty state y no un error.
* Member no puede utilizar esta funcionalidad para descubrir documentos globales.
* El backend/RLS aplica las mismas restricciones aunque los parámetros sean manipulados manualmente.
* Existen pruebas que combinen tenant isolation con búsqueda y filtros.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Filtrar documentos por nombre y categoría

  * **Dado** un QA Lead con varios documentos en su Workspace
  * **Y** algunos pertenecen a la categoría `Security`
  * **Cuando** busca por nombre y selecciona `Security`
  * **Entonces** recibe únicamente documentos que cumplen ambos criterios
  * **Y** todos pertenecen a su Workspace.

* **Escenario:** Búsqueda sin coincidencias

  * **Dado** un Admin dentro del Repository
  * **Cuando** busca un nombre que no existe en su Workspace
  * **Entonces** se muestra un estado sin resultados
  * **Y** no se exponen documentos de otros Workspaces aunque allí exista el mismo nombre.

* **Escenario:** Member manipula directamente los parámetros del Repository

  * **Dado** un Member autenticado
  * **Cuando** envía manualmente una consulta de búsqueda del Repository
  * **Entonces** la autorización bloquea el acceso global
  * **Y** no obtiene metadata de documentos no asignados.

**5. Notas Técnicas:**

* El PRD requiere search por nombre y filtros por categoría, Owner y version state.
* No se requiere búsqueda semántica del Repository en este sprint.
* `pgvector` se incorpora en Sprint 1 para la indexación que utilizará posteriormente el análisis; el buscador básico del Repository no necesita utilizar embeddings.

---

# S1-07 — Recuperación ante fallos de procesamiento

**1. Título del Ticket:** Recuperación de documentos con Processing Failed

**2. Historia de Usuario (Formato Connextra):**

* **Como** QA Lead
* **Quiero** identificar y recuperar documentos cuyo procesamiento haya fallado
* **Para** corregir problemas de ingesta sin perder el control del repositorio

**3. Criterios de Aceptación (DoD):**

* Una versión cuyo parsing o procesamiento falle queda en `processing_failed`.
* El Repository informa claramente el estado fallido.
* Una versión `processing_failed` no se considera lista para análisis.
* Admin y QA Lead pueden solicitar un nuevo intento de procesamiento.
* Un retry utiliza el mismo Workspace y mantiene el aislamiento del documento original.
* Un retry no consume créditos.
* La operación de retry vuelve a validar que el usuario tenga permiso sobre el documento.
* Member no puede reintentar el procesamiento de un documento global no asignado.
* El retry no crea accidentalmente un segundo documento lógico.
* Múltiples acciones repetidas del usuario no deben provocar acceso cross-tenant.
* Si vuelve a fallar, la versión permanece en `processing_failed` y el usuario recibe un error controlado.
* El fallo técnico se registra de manera segura en Sentry.
* El contenido del documento no debe enviarse a Sentry.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Reprocesar correctamente una versión fallida

  * **Dado** un documento del Workspace A con estado `processing_failed`
  * **Y** el QA Lead tiene permiso sobre el documento
  * **Cuando** selecciona Retry Processing
  * **Entonces** el sistema vuelve a ejecutar el pipeline
  * **Y** si el procesamiento termina correctamente la versión pasa a `ready`
  * **Y** no se consumen créditos.

* **Escenario:** Reintento vuelve a fallar

  * **Dado** un documento cuyo contenido no puede procesarse correctamente
  * **Cuando** un Admin solicita Retry Processing
  * **Entonces** la versión vuelve a finalizar como `processing_failed`
  * **Y** el usuario recibe un estado de error controlado
  * **Y** el documento no se presenta como listo.

* **Escenario:** Usuario de otro tenant intenta reintentar el procesamiento

  * **Dado** un documento perteneciente al Workspace B
  * **Y** un usuario autenticado del Workspace A conoce su ID
  * **Cuando** intenta ejecutar Retry Processing
  * **Entonces** el backend rechaza la operación
  * **Y** no se inicia procesamiento alguno.

**5. Notas Técnicas:**

* El PRD establece que al fallar parsing la versión se marca `processing_failed`, no puede analizarse y el usuario puede reintentar el procesamiento o reemplazar el archivo.
* El PRD no define con precisión si **Replace File** sobre una carga inicial fallida reutiliza la versión o crea una nueva versión numerada. Conviene cerrar esa regla antes de implementar el reemplazo; el retry de la versión existente sí puede implementarse sin esa ambigüedad.
* No introducir todavía el corrected-version workflow de Member, ya que pertenece a Sprint 3.

---

# S1-08 — Manejo seguro de errores, observabilidad y quality gates

**1. Título del Ticket:** Observabilidad segura y calidad mínima del Repository

**2. Historia de Usuario (Formato Connextra):**

* **Como** Admin
* **Quiero** que los fallos del repositorio sean detectables y manejados de forma segura
* **Para** mantener una versión estable del producto sin exponer documentación confidencial

**3. Criterios de Aceptación (DoD):**

* Sentry está integrado en la aplicación como mecanismo base de observabilidad.
* Excepciones producidas durante autenticación, Workspace, upload y procesamiento pueden ser registradas.
* Los eventos de Sentry pueden incluir IDs y metadata técnica no sensible.
* Sentry **no recibe**:

  * contenido de documentos;
  * chunks;
  * embeddings/texto recuperable innecesario;
  * secretos;
  * tokens;
  * credenciales.
* Los errores presentados al usuario son controlados y no muestran stack traces ni detalles internos sensibles.
* Un error backend no permite que la UI asuma que una operación se completó.
* Los estados persistidos de procesamiento permanecen consistentes ante un fallo.
* Todos los cambios de schema se realizan mediante Supabase migrations versionadas dentro del repositorio Git.
* No se consideran válidos cambios manuales al schema sin migración reproducible.
* GitHub Actions ejecuta como mínimo:

  * lint;
  * TypeScript type-check;
  * Vitest;
  * critical RLS tests.
* El deployment queda bloqueado si alguno de dichos controles falla.
* Antes del cierre de Sprint 1 se ejecutan los flujos críticos Playwright de:

  * Auth/Workspace;
  * Upload/Repository.
* El Sprint no se considera Done mientras una prueba crítica de tenant isolation falle.

**4. Escenarios BDD (Gherkin):**

* **Escenario:** Registrar de forma segura un fallo de procesamiento

  * **Dado** un documento privado cuyo procesamiento genera una excepción
  * **Cuando** el backend captura el fallo
  * **Entonces** el usuario recibe un estado de error controlado
  * **Y** Sentry recibe información técnica suficiente para identificar la operación
  * **Y** no recibe el texto del documento ni información secreta.

* **Escenario:** Quality gate detecta un fallo de RLS

  * **Dado** un cambio de código que permite a Workspace A consultar datos del Workspace B
  * **Cuando** GitHub Actions ejecuta los critical RLS tests
  * **Entonces** la prueba falla
  * **Y** el cambio no puede superar el quality gate de deployment.

* **Escenario:** Migración reproducible desde repositorio

  * **Dado** un entorno Supabase compatible con el proyecto
  * **Cuando** se aplican las migraciones versionadas del repositorio
  * **Entonces** se crean las estructuras necesarias del Sprint 1
  * **Y** no se requieren cambios manuales no documentados para ejecutar la aplicación.

**5. Notas Técnicas:**

* El MVP utiliza **Sentry only** para observabilidad y prohíbe enviar documento, chunks, raw prompts, raw model output, secretos o tokens.
* El CI mínimo requiere lint, TypeScript type-check, Vitest y critical RLS tests; el deployment se bloquea si fallan.
* Las migraciones Supabase deben estar versionadas y Git es la fuente de verdad del schema.
* RLS tiene mayor prioridad que una métrica genérica de cobertura de tests.