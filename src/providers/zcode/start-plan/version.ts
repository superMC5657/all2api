/**
 * 兼容层：真实实现已折叠进 ./agent.js（Start Plan 内核），本模块只留 re-export。
 * 新代码请直引 agent.js（resolveStartPlanAppVersion / resolveZCodeAppVersion）；
 * 本文件保留以兼容既有 `./version.js` 导入。
 */
export { detectLocalZCodeAppVersion, resolveZCodeAppVersion } from "./agent.js";
