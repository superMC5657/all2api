FROM golang:1.26-alpine AS bridge-builder
RUN apk add --no-cache git \
 && git clone --depth 1 --branch main https://github.com/superMC5657/Qoder-2API-Go.git /qoder2api \
 && cd /qoder2api \
 && CGO_ENABLED=0 go build -ldflags "-s -w" -o /out/qoder2api .

FROM node:22-alpine
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY src ./src
RUN pnpm install --frozen-lockfile
COPY --from=bridge-builder /out/qoder2api ./bridges/qoder2api
# the bridge binary on Linux has no .exe suffix — override in config.json:
#   providers.qoder.bridgePath = "bridges/qoder2api"
ENV ALL2API_HOST=0.0.0.0
ENV ALL2API_PORT=8787
EXPOSE 8787
CMD ["pnpm", "start"]
