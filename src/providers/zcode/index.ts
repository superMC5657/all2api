// ZCode 对外出口：仅暴露 ProviderAdapter（thin adapter），start-plan 内核细节
// （身份头/版本探测/验证码/指纹）一律经由 start-plan/agent.js，不再由此转出。
export { ZCodeProvider } from "./client.js";
