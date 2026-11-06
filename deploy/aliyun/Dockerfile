# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:20.20.2-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/db/package.json packages/db/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @dianjie/api... --filter @dianjie/web...
COPY packages/db packages/db
RUN pnpm --filter @dianjie/db generate

FROM dependencies AS api-build
COPY apps/api/src apps/api/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json
RUN pnpm --filter @dianjie/api exec tsc
RUN cp -a apps/api/src/services/meituan/fixtures apps/api/dist/services/meituan/fixtures
RUN pnpm --filter @dianjie/api deploy --legacy --prod /out/api
RUN cd apps/api && node -e "const f=require('fs'),p=require('path');const client=p.dirname(require.resolve('.prisma/client/package.json',{paths:[p.dirname(require.resolve('@prisma/client'))]}));f.cpSync(client,'/out/api/node_modules/.prisma/client',{recursive:true})"

FROM ${NODE_IMAGE} AS api
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
COPY --from=api-build /out/api ./
COPY --from=api-build /workspace/apps/api/dist ./dist
COPY deploy/aliyun/api-entry.cjs ./container-entry.cjs
RUN mkdir -p /data/receipts && chown node:node /data/receipts
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=4000
USER node
EXPOSE 4000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:4000/health').then(r=>r.json()).then(j=>process.exit(j.status==='ok'&&j.db==='ok'?0:1)).catch(()=>process.exit(1))"
CMD ["node", "/app/container-entry.cjs"]

FROM dependencies AS web-build
COPY apps/web apps/web
COPY apps/api/src/services/inventory-management-contract.json apps/api/src/services/inventory-management-contract.json
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_API_URL="" NEXT_PUBLIC_API_BASE=http://api:4000 NEXT_PUBLIC_SENTRY_DSN="" NEXT_PUBLIC_PREVIEW_TENANT_SLUG=supply-chain-uat
RUN cd apps/web && pnpm exec tsc --noEmit && pnpm exec next build

FROM ${NODE_IMAGE} AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 NEXT_PUBLIC_API_BASE=http://api:4000
COPY --from=web-build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=web-build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build --chown=node:node /workspace/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/v2/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]
