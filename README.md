# all2api

把 AI 编程客户端的免费/订阅额度反代成标准 API：**一个服务同时暴露 OpenAI 兼容（`/v1/chat/completions`）和 Anthropic 兼容（`/v1/messages`）端点**，背后按模型路由到不同 provider。

| Provider | 额度来源 | 凭据获取方式 | 上游协议 | 状态 |
|---|---|---|---|---|
| **zcode** | 智谱 GLM Coding Plan（ZCode CLI 登录后的额度） | 自动解密本机 `~/.zcode/v2/credentials.json`（AES-256-GCM，与 ZCode CLI 同源实现） | 原生 Anthropic + 原生 OpenAI（bigmodel coding 端点，纯透传） | ✅ 可用 |
| **qoder** | Qoder 免费/订阅额度 | Qoder Integrations 页面生成 PAT（`pt-…`） | 经 [Qoder-2API-Go](https://github.com/EchoPing07/Qoder-2API-Go) sidecar（OpenAI 格式），Anthropic 由本项目转换层提供 | ✅ 可用（需 PAT） |
| **workbuddy**（腾讯） | WorkBuddy 免费额度 | 需逆向（`keyblob` 加密 + 私有协议） | — | ⏸ 未实现，见文末研究清单 |

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

## 附录：WorkBuddy（腾讯）逆向研究清单

本机已确认的事实（`~/.workbuddy/`）：

- 上游域名：`wb.tencentbuddy.com`、`copilot.tencent.com`、`workbuddy.cn`（见 `failover.json`，含熔断/探活配置）；
- 凭据存储：`keyblob`（336B）+ `local_storage/*.info`（加密 blob），`security/at-rest-failures-v1.json` 表明存在静态加密层；`qimei-cache.json` 说明使用腾讯设备 ID 体系；
- 社区无现成项目。

建议路线：

1. mitmproxy 抓 WorkBuddy 客户端一轮真实对话，确认网关路径、请求体格式、SSE 帧结构（注意 `system-ca-bundle.pem`——客户端自带 CA bundle，可能有证书校验，需挂系统代理 + 安装 mitmproxy 根证书）；
2. 定位 `keyblob` 的解密者（DPAPI 还是进程内密钥），可用 API Monitor/x64dbg 或在安装目录二进制中搜 crypto 特征；
3. 确认 token 刷新机制后，仿照 qoder provider 的结构实现 `providers/workbuddy/`。

## 免责声明

本项目仅供学习与研究。使用者需自行承担因违反第三方服务条款导致的账号风险；请勿用于商业用途或损害服务提供方利益的行为。
