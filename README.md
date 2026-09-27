# all2api

> 把本机 AI 编程客户端的额度，转成 OpenAI / Anthropic 接口来用。

## 快速开始

```bash
cp config.example.jsonc config.jsonc
pnpm install
pnpm start
```

## 接入

| 客户端 | 怎么填 |
|---|---|
| 通用（Cherry Studio / NextChat / SDK） | Base URL `http://127.0.0.1:8787/v1` · Key 填 `config.jsonc` 里的 `apiKey` · 模型填 `provider/模型`，如 `codebuddy/hy4-preview` |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:8787` · `ANTHROPIC_AUTH_TOKEN=<apiKey>` |

## 凭据

| Provider | 做法 |
|---|---|
| zcode | 本机登过 `zcode login` 就行 |
| codebuddy | 本机登过桌面端就行 |
| qoder / qoderIntl | 设置里建个 PAT 填进 `config.jsonc`，如果不填PAT读取本地信息登录 |

## 调不通看这里

- Key 是否填错
- PAT 是否失效
- 桌面端是否掉登录
- 端口是否被占

---

⚠️ 仅供个人学习研究
