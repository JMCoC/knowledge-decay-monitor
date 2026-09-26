# PROMPT: Formalización Técnica del Protocolo Anti-Bloqueo (Día 0)

## 1. ROL Y PERFIL DEL AGENTE
Actúa como un **Staff Software Architect** y **Tech Lead** de clase mundial especializado en Next.js (App Router), Supabase (PostgreSQL + RLS + pgvector) y arquitecturas de tipo Monolito Modular. Tienes tolerancia cero a la sobreingeniería (cero capas redundantes estilo "Controller -> Service -> Manager -> Repository") y tu prioridad absoluta es la paralelización del trabajo en equipos pequeños mediante contratos estrictos y desacoplamiento de dependencias.

---

## 2. CONTEXTO DEL PROYECTO
Estamos iniciando el Sprint 1 (2 semanas) de **Knowledge Decay Monitor**, un B2B SaaS MVP para startups de tecnología desarrollado por un equipo de **3 desarrolladores full-stack**.
* **El Problema:** Tres desarrolladores trabajarán simultáneamente sobre la misma base de código. Si no se establecen contratos duros el "Día Cero", se generarán bloqueos en cascada (esperar a que el Dev 1 termine Auth/Workspace para que el Dev 2 o 3 puedan trabajar) y colisiones masivas de Git/migraciones.
* **Stack Obligatorio:** Next.js (TypeScript, Tailwind, Server Actions), Supabase (Auth, PostgreSQL, pgvector, Storage privado), Zod y Vitest.
* **Regla de Negocio Crítica:** Aislamiento multi-tenant no negociable basado en `workspace_id` mediante Row Level Security (RLS).

---

## 3. OBJETIVO / TAREA PRINCIPAL
Formalizar y generar la especificación técnica accionable e inmediata del **Protocolo Anti-Bloqueo** para el arranque del Sprint 1, limitándote estricta y detalladamente a los siguientes tres pilares:

### PILAR 1: Congelar Esquema de Base de Datos y Tipos TypeScript (Día Cero)
* Generar el script DDL inicial reproducible para Supabase (`00001_initial_schema.sql`).
* Debe contener las entidades mínimas requeridas por el Sprint 1:
  - `workspaces` (id, name, created_at, etc.)
  - `profiles` (id -> auth.users, workspace_id, role enum ['Admin', 'QA Lead', 'Member'], full_name, email)
  - `documents` (id, workspace_id, name, category enum, owner_id -> profiles, active_version_id, timestamps)
  - `document_versions` (id, document_id, version_number, storage_path, processing_status enum ['uploaded', 'processing', 'ready', 'processing_failed'], version_status enum nullable ['active', 'historical', 'pending_approval', 'rejected'], analysis_status enum ['pending_reanalysis', 'analyzed'])
  - `document_chunks` (id, version_id, chunk_index, text_content, page_number, section_heading, embedding vector(384) para `gte-small`)
* Habilitar extensión `vector`.
* Definir las políticas RLS iniciales estructurales por `workspace_id`.
* Generar las interfaces y contratos TypeScript estáticos correspondientes (`types/database.ts`).

### PILAR 2: Supabase Local con `seed.sql` Exhaustivo (Bypass de Dependencias de Flujo)
* Generar un script SQL de datos mock (`supabase/seed.sql`) que elimine la necesidad de esperar por la UI de Auth o el Pipeline de Ingesta.
* El seed debe incluir:
  - Dos tenants aislados para pruebas de penetración RLS: **Workspace A** y **Workspace B**.
  - Tres usuarios en Workspace A con credenciales mock: 1 Admin, 1 QA Lead, 1 Member.
  - Un usuario Admin en Workspace B.
  - Documentos precargados en Workspace A en tres estados distintos para que el Frontend trabaje de inmediato:
    1. Documento en estado `ready` y `active` (con versión v1, chunks de texto y vectores mock de 384 dimensiones).
    2. Documento en estado `processing` (para validar estados de carga/spinners).
    3. Documento en estado `processing_failed` (para que el Dev encargado de la recuperación de errores pueda probar el botón "Retry" sin provocar fallos reales).

### PILAR 4: Modularidad Estricta en Git y Matriz de Ownership (Cero Merge Conflicts)
* Diseñar un árbol de directorios bajo el paradigma de **Monolito Modular por Dominio de Negocio** (no por capas técnicas genéricas).
* Dividir el alcance en límites claros para 3 desarrolladores:
  - **Dev 1:** Dominio de Identidad, Workspace, RBAC, Shell base y Setup CI/CD.
  - **Dev 2:** Dominio de Ingesta, Storage y Procesamiento vectorial (Headless/Backend).
  - **Dev 3:** Dominio de Repository UI, Búsqueda/Filtros, Signed URLs y Manejo de Errores/Retry.
* Establecer la política de ramificación Git (Branching Strategy), reglas de commit y el protocolo de no intervención de archivos ajenos para garantizar 0 conflictos al integrar.

---

## 4. RESTRICCIONES Y GUÍAS DE CALIDAD
1. **Evitar la sobrearquitectura:** No incluyas capas vacías (evita patrones como `Controller -> Service -> Manager -> Handler -> Repository -> DAO`). Mantén la arquitectura pragmática: Server Action / Interfaz pública del módulo -> Lógica de Dominio -> Infraestructura de Supabase.
2. **Autocontenido y listo para copiar:** El código SQL y TypeScript debe ser sintácticamente válido, completo (sin comentarios tipo `// TODO: add remaining fields`) y alineado a Postgres 15+.
3. **Seguridad Nativa:** Ningún query debe depender del cliente para validar el `workspace_id`.

---

## 5. FORMATO DE SALIDA REQUERIDO
Organiza tu respuesta en las siguientes secciones numeradas en Markdown:
1. **ARTEFACTO 1 (Pilar 1):** Script SQL `00001_initial_schema.sql` y archivo `src/types/database.ts`.
2. **ARTEFACTO 2 (Pilar 2):** Script SQL `supabase/seed.sql` con datos representativos y vectores sintéticos válidos.
3. **ARTEFACTO 3 (Pilar 4):** Estructura del árbol de directorios del proyecto (`src/modules/...`) junto con una **Matriz de Propiedad de Archivos (Ownership Matrix)** que asigne explícitamente qué carpetas/archivos son propiedad exclusiva de Dev 1, Dev 2 y Dev 3.
4. **GUÍA DE ARRANQUE "DÍA CERO":** Checklist de 5 pasos para que los desarrolladores ejecuten en sus terminales locales antes de escribir su primera línea de código.