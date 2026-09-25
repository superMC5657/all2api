# all2api

把 AI 编程客户端的免费/订阅额度反代成标准 API：**一个服务同时暴露 OpenAI 兼容（`/v1/chat/completions`）和 Anthropic 兼容（`/v1/messages`）端点**，背后按模型路由到不同 provider。

| Provider | 额度来源 | 凭据获取方式 | 上游协议 | 状态 |
|---|---|---|---|---|
| **zcode** | 智谱 GLM Coding Plan（ZCode CLI 登录后的额度） | 自动解密本机 `~/.zcode/v2/credentials.json`（AES-256-GCM，与 ZCode CLI 同源实现） | 原生 Anthropic + 原生 OpenAI（bigmodel coding 端点，纯透传） | ✅ 可用 |
| **qoder** | Qoder 国内版额度（qoder.com.cn） | 国内版 IDE/CLI 的 Integrations PAT（`pt-…`） | 经 [Qoder-2API-Go](https://github.com/EchoPing07/Qoder-2API-Go) sidecar（OpenAI 格式），Anthropic 由本项目转换层提供 | ✅ 可用（需 PAT） |
| **qoder-intl** | Qoder 海外版额度（qoder.com） | 海外版 Access Token（IDE 登录界面/官网获取） | 同一 sidecar，`QODER_REGION=intl` 切到 `center.qoder.sh` | ✅ 已适配（需 Access Token） |
| **codebuddy** | 腾讯 CodeBuddy/WorkBuddy 免费积分（Free 档 2000 积分/月） | 自动解密本机桌面端凭据（`CodeBuddyExtension/Data/Public/auth/*.info`，支持 5.6.x `$wbEncrypted` 加密信封） | 原生 OpenAI 协议（`copilot.tencent.com`，仅流式，本地聚合） | ✅ 可用（需本机登录桌面端） |

> ⚠️ **风险与边界**：此类用法通常违反各家服务条款，账号可能被限流或封禁。本项目仅供个人在自有账号、自有额度内学习研究使用，**不支持也不提供批量注册、共享、倒卖等玩法**。反代服务持有你的真实凭据，请勿暴露公网（确需暴露请加 HTTPS 反代并修改 `apiKey`）。

## 快速开始

```bash
pnpm install
pnpm start          # 首次运行自动生成 config.json（含随机 apiKey）
```

```text
all2api listening on http://127.0.0.1:8787
  OpenAI   : POST /v1/chat/completions
  Anthropic: POST /v1/messages
  providers: zcode, qoder
```

调用示例（OpenAI 兼容）：

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer <config.json 里的 apiKey>" \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3-flash","stream":true,"max_tokens":1024,"messages":[{"role":"user","content":"你好"}]}'
```

接入任意 OpenAI 兼容客户端（Cherry Studio / NextChat / openai SDK…）：Base URL 填 `http://127.0.0.1:8787/v1`，API Key 填 all2api 的 `apiKey`。

接入 Claude Code（Anthropic 兼容）：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=<config.json 里的 apiKey>
export ANTHROPIC_MODEL=glm-5.3-flash
```

## Provider 详情

### zcode（零配置）

只要本机登录过 ZCode CLI（存在 `~/.zcode/v2/credentials.json`），无需任何配置：

- all2api 用与 CLI 完全同源的解密实现（`src/providers/zcode/cipher.ts`，AES-256-GCM + sha256 派生，派生串含平台/用户主目录/用户名，**只能在登录时的同一台机器、同一用户下解密**）取出 coding-plan API key；
- 该 key 是标准智谱 key，直接驱动两个原生端点：
  - Anthropic 格式 `https://open.bigmodel.cn/api/anthropic/v1/messages`
  - OpenAI 格式 `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`
- 两种协议都是**纯透传**（含 thinking/reasoning 内容、tools、图片），没有自研格式转换，bug 面最小。

验证解密：`pnpm run decrypt:zcode`（输出脱敏）。

### qoder（需要一个 PAT）

1. 打开 Qoder → 设置 → **Integrations**，创建一个 Personal Access Token（`pt-` 开头）；
2. 填入 `config.json` 的 `providers.qoder.pat`，重启 `pnpm start`；
3. all2api 会自动拉起内置的 Qoder-2API-Go sidecar（`bridges/qoder2api.exe`，已随项目编译好），把 PAT 注入其 `bridges/qoder-data.json` 并监听 `127.0.0.1:10081`。

- Qoder 网关的会话机制是 RSA+AES 混合加密 + MD5 签名（约 2900 行 Go 实现），本项目**不重写协议**，而是把成熟的开源实现作为 sidecar 子进程托管，all2api 对其做反向代理；
- OpenAI 请求原样透传给 sidecar；`/v1/messages` 的 Anthropic 格式由本项目转换层（`src/translate/anthropic.ts`）双向转换：system/多段文本/图片/tool 调用/thinking（reasoning_content）/流式事件全部支持；
- 模型列表从网关动态获取（5 分钟缓存），也可在 `config.json` 静态指定；
- sidecar 自带管理面板 `http://127.0.0.1:10081/admin`（密码在 `bridges/qoder-data.json` 的 `password` 字段），可看额度、订阅周期、用量统计。

> 在 Linux/macOS 上：`cd bridges && go build -o qoder2api .`（源码克隆自上述仓库），并把 `providers.qoder.bridgePath` 改为 `bridges/qoder2api`。Docker 镜像内已自动处理。

### qoder-intl（海外版适配）

`bridges/qoder2api.exe` 是本项目打过补丁的双区域版本：sidecar 原版硬编码国内网关，本仓库给它加了 `INTL` 区域（`QODER_REGION=intl` 切换，默认仍是 CN，**国内版行为不变**）。两个区域可同时运行（不同端口、不同 data.json）：

- 国际版端点映射（从海外版 IDE 的端点注册表提取 + 存活探测验证）：Auth/Chat → `center.qoder.sh`，OpenAPI（额度）→ `openapi.qoder.sh`；`/algo/api/v3/user/jobToken` 等路径与国内版同构；
- 海外版的 PAT 等价物叫 **Access Token**：IDE 内 `Ctrl+Shift+P` → 运行 **Qoder: Sign in with Access Token**（命令 `aicoding.login.accesstoken`），登录界面有 Get Access Token 链接指向官网创建页；或到 qoder.com 官网账号设置里找；
- 拿到 token 后填 `providers.qoderIntl.pat`，重启即可，模型路由前缀为 `qoder-intl/…`；
- 注意：海外版协议与国内版同族（同一鉴权链 jobToken→securityOauthToken→会话签名），但 token 实测打通仍需你提供一个真实 Access Token。

### codebuddy（零配置，覆盖 CodeBuddy 与 WorkBuddy）

只要本机登录过腾讯 CodeBuddy 或 WorkBuddy **桌面端**（两者共用 `copilot.tencent.com` 后端和同一套凭据路径），启用 `providers.codebuddy.enabled` 即可：

- 凭据在 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info`；新版桌面端把 token 字段加密为 `$wbEncrypted` 信封，all2api 会用 WorkBuddy 自己的 Electron 二进制提取静态密钥（`ELECTRON_RUN_AS_NODE` 调私有绑定）后解密——全程本机完成，密钥不落盘；
- token 过期自动调 `/v2/plugin/auth/token/refresh` 刷新，并按原格式（明文/信封）原子回写 auth 文件，401 自动重试一次；
- 上游是标准 OpenAI 协议但**只支持流式**：非流式请求由 all2api 本地聚合 SSE（含 tool_calls 分片拼接与 usage）；
- 工具调用可用，但网关的 `tool_choice` 只接受字符串，对象形式会自动降级为 `required`（无法指定具体函数）；
- 模型：`glm-5.2`、`glm-5.1`、`glm-5v-turbo`、`kimi-k2.7`、`kimi-k2.6`、`kimi-k2.5`、`deepseek-v4-pro`、`deepseek-v4-flash`、`minimax-m3-pay`、`hy3-preview-agent`、`auto`（以 `codebuddy/` 前缀使用）。

验证凭据解密：`pnpm run decrypt:codebuddy`（输出脱敏）。Windows 上 Electron 路径自动从注册表定位（本例 `E:\Program Files\Tencent\WorkBuddy\WorkBuddy.exe`），也可用 `electronPath` 配置或 `WORKBUDDY_ELECTRON_BIN` 环境变量指定。

## 配置参考（config.json）

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8787` | 监听地址；环境变量 `ALL2API_HOST` / `ALL2API_PORT` 可覆盖 |
| `apiKey` | 随机生成 | 客户端访问 all2api 用的 Bearer key（**不是**上游 key）；`ALL2API_API_KEY` 可覆盖 |
| `defaultProvider` | `zcode` | 不带前缀的模型名路由到哪个 provider |
| `upstreamTimeoutMs` | `600000` | 上游请求超时 |
| `providers.zcode.apiKey` | 空 | 留空 = 自动解密本机凭据；也可手动填智谱 key |
| `providers.qoder.pat` | 空 | Qoder PAT |
| `providers.qoder.bridgePath` | `bridges/qoder2api.exe` | sidecar 二进制路径 |

**模型路由**：不带前缀 → 默认 provider；`qoder/GLM-5.3` 这种 `provider/model` 形式 → 指定 provider。`GET /v1/models` 返回聚合列表（非默认 provider 的模型自动带前缀）。

## 用量日志

每个请求一行 JSON 追加到 `usage.jsonl`：时间、provider、模型、协议、是否流式、状态码、耗时。额度查询请看各平台官方面板（Qoder 可看 sidecar 管理面板）。

## 项目结构

```
src/
├─ index.ts                  # 入口：鉴权、模型聚合、路由挂载
├─ config.ts                 # config.json 加载 + 环境变量覆盖
├─ forward.ts                # 统一转发：解析模型 → 路由 → provider → 透传/翻译
├─ router.ts                 # "provider/model" 路由
├─ usage.ts                  # JSONL 用量日志
├─ translate/anthropic.ts    # Anthropic⇄OpenAI 双向转换（含流式）
└─ providers/
   ├─ types.ts               # ProviderAdapter 接口
   ├─ zcode/                 # cipher.ts(解密) credentials.ts(读凭据) client.ts(透传)
   └─ qoder/                 # bridge.ts(sidecar 托管) client.ts(代理+翻译)
scripts/                     # decrypt:zcode / probe:zcode / test-translate
bridges/                     # qoder2api sidecar 二进制 + 数据(gitignore)
```

## 常见问题

- **换机器/换用户后 zcode 解密失败**：派生密钥绑定平台+主目录+用户名，属预期行为。在目标机器上重新 `zcode login`，或在 config.json 手动填 key。
- **ZCode CLI 升级后加密格式变化**：cipher 实现提取自 CLI 本体，若上游改了 `enc:v1` 方案，需要同步更新 `src/providers/zcode/cipher.ts`。
- **qoder 报 401**：PAT 未配置或失效；sidecar 日志带 `[qoder-bridge]` 前缀，配合管理面板排查。
- **并发限制**：Qoder 单 PAT 并发窗口有限（超出返回业务码 10605），sidecar 默认排队；ZCode 遵守智谱计划本身的速率限制。

## 附录：CodeBuddy / WorkBuddy（腾讯）接入分析（2026-09-26，已实测验证，**已实现为 codebuddy provider**）

结论：**可接入，四家中协议最简单**——上游是标准 OpenAI chat 协议，凭据解密方案社区已验证，本机 Windows 5.6.2 全链路实测通过（提取密钥 → 解密 → 上游 200 正常回复）。CodeBuddy 免费额度：Free 档每月 2000 积分 + 新用户 500 积分。

已实测确认的事实链：

1. CodeBuddy 与 WorkBuddy **共用后端** `copilot.tencent.com`；WorkBuddy 桌面端把凭据存在 `%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\*.info`（本机为 `workbuddy-desktop.info`，JSON：`account.uid` + `auth.accessToken/refreshToken/expiresAt/domain`）；
2. WorkBuddy 5.6.x 把这两个 token 字段加密为 `{$wbEncrypted:1, envelope}` 信封（suite 1，AES-256-GCM，nonce 12B + tag 16B，AAD 框架 `WBEV1`/`sym-v1`，keyId 为 16 位 hex）；
3. 密钥获取：用 WorkBuddy 自带的 Electron 二进制（本机 `E:\Program Files\Tencent\WorkBuddy\WorkBuddy.exe`，注册表 `HKLM\...\Uninstall` 可查）以 `ELECTRON_RUN_AS_NODE=1` 执行 `-e 'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))'`，得到 `{version:1, atRestSecretKey}`（32 字节 base64）；`protectorKey = sha256(该 base64 字符串, utf8)`；
4. `keyId = sha256(protectorKey) 的前 16 位 hex`，与信封内 keyId 匹配校验后解密，AAD 构造（逐字转录自 app 本体，见下方参考实现）：`"WB-AAD\0" + 0x01 + len32("WBEV1") + len32("sym-v1") + suite + len32(keyId) + [2,0,0]`；
5. 解密出的 accessToken（JWT）直接可用：`POST https://copilot.tencent.com/v2/chat/completions`，header `Authorization: Bearer` + `X-User-Id`(account.uid) + `X-Domain`(auth.domain，本机为 www.workbuddy.cn) + `X-Enterprise-Id`/`X-Tenant-Id`，body 为标准 OpenAI 格式 → 200，流式 chunk 含 `reasoning_content` 与原生 `function_call`（tools 支持）。

接入 all2api 的实现要点：

- 新增 `providers/codebuddy/`：凭据读取 + 信封解密（约 100 行，标准 node:crypto，零第三方依赖）+ Electron 密钥提取子进程（按 keyId 缓存）；token 临近过期时 `POST /v2/plugin/auth/token/refresh`（`X-Refresh-Token` 头）并**按原信封格式回写** auth 文件（`sealAuthFieldForTest` 给出了对称的封口实现）；
- 上游**只支持流式**：非流式请求需本地聚合 SSE（含 tool_calls 分片拼接），Anthropic 兼容复用 `src/translate/anthropic.ts`（同 Qoder 路径）；
- 模型列表：`glm-5.2`、`glm-5.1`、`glm-5v-turbo`、`kimi-k2.7/k2.6/k2.5`、`deepseek-v4-pro/flash`、`minimax-m3-pay`、`hy3-preview-agent`、`auto`；
- 备选路线（不需要桌面端）：复刻 CLI 的 OAuth 设备授权三步（`plugin/auth/state?platform=CLI` → 浏览器登录 → `plugin/auth/token?state=` 轮询），适合未装桌面端的机器；签到/余额在 `www.codebuddy.cn` 域（`billing/meter/daily-checkin`、`billing/meter/get-user-resource`）。

已知的坑（参考 workbuddy2api 的处理）：

1. **内容审核误报**：客户端注入的 system 模板（含 DoS/exploit 等英文合规词）会被后端逐字匹配拦截（HTTP 400 + security policy 文案），发生在模型推理之前；
2. **429 + code 6004** 是模型级限额（msg 带「将在 … 重置」时间），不是账号整体被限，换模型立即可用。

参考实现：[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（信封解密，`src/desktop-credential-protection.ts`，macOS 5.6.2 验证 + 本机 Windows 5.6.2 复现）、[Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（Go，OAuth 设备授权 + 多账号池）、[HanHan666666/codebuddy2openai](https://github.com/HanHan666666/codebuddy2openai)（Python，读旧版明文凭据，对新版加密格式无效）。

## 免责声明

本项目仅供学习与研究。使用者需自行承担因违反第三方服务条款导致的账号风险；请勿用于商业用途或损害服务提供方利益的行为。
