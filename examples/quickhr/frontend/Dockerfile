FROM node:22-slim AS builder

RUN corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY ts-packages/ ts-packages/
COPY examples/quickhr/frontend/ examples/quickhr/frontend/

RUN pnpm install --frozen-lockfile --filter @example-quickhr/frontend...

WORKDIR /app/examples/quickhr/frontend
RUN pnpm build

FROM nginx:alpine

COPY --from=builder /app/examples/quickhr/frontend/dist /usr/share/nginx/html
COPY examples/quickhr/frontend/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 5173
