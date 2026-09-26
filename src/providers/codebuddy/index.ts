export { CodeBuddyProvider } from "./client.js";
export {
  AtRestKeyProvider,
  CodeBuddyCredentials,
  buildAuthenticatedContextAad,
  buildKeyHelperScript,
  isOpenEnvelope,
  openEnvelope,
  parseEnvelope,
  sealField,
  AT_REST_KEY_BINDINGS,
} from "./credentials.js";
export type { WorkBuddyEnvelope, AtRestKey, ResolvedAtRestKey } from "./credentials.js";
export { assembleAuth, electronPinnedPath, listElectronBinaries } from "./credentials.js";
export {
  decryptVscdbBlob,
  defaultVscdbPath,
  mapVscdbAuth,
  parseVscdbValue,
  readKeyringSecret,
  readVscdbAuth,
  readVscdbValue,
  resolveVscdbPath,
  __setVscdbExecForTests,
  DEFAULT_VSCDB_APP,
  DEFAULT_VSCDB_DIR,
  DEFAULT_VSCDB_KEY,
  KEYRING_LINK_NAMES,
  KEYRING_LINK_TIMEOUT_MS,
  KEYRING_TOTAL_TIMEOUT_MS,
  VSCDB_OS_CRYPT_SCHEMA,
} from "./vscdb.js";
export type { VscdbSourceOptions, VscdbExecFn } from "./vscdb.js";
