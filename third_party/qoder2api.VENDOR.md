# Vendored: Qoder-2API-Go（fork 版，含国际版改动）

Qoder 私有协议的 Go 实现（RSA+AES 混合加密、MD5 签名、自定义 Base64、签名会话），
在本项目中作为 **sidecar 子进程** 运行，由 `src/providers/qoder/bridge.ts` 拉起和管理。
all2api 自身不直接实现 Qoder 协议，只做 HTTP 代理与 OpenAI⇄Anthropic 翻译。

## 来源与基点

- 原始上游：<https://github.com/EchoPing07/Qoder-2API-Go>
- Fork（含国际版改动）：<https://github.com/superMC5657/Qoder-2API-Go.git>，分支 `main`
- Fork commit：`440b11e3a543a1e9732dea920c504117faa9b3f7`（feat(intl): region support, resolve QODER_REGION=intl, IDE identity passthrough；基点 `c7c099a` 之上的 +93/-3）
- 本目录（`third_party/qoder2api` submodule）直接指向上述 fork commit，无需再打补丁

## 国际版（INTL）区域支持（已落库到 fork）

原始上游只支持 Qoder 国内版（PAT 交换 → jobToken）。fork 新增国际版能力，涉及 4 个文件（+93/-3）：

| 文件 | 改动 |
| --- | --- |
| `auth/auth.go` | 新增 `RegionConfig` 与 `Resolve()`：按 `QODER_REGION=intl` 切换到 `center.qoder.sh` / `openapi.qoder.sh`；`AuthURL/ChatURL/ModelListURL` 按 region 取端点 |
| `bridge/bridge.go` | `OpenAiBridge` 增加 `intlIdentity`；`bootstrapSession` 的 INTL 分支跳过 PAT 交换，直接用 IDE 身份（securityOauthToken/refreshToken/uid…）调 `applyJobToken` 建签名会话；`doRenew` 的 INTL 兜底守卫 |
| `store/store.go` | `Config` 增加 `SecurityOauthToken/RefreshToken/UID/Nickname/ExpireTime` 字段（expireTime 用 float64 承载 int64）+ `GetIntlIdentity()` |
| `main.go` | 从 store 读出身份传入 `NewOpenAiBridge(pat, region, intlIdentity)` |

签名会话构造沿用上游国内版逻辑（`auth.NewSession`），国际版与国内版的差别只在端点与
"是否有 PAT 交换"——这是实测得出的结论（国际版 `/algo` 路径同样要求签名，纯 Bearer 会被拒）。

## 运行时约定（bridge.ts 侧）

- 二进制：`bridges/qoder2api.exe` —— **不入库**。all2api 启动时若发现缺失，会用本目录源码自动编译（需 Go ≥ 1.22；见 `src/providers/qoder/bridge.ts` 的 `ensureSidecarBinary`），也可用 `pnpm build:sidecar` 手动编译
- 环境变量：`QODER_HOST=127.0.0.1`、`QODER_PORT=10081/10082`、`QODER_DATA_PATH`、`QODER_REGION=intl`（国际版时）
- 数据文件：`bridges/qoder-cn.json` / `bridges/qoder-intl.json`（含凭据，已在 `.gitignore`）

## 手动编译

```bash
# 需要 Go ≥ 1.22（本机验证过 go1.26.1）
pnpm build:sidecar
# 等价于：
cd third_party/qoder2api && go build -o ../../bridges/qoder2api.exe .
```

改完 submodule 代码后提交并推送到 fork，再更新主仓 gitlink，重新编译并重启 all2api 即生效。

## 同步上游

如需跟随原始上游更新：在 fork 仓库里添加上游 remote，rebase/merge 上游 `main` 到 fork `main`，解决冲突后推送，再更新本仓 submodule gitlink。
