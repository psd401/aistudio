# Async job-runner image (issue #1138) — the SAME agent-router package
# running as an on-demand ECS Fargate task instead of a Lambda. Built by CDK
# (ContainerImage.fromAsset in agent-platform-stack.ts); the Lambda bundling
# path is untouched and continues to run index.handler.
#
# ARM64 to match the platform's Graviton preference; node:20-slim mirrors the
# Lambda's NODEJS_20_X runtime so both entrypoints run the same Node major.

FROM public.ecr.aws/docker/library/node:20-slim AS build
WORKDIR /app
COPY package.json tsconfig.json ./
COPY *.ts ./
RUN npm install --no-audit --no-fund && npx tsc

FROM public.ecr.aws/docker/library/node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

CMD ["node", "dist/job-main.js"]
