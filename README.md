# Knowledge Decay Monitor

La [arquitectura base del equipo](docs/architecture/arquitectura-base.md) define contexto, contenedores, módulos, responsabilidades, dependencias, contrato de operación y Walking Skeleton. La decisión principal queda registrada en [ADR-001](docs/architecture/adr/ADR-001-monolito-modular.md).

Para preparar el Sprint 1, seguir el [Protocolo Anti-Bloqueo del Día Cero](docs/architecture/day-zero-protocol.md): esquema, tipos, seed, ownership y checklist local de cinco pasos. Los [resultados de validación](docs/architecture/day-zero-verification.md) distinguen esta base de los flujos del sprint aún pendientes.

El proyecto usa pnpm 12.5.1 (fijado en `package.json`). Después del arranque local, los controles son `pnpm typecheck`, `pnpm lint`, `pnpm test:db` y `pnpm test:fixtures`.

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
