import { startBridge } from "./bridge.js";
import { QoderProvider } from "./client.js";
import { dataPathFor } from "./constants.js";
import type { QoderProviderConfig } from "../../config.js";

export { QoderProvider } from "./client.js";
export { startBridge } from "./bridge.js";
export type { BridgeHandle } from "./bridge.js";
export { readQoderIdeIdentityFor, readQoderIdeIdentity, readQoderCnIdeIdentity } from "./credentials.js";
export { dataPathFor, regionToProviderId, makeDefaultQoderConfig, placeholderFor, REGION_ENV } from "./constants.js";

export async function startQoderProvider(config: QoderProviderConfig, timeoutMs: number): Promise<QoderProvider> {
  const region = config.region ?? "cn";
  const bridge = await startBridge({
    binaryPath: config.bridgePath,
    dataPath: dataPathFor(region),
    pat: config.pat,
    port: config.bridgePort,
    apiKey: config.bridgeApiKey,
    region,
  });
  return new QoderProvider(config, bridge, timeoutMs);
}
