FROM golang:1.26-alpine AS bridge-builder
# 本地构建：用仓库内 third_party/qoder2api（fork 440b11e，已含 INTL 区域补丁，见 third_party/qoder2api.VENDOR.md），不从 GitHub 拉 main HEAD。
# QODER_REGION 由 TS startBridge（src/providers/qoder/bridge.ts）按 region 注入，Dockerfile 不设。
COPY third_party/qoder2api /qoder2api
RUN cd /qoder2api \
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
