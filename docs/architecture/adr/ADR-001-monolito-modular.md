# ADR-001 — Monolito modular con persistencia compartida y aislamiento por workspace

Fecha: 2026-09-26.

Estado: formalización de la decisión de monolito modular aprobada para el Día Cero. Alcance: núcleo del MVP y límites iniciales de Sprint 1. No aprueba una infraestructura de ingesta todavía no evaluada.

Relacionados: [arquitectura base](../arquitectura-base.md), [Día Cero](../day-zero-protocol.md), [PRD](../../PRD/knowledge-decay-monitor-prd-final.md), [tickets](../../Tickets/tickets.md).

## 1. ¿Qué problema teníamos?

Tres desarrolladores full-stack deben entregar un SaaS académico en seis sprints de dos semanas. Comparten modelo de datos, autenticación y configuración, pero necesitan trabajar en paralelo. Una organización sin límites haría que Repository escribiera estados del pipeline o que cada desarrollador implementara sus propias reglas de tenant. Separar todo en servicios remotos añadiría despliegues, contratos de red y recuperación distribuida antes de tener el primer flujo usable.

El riesgo prioritario es exponer documentación entre workspaces. La arquitectura debe proteger los datos incluso si alguien evita la interfaz y consulta directamente la API. También debe permitir que las capacidades futuras de análisis, revisión y facturación crezcan sin concentrar todo en Server Actions gigantes.

## 2. ¿Qué decidimos?

Organizar el núcleo Next.js como **monolito modular por capacidades de negocio**: `identity`, `workspace`, `ingestion` y `repository` para Sprint 1. Mantener un repositorio y una base PostgreSQL compartida, con Auth y Storage administrados por Supabase.

Las interfaces entre módulos son funciones y contratos TypeScript pequeños. Las acciones del servidor validan y coordinan operaciones; las reglas permanecen en el módulo responsable y las invariantes persistidas se refuerzan en SQL. No se obliga a pasar por Controller → Service → Repository ni se introduce HTTP para llamar a otro módulo del mismo núcleo.

La identidad y el Profile persistido determinan el workspace y el rol. RLS, GRANT explícitos y relaciones de tenant protegen los datos. Las operaciones privilegiadas se restringen al backend que las necesita; Repository usa el contexto del usuario para consultar y autorizar originales.

Se acepta que Repository lea proyecciones de documentos, versiones y Owner desde el esquema compartido. Esto acopla sus lecturas al contrato de datos, pero sus escrituras de negocio se canalizan al propietario. Dev 1 coordina migraciones/tipos; los tres desarrolladores respetan ownership y revisan cambios de contrato.

Las ejecuciones en segundo plano son fronteras técnicas del mismo producto. Su runtime se decide con evidencia por slice. Las Edge Functions de análisis, purga y notificaciones previstas en el PRD se mantienen como evolución; esta decisión no implica un único proceso para todo el sistema ni un microservicio por módulo.

## 3. ¿Qué alternativas consideramos?

| Alternativa | Ventaja | Costo para este equipo | Resultado |
|---|---|---|---|
| Monolito por capas técnicas globales | Arranque sencillo y pocas unidades de despliegue | Archivos centrales compartidos; reglas de distintos dominios se mezclan en services/controllers | No se adopta como estructura principal |
| Microservicios por dominio o por desarrollador | Despliegues y escalado independientes | Red, autenticación entre servicios, consistencia distribuida y operación adicional para tres personas | No justificado por el MVP |
| Monolito modular por negocio | Contratos claros, llamadas internas simples y transacciones compartidas | Requiere disciplina: el repositorio no impide por sí mismo imports indebidos o escrituras cruzadas | Elegido |

## 4. ¿Por qué?

La opción elegida corresponde al stack y los límites del PRD, conserva el trabajo del Día Cero y permite entregar slices completos. Dev 2 puede desarrollar ingesta con fixtures mientras Dev 1 construye el acceso y Dev 3 desarrolla la presentación del Repository. La separación se basa en responsabilidades y contratos, no en tener tres backends diferentes.

La persistencia compartida permite mantener transacciones pequeñas y explícitas para bootstrap y activación. La separación por módulo reduce cambios simultáneos sobre los mismos archivos sin exigir abstracciones que aún no tienen un segundo uso. Los límites dan una ruta de evolución si aparece una necesidad real de separar una carga de trabajo.

## 5. ¿Qué consecuencias aceptamos?

**Favorables:** menor costo operativo inicial; transacciones SQL donde corresponden; un flujo de migraciones; reutilización de fixtures; ubicación clara de las reglas; contratos que permiten trabajo paralelo.

**Costos y límites:**

- Una base compartida implica coordinar cambios de esquema. Los tipos SQL usados en contratos actuales producen acoplamiento al esquema; los cambios se revisan junto a sus consumidores.
- Ownership y revisión de PR son controles iniciales, no aislamiento técnico completo. No se garantiza cero conflictos de Git.
- Un núcleo común comparte despliegue y fallos de aplicación; no hay escalado independiente automático por módulo.
- Storage y PostgreSQL requieren compensación ante fallos parciales; el monolito no convierte servicios externos en una sola transacción.
- El acceso privilegiado evita RLS y exige cuidado adicional en el procesador. La validación del cliente nunca sustituye autorización.
- El runtime, disparo y recuperación de ingesta siguen pendientes de S1-04. No deben quedar como trabajo abandonado después de conectar la UI.

**Cómo comprobar que seguimos la decisión:** revisar el grafo de dependencias y el contrato afectado en cada PR; ejecutar las pruebas del módulo y los controles de tenant; demostrar los recorridos de la sección 8 de la arquitectura base. S1-08 deberá convertir los controles de CI en requisitos de integración.

**Cuándo reconsiderarla:** mediciones que exijan aislar consumo de recursos o fallos, límites comprobados del hosting para una carga de trabajo, necesidades reales de despliegue independiente o crecimiento del equipo que haga costosa la coordinación. Crear otro ADR con evidencia; no extraer microservicios solo porque aparezca una carpeta nueva.
