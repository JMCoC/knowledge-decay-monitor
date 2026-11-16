# Diseño Técnico: S3-03 — Revisión Humana de Hallazgos con Severidad Original y Controles de Asignación

- **Fecha:** 2026-11-15
- **Ticket:** S3-03 ([SAA-27](https://linear.app/saasprojectkdm/issue/SAA-27/revision-humana-de-hallazgos-con-severidad-original-y-controles-de))
- **Responsable:** Juan Pablo Castaño Arango (Dev 3)
- **Estado:** Aprobado para Planificación de Implementación
- **Referencias:** PRD §§20–22, 36, 56, 67; S3-01 ([SAA-25](https://linear.app/saasprojectkdm/issue/SAA-25/contratos-esquema-y-aislamiento-del-vertical-de-human-review-and-correction)); S3-02 ([SAA-26](https://linear.app/saasprojectkdm/issue/SAA-26/maquina-de-estados-severidad-y-asignacion-con-control-de-concurrencia)); Handoff de verificación S3-02.

---

## 1. Contexto y Objetivo

En Sprint 2 (ticket S2-10), se implementó la visualización de hallazgos (`FindingSummary`) y el detalle de evidencia comparativa lado a lado (`FindingDetail` y `FindingEvidenceDrawer`) en modo de solo lectura. Con la máquina de estados, control de concurrencia y contratos de revisión completados en S3-01 y S3-02, **S3-03 implementa la experiencia interactiva de revisión humana para QA Lead y Workspace Admin**.

La historia de usuario establece:
> **Como** QA Lead  
> **Quiero** revisar evidencia y decidir el estado, la severidad y el responsable desde el detalle  
> **Para** iniciar una corrección trazable sin perder el contexto del hallazgo.

### Principios Fundamentales del Incremento
1. **La IA propone, la evidencia demuestra y las personas deciden:** La severidad propuesta por la IA (`severityOriginal`) es un registro inmutable. El revisor humano puede definir un `severityCurrent` divergente (High, Medium, Low), el cual gobierna el ordenamiento y los filtros de la interfaz.
2. **Máquina de Estados Estricta:** Ningún hallazgo en `pending_review` puede saltar directamente a `resolved`. Las transiciones válidas son:
   - `pending_review` → `confirmed` | `false_positive`
   - `confirmed` → `update_planned` | `resolved`
   - `false_positive` → `resolved`
   - `update_planned` → `resolved`
   - `resolved`: Estado terminal; no admite reapertura.
3. **Asignación sin Apertura Automática:** La asignación de un Member elegible del workspace requiere que el hallazgo esté en `confirmed` o `update_planned`. Asignar uno o más hallazgos **no** inicia la ronda de corrección; la preparación del borrador de ronda (`prepareRound`) y su apertura (`openRound`) son acciones explícitas.
4. **Concurrencia Optimista y Resiliencia:** Toda mutación envía la `revision` actual y un `idempotencyKey`. Ante un `CONFLICT` (código HTTP 409 o mismatch de versión en RPC), la interfaz informa al revisor y sincroniza el estado sin sobreescribir decisiones ajenas ni perder cambios.
5. **Cero Fuga de Confianza (`confidence`):** Queda estrictamente prohibido renderizar, serializar en atributos DOM o emitir en telemetría el valor de `confidence`.

---

## 2. Decisiones de Arquitectura y Enfoque Seleccionado (Enfoque A)

Se adopta una arquitectura modular que desacopla los componentes de mutación y flujo de revisión de la UI de análisis existente:

1. **Ubicación de Componentes de Revisión:**
   - Nuevos componentes especializados se ubican en `src/modules/review/ui/`:
     - `finding-review-actions.tsx`: Barra de acciones de estado (`Confirm`, `False Positive`, `Plan Update`, `Resolve`).
     - `severity-control.tsx`: Visualización de `severityOriginal` y selector interactivo de `severityCurrent`.
     - `assignee-selector.tsx`: Selección y revocación de asignatarios (`listAssignees`, `assignFinding`).
     - `round-preparation-modal.tsx`: Diálogo para preparar y abrir rondas de corrección agrupadas.
2. **Extensión no intrusiva de `@/modules/analysis/ui`:**
   - `FindingEvidenceDrawer`: Se mantiene como contenedor lateral modal, integrando los componentes de `@/modules/review/ui` en una sección de decisión claramente delimitada.
   - `FindingsView`: Actualiza el listado para reflejar `severityCurrent`, indicar visualmente si hubo override frente a `severityOriginal` y mostrar el asignatario persistido.
3. **Consumo de APIs:**
   - La UI consume exclusivamente las Server Actions públicas de `@/modules/review`: `changeFinding`, `assignFinding`, `listAssignees`, `getFindingReview`, `prepareRound`, `openRound`. No se invocan RPCs directos ni clientes Supabase internos desde la capa visual.

---

## 3. Invariantes de Seguridad y Límites de Privacidad

| Invariante | Mecanismo de Implementación |
|---|---|
| **Autorización y Roles** | Solo `Admin` y `QA Lead` pueden ejecutar mutaciones de estado, severidad, asignación y rondas. Las Server Actions validan `requireDocumentActor()`. Si un `Member` intenta enviar una mutación, se retorna `FORBIDDEN`. |
| **Aislamiento de Tenant** | La lista de asignatarios (`listAssignees`) y las mutaciones están restringidas al `workspace_id` de la sesión activa verificado criptográficamente en base de datos. |
| **Protección contra XSS** | Textos de hallazgos, explicaciones y nombres de usuarios se renderizan como nodos de texto estándar de React, sin `dangerouslySetInnerHTML`. |
| **Cero Telemetría Confidencial** | No se loguean ni persisten en cliente fragmentos de documentos, URLs firmadas ni scores de `confidence`. |
| **Prevención de Doble Envío** | El estado de transición (`isPending` de React) bloquea y deshabilita todos los controles interactivos hasta recibir respuesta. |

---

## 4. Diseño Detallado de Componentes

### 4.1. `finding-review-actions.tsx`
- **Props:**
  - `findingId: string`
  - `status: ReviewFindingStatus`
  - `revision: number`
  - `canChangeStatus: boolean`
  - `onFindingUpdated: (updated: FindingReviewSnapshot) => void`
  - `onError: (error: ActionError) => void`
- **Comportamiento:**
  - Si `status === "pending_review"`:
    - Botón **Confirm** (verde / primary) → transiciona a `confirmed`.
    - Botón **False Positive** (slate / secondary) → transiciona a `false_positive`.
  - Si `status === "confirmed"`:
    - Botón **Plan Update** (cyan / primary) → transiciona a `update_planned`.
    - Botón **Resolve Manually** (emerald / outline) → transiciona a `resolved`.
  - Si `status === "false_positive"` o `status === "update_planned"`:
    - Botón **Resolve Manually** (emerald / outline) → transiciona a `resolved`.
  - Si `status === "resolved"`:
    - Renderiza badge informativo *"Resolved (Manual)"*. No ofrece botones de acción.

### 4.2. `severity-control.tsx`
- **Props:**
  - `findingId: string`
  - `severityOriginal: FindingSeverity`
  - `severityCurrent: FindingSeverity`
  - `revision: number`
  - `canChangeSeverity: boolean`
  - `onFindingUpdated: (updated: FindingReviewSnapshot) => void`
- **Comportamiento:**
  - Renderiza badge fijo `AI Proposed: [Original]`.
  - Dropdown o grupo de botones para `Current: [High | Medium | Low]`.
  - Al cambiar selección, invoca `changeFinding({ findingId, revision, idempotencyKey: crypto.randomUUID(), change: { field: "severity", value: newSeverity } })`.

### 4.3. `assignee-selector.tsx`
- **Props:**
  - `findingId: string`
  - `currentAssignee: EligibleOwner | null`
  - `revision: number`
  - `canAssign: boolean`
  - `affectedDocuments: { documentId: string; name: string }[]`
  - `onFindingUpdated: (updated: FindingReviewSnapshot) => void`
- **Comportamiento:**
  - Deshabilitado o no visible si `canAssign === false`.
  - Consulta miembros elegibles mediante `listAssignees()`.
  - Opciones: Lista de miembros, opción *"Unassigned"*.
  - Al seleccionar un miembro o desasignar, invoca `assignFinding({ findingId, revision, assigneeId, idempotencyKey })`.
  - Si `affectedDocuments.length > 1`: Renderiza nota explicativa sobre cuál de los documentos debe ser corregido para resolver la contradicción.

### 4.4. `round-preparation-modal.tsx`
- **Props:**
  - `isOpen: boolean`
  - `documentId: string`
  - `documentName: string`
  - `findings: FindingReviewSnapshot[]`
  - `onClose: () => void`
  - `onRoundOpened: (round: ReviewRound) => void`
- **Comportamiento:**
  - Paso 1 (Preparación): Invoca `prepareRound` en modo `assigned_findings` con los IDs de los hallazgos confirmados/planificados para ese documento.
  - Paso 2 (Asignación en bloque o individual): Permite verificar/asignar responsables a los hallazgos de la ronda.
  - Paso 3 (Apertura): Invoca `openRound` con el `roundId` y `revision` devueltos. Transiciona la ronda a estado `collecting`.
  - Muestra aviso claro: *"Opening this round freezes this set of findings for correction. Future findings will require a new round."*

---

## 5. Manejo de Concurrencia, Errores y CONFLICT

1. **Protocolo ante `CONFLICT`:**
   - Si una llamada a `changeFinding` o `assignFinding` retorna `{ ok: false, error: { code: "CONFLICT" } }`:
     - Se muestra un banner/toast de advertencia: *"This finding was modified by another reviewer. Current state has been refreshed."*
     - El componente invoca `getFindingReview({ findingId })` para refrescar el snapshot en pantalla con la nueva `revision` y capacidades actualizadas.
     - No se pierden las decisiones tomadas por otros revisores.
2. **Idempotencia:**
   - Cada intento genera su propio `idempotencyKey` UUID v4.
   - En caso de reintento por pérdida de conexión antes de recibir ACK, se reutiliza la misma clave con el mismo payload.

---

## 6. Estrategia de Pruebas

### 6.1. Pruebas Unitarias y de Componentes (Vitest + React Testing Library)
- `finding-review-actions.test.tsx`:
  - Renderizado de acciones correctas según cada estado (`pending_review`, `confirmed`, `false_positive`, `update_planned`, `resolved`).
  - Verificación de que `pending_review` no muestra botón de `Resolve`.
  - Deshabilitación de botones al estar en proceso (`isPending`).
  - Manejo de respuesta de error `CONFLICT`.
- `severity-control.test.tsx`:
  - Muestra severidad original intacta y permite seleccionar severidad actual.
  - Disparo de `changeFinding` con payload correcto.
- `assignee-selector.test.tsx`:
  - Carga de asignatarios elegibles.
  - Asignar miembro y desasignar (`null`).
  - Renderizado de advertencia multidocumento.
- **Zero-Leakage Assertion:**
  - Búsqueda en el árbol DOM y en atributos de texto buscando cadenas como `confidence` o scores numéricos de IA; la prueba falla si se encuentra cualquier coincidencia.

### 6.2. Pruebas de Integración y E2E (Playwright)
- `tests/e2e/human-review.spec.ts`:
  1. **Flujo Feliz QA Lead:** Iniciar sesión como QA Lead → Abrir hallazgo en `pending_review` → Confirmar → Cambiar severidad de High a Medium → Asignar Member → Verificar que la lista general se actualiza con severidad Medium y el nuevo asignatario.
  2. **Resolución de Falso Positivo:** Marcar `false_positive` → Resolver manualmente → Verificar estado terminal `resolved` sin acciones adicionales.
  3. **Control de Acceso:** Iniciar sesión como `Member` → Intentar acceder a `/analysis/[id]/findings` o invocar acciones → Verificar denegación de permisos en servidor.
  4. **Conflicto Concurrente:** Simular dos clientes con la misma `revision`; el segundo envío recibe `CONFLICT` y la UI sincroniza la versión actualizada.

---

## 7. Plan de Transición e Implementación

Una vez aprobado este documento por el usuario:
1. Se invocará la habilidad `writing-plans` para desglosar la implementación en tareas TDD atómicas.
2. Se crearán los componentes bajo `src/modules/review/ui/`.
3. Se integrarán en `FindingEvidenceDrawer` y `FindingsView`.
4. Se validarán todas las suites unitarias, de integración y Playwright asegurando cobertura total de los criterios DoD de S3-03.
