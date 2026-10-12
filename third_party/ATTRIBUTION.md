# 第三方借鉴来源（ATTRIBUTION）

> 本文件收口本项目所有“借鉴 / 移植 / 原样复制”的外部来源，方便溯源与同步上游。
> 各源码文件头的 `Python 对照 / 原样复制自 / 出处` 注释仍是第一手依据，本文件只做索引。

## 1. zcode（Start Plan JWT 通道）

TS 重写 + 部分原样复制，本地代码在 `src/providers/zcode/`。

| 内容 | 来源 | 本地位置 |
|---|---|---|
| 主通道 TS 重写（请求构建 / body 归一 / 错误分类 / OpenAI↔Anthropic 翻译 / 身份头 / 版本探测）| Python 版 `zcode2api` 的 `app/agent.py`、`app/routes/gateway.py`、`app/openai_compat.py`、`app/identity.py`、`app/constants.py`、`app/body_transform.py`、`app/captcha.py`、`app/settings.py`、`app/fingerprint.py` | `start-plan/agent.ts`、`body-transform.ts`、`constants.ts`、`captcha.ts`、`fingerprint.ts` 文件头均有 `Python 对照 app/*` 注释 |
| 验证码求解器，原样复制，未改逻辑 | `dengyie/zcode2api` @ `ba79b05`（完整 `ba79b0519e5d492edb157ad22dc0cfb5dc7a350e`），`captcha_node/solver.js`（61KB happy-dom 版）| `start-plan/captcha-node/solver.js:1-3`、`captcha-node/package.json:5` |
| 求解器设计原型（设计移植，非代码拷贝）| `TriDefender/zcode-api` 的 `src/proxy/captcha-happy.ts`（即注释里的 `zapi captcha-happy`）| `solver.js:11` 注释 |
| 原版上游（非直接复制源，但应知晓）| `liu5269/zcode2api`（现 `solver.js` 已是 3.6KB 简化版，与本仓 happy-dom 版不同）| — |
| 下游整合参考（README 自述基于上述两家，不用归属，仅备查）| `hechushitaoyuan/zca` | — |
| 官方客户端 bundle，原样复制 | ZCode 官方桌面端 bundle：`zcode_system.json`（3 块官方 system）、`zcode.cjs:createZCodeCredentialCipher`（`enc:v1:` + AES-256-GCM，见 `cipher.ts`）| `start-plan/zcode_system.json`、`body-transform.ts:22`、`cipher.ts:4` |
| 防封思路合入（本仓适配，非账号池代码照搬）| `dengyie/zcode2api` 2.6.5～2.6.8（commit `bda8ea1` / `ec75d19` / `1b3b271` / `1165108`）：3012 strikes＋冷却＋衰减、指纹轮换、重试收敛 | `start-plan/constants.ts`（RISK_* 阈值＋`ZCODE_RISK_*` 覆盖、Referer 去尾斜杠、版本 3.14.4、429 缺省 30s）、`start-plan/risk.ts`（新建，按 JWT sub 内存计数）、`start-plan/agent.ts`（3012 分支＋成功清零）、`start-plan/fingerprint.ts`（`rotateProfileForJwt`）、`start-plan/captcha.ts`（POOL_MIN 3→2）、`src/config.ts`（`riskAutoRotate`）|
| 引入提交 | `7f781fd zcode: Start Plan JWT 通道移植（TS 重写）` | `git log -- src/providers/zcode/` |

> 豁免：`solver.js` 内 referer 尾斜杠与 `constants.ts` 不一致系有意保留（原样复制不改逻辑），验证码求解器浏览器仿真头以上游原样为准。

GitHub 链接：

- 实际复制源：<https://github.com/dengyie/zcode2api>
- 复制时 commit：<https://github.com/dengyie/zcode2api/commit/ba79b0519e5d492edb157ad22dc0cfb5dc7a350e>
- 复制的文件：<https://github.com/dengyie/zcode2api/blob/ba79b0519e5d492edb157ad22dc0cfb5dc7a350e/captcha_node/solver.js>
- 设计原型：<https://github.com/TriDefender/zcode-api>
- 原版上游：<https://github.com/liu5269/zcode2api>

## 2. qoder / qoderIntl（sidecar 模式，非自研协议）

详见 `third_party/qoder2api.VENDOR.md`，这里只留链接索引。

- 原始上游：<https://github.com/EchoPing07/Qoder-2API-Go>
- Fork（含国际版改动，本仓 submodule 指向）：<https://github.com/superMC5657/Qoder-2API-Go.git>，`main` 分支，commit `4066caa3cae54cec63278b949d16f568659a3d68`（基于 `440b11e` 的 +93/-3）
- Python 祖先（Go 重写时参考）：<https://github.com/fengyinxia/qoder2api>
- submodule：`third_party/qoder2api`（见 `.gitmodules`），运行时由 `src/providers/qoder/bridge.ts` 现场编译为 `bridges/qoder2api`

## 3. trae-cn（国内版，直连 AgentHost）

出处见 `src/providers/trae-cn/client.ts:28-29` 注释，仓内未留 URL，按原文字记录：

- `caigee-cmd/cli2api` 的 `internal/providers/trae/`（`credential.go` + `headers.go`）
- `smart-open/TraeWorkAssistant`
- `Sliverkiss/traework2api`

> TODO：补上述三家的 GitHub URL（写本文件时仓内只有名字没有链）。

## 4. 自研、无外部上游（明确无借鉴链接）

- `codebuddy` / `codebuddyIntl`：腾讯 CodeBuddy/WorkBuddy 网关自研对接（`copilot.tencent.com`、`vscdb os_crypt v11` 自研读取），无外部 GitHub URL。
- `trae` Intl：`https://api.trae.ai` AES-256-GCM 预留骨架，无移植。
- 框架/依赖：`hono`、`happy-dom`（solver 浏览器仿真用）等见 `package.json`，属正常 npm 依赖，无需归属。

## 5. 维护约定

- 新增“复制 / 移植 / 对照”代码时，同时更新本文件 + 对应源码文件头注释（URL + commit）。
- `solver.js` 这类原样复制文件：只改头注释，不改逻辑；改逻辑先落 fork 再同步。
- submodule（qoder2api）升级：先推 fork，再更新主仓 gitlink，见 `third_party/qoder2api.VENDOR.md` 的同步节。
