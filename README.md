# all2api

> 把本机 AI 编程客户端的额度，转成 OpenAI / Anthropic 接口来用。

## 快速开始

```bash
cp config.example.jsonc config.jsonc
pnpm install
pnpm start
```

> 配置文件只认 `config.jsonc`；旧 `config.json` 仅在 jsonc 缺失时回落加载（会 warn 提示迁移）。

## 接入

| 客户端 | 怎么填 |
|---|---|
| 通用（Cherry Studio / NextChat / SDK） | Base URL `http://127.0.0.1:8787/v1` · Key 填 `config.jsonc` 里的 `apiKey` · 模型填 `provider/模型`，如 `codebuddy/hy4-preview` |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` · `ANTHROPIC_AUTH_TOKEN=<apiKey>` |

### 模型写法：`provider/model` 前缀与裸 ID 回落

- 推荐显式前缀，直接 pin 住 provider：`zcode/glm-5.3-flash`、`qoder/GLM-5.3`、`codebuddy/hy4-preview`。
- `GET /v1/models` 返回的条目均为规范的 `provider/model` 形式（`owned_by: all2api:<provider>`）。
- 不带前缀的裸 ID（如 `glm-5.3`）回落到 `config.jsonc` 的 `defaultProvider`（默认 `qoderIntl`）；若该 provider 未启用，再回落到第一个已启用的 provider。

## 凭据

| Provider | 做法 |
|---|---|
| zcode | 本机登过 `zcode login` 就行；或在 `config.jsonc` 填 `providers.zcode.jwt`（显式优先，见下） |
| codebuddy | 本机登过桌面端就行 |
| qoder / qoderIntl | 设置里建个 PAT 填进 `config.jsonc`，如果不填PAT读取本地信息登录 |

### zcode（Start Plan JWT 通道，Anthropic/OpenAI 双协议）

JWT 优先级：`config.jsonc` 的 `providers.zcode.jwt`（显式，非空即优先）＞ 本机 `zcode login` 落盘的 `~/.zcode/v2/credentials.json`（`zcodeJwt`，本机派生密钥加密，仅同一台机器/同一用户可解密）。不要填 bigmodel / open.bigmodel.cn 的 Key——按量通道已移除。

deviceFile 一号一台：按 JWT sub 区分设备指纹并持久化，默认 `~/.zcode/v2/all2api-device.json`（`providers.zcode.deviceFile` 可覆盖，支持 `~` 前缀）；多账号各用各的指纹，不要混用同一个文件。

appVersion 自动探测：`config.jsonc` 的 `providers.zcode.appVersion` 显式值 ＞ `ZCODE_APP_VERSION` 环境变量 ＞ 注册表 ＞ exe ＞ runtime 探测 ＞ 回落（当前桌面端 3.14.3）。上报为 `User-Agent: ZCode/<ver>` 与 `X-ZCode-App-Version` 头。

先校验再接入：

```bash
pnpm decrypt:zcode   # 解密本机 credentials.json，只打印脱敏摘要（前 5 后 4 + 长度）
```

读不到就先跑 `zcode login`。

## captcha 排障（zcode）

上游用阿里云验证码 + 风控码，两类失败要区分：

- `3007`＝验证码挑战（HTTP 400/403 + body `{"code":3007}`）：换 verify param 最多重试 3 次，属正常路径。
- `3012`＝风控「unusual activity」（HTTP 405 承载）：账号/设备被限，直接抛 DISABLED，不要重试刷。

求解器是单进程 Node（`captcha-node/solver.js`，stdout `VERIFY_PARAM=` 行回传），退出码含义：

| 退出码 | 含义 |
|---|---|
| 0 | 求解成功（拿到含 securityToken 的长 param） |
| 2 | 求解超时（含失速 stall 超时） |
| 3 | 初始化失败（DOM/脚本就绪失败等致命错误） |
| 4 | 阿里云 `fail` 回调 / 其他未分类失败 |
| 5 | 阿里云 `onError` 回调 |
| 6 | 参数无效 / 降级结果（无 securityToken 的短 param，上游必回 3007，已丢弃） |

环境变量：

| 变量 | 作用 |
|---|---|
| `CAPTCHA_DEBUG=1` | 打开 solver 详细日志（stderr `[solver] …`） |
| `ZCODE_NODE_PATH` | 指定跑 solver.js 的 node 二进制（默认当前 `process.execPath`） |
| `CAPTCHA_STALL_MS` | 失速判定毫秒数（默认 6000；网络慢/CPU 弱可调大） |

预解池为 FIFO + 95s TTL（上游实际约 2min，提前淘汰），求解失败永不抛错、按空值走现有重试路径。

## scripts/* 用途表

| 脚本 | 命令 | 用途 |
|---|---|---|
| `scripts/zcode-decrypt.ts` | `pnpm decrypt:zcode` | 校验本机 zcode 登录是否可解密，只打印脱敏摘要 |
| `scripts/codebuddy-decrypt.ts` | `pnpm decrypt:codebuddy` | 校验 CodeBuddy/WorkBuddy 桌面端凭据（.info→vscdb 回落），脱敏输出 |
| `scripts/qoder-cn-decrypt.ts` | `pnpm decrypt:qoder-cn` | 本机诊断 Qoder CN 落盘位置与解密可用性（Windows 首次建议先跑） |
| qoder intl 身份探测（内联） | `pnpm decrypt:qoder-intl` | 有无可用的海外版 IDE 登录（exit 0=有，1=无） |
| `scripts/test-translate.ts` | `pnpm test`（其一） | Anthropic↔OpenAI 转译层离线检查（无需联网） |
| `scripts/test-codebuddy.ts` | `pnpm test`（其一） | CodeBuddy 信封密封/解封往返 + SSE 聚合离线检查 |
| `scripts/test-codebuddy-vscdb.ts` | `pnpm test`（其一） | vscdb 凭据源 fixture 闭环测试（离线） |
| `scripts/test-codebuddy-pairing.ts` | `pnpm test`（其一） | .info×二进制配对 fixture 测试（离线） |
| `scripts/build-sidecar.mjs` | `pnpm build:sidecar` | 跨平台构建 qoder sidecar（Windows 出 `.exe`） |

## 调不通看这里

- Key 是否填错
- PAT 是否失效
- 桌面端是否掉登录
- 端口是否被占
- zcode 验证码/风控：看上一节（3007 重试属正常，3012 停手；`CAPTCHA_DEBUG=1` 看 solver 日志）

---

⚠️ 仅供个人学习研究
