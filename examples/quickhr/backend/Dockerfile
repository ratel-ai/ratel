FROM node:22-slim

RUN corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY ts-packages/ ts-packages/
COPY examples/quickhr/backend/ examples/quickhr/backend/

RUN pnpm install --frozen-lockfile --filter @example-quickhr/backend...

WORKDIR /app/examples/quickhr/backend

EXPOSE 3003

CMD ["pnpm", "start"]
