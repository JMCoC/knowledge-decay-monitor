# S3-01 — Evidencia de verificación de la base técnica

Fecha: 2026-11-13. Rama: `feat/s3-01-human-review`. SHA de código verificado: `03b7ea0` (`ci(review): add isolated S3-01 upgrade checks`).

## Alcance verificado

La entrega implementa contratos y fixtures tipados, modelo SQL aditivo, integridad, acceso por tenant/rol, audit/outbox, aislamiento de Auth/PostgREST/Storage y validación de upgrade/instalación. No implementa las mutaciones del workflow, su worker ni UI de S3-02 a S3-12.

La base usa seis migraciones S3-01:

1. `20261108150000_s3_01_review_enums.sql`
2. `20261108150100_s3_01_review_model.sql`
3. `20261108150200_s3_01_review_integrity.sql`
4. `20261108150300_s3_01_review_security.sql`
5. `20261108150400_s3_01_review_audit_outbox.sql`
6. `20261108150500_s3_01_approval_contribution_check.sql`

La sexta migración es correctiva y aditiva: una migración de aprobación ya integrada instalaba un trigger que refería `candidate_id` y `round_id` en `correction_approval_contributions`, relación que no tiene esas columnas. Se preservó la migración aplicada y se corrigió mediante una nueva migración; por eso el runner de upgrade y el stage de política esperan seis migraciones S3-01.

## Comprobaciones

| Comando | Resultado |
| --- | --- |
| `pnpm test:unit` | PASS — 118 archivos, 1016 pruebas. |
| `pnpm lint` | PASS — tres warnings preexistentes en pruebas de upload. |
| `pnpm typecheck` | PASS — Next.js emitió el aviso ya existente de Sentry sobre `onRouterTransitionStart`. |
| `pnpm check:database-types` | PASS — tipos SQL generados coherentes. |
| `pnpm test:db` | PASS — 37 archivos SQL, 1517 pruebas pgTAP. |
| `pnpm test:integration -- tests/integration/review-foundation-isolation.test.ts` | PASS — 1 prueba; runner aislado limpió su propio proyecto local. |
| `pnpm test:integration -- tests/integration/analysis-isolation.test.ts` | PASS — 3 pruebas. |
| `pnpm test:fixtures` | PASS — reconciliación local, 4 logins Auth, aislamiento REST, 3 descargas firmadas, 3 denegaciones, bucket privado y RPC legacy denegada. Se pausó la puerta local de upload solo durante el smoke test y se restauró a `active`. |
| `node scripts/check-review-upgrade.mjs --disposable-local` | PASS — upgrade S2 preservó los datos existentes; instalación limpia y pgTAP S3-01 pasaron. Runner ejecutado sobre `03b7ea0`. |
| `node scripts/with-local-supabase.mjs build` | PASS — build de producción; el output estático se generó. Ejecutado con el mismo árbol de código de `03b7ea0`. |

El runner también rechaza el modo `--ci` fuera de GitHub Actions. La ruta CI fue revisada en pruebas de política/guardas; no se ejecutó un workflow real de Actions.

## Límites de la evidencia

Las comprobaciones usan Supabase local y fixtures descartables. No se consultó ni modificó un proyecto remoto, no hubo despliegue o envío de correo real y no se validó el workflow de producto de los tickets S3-02 a S3-12. La revisión humana de contratos, firmas, fixtures y límites por Diego y Juan Pablo continúa pendiente; el ticket S3-01 permanece In Progress hasta esa revisión.
