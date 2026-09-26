export interface UpstreamResult {
  status: number;
  contentType: string;
  body: ReadableStream<Uint8Array> | string;
}

export interface ProviderAdapter {
  id: string;
  models(): Promise<string[]>;
  /** 转发 Anthropic 格式的 /v1/messages 请求（body 中已是路由后的模型 ID）。 */
  anthropic(model: string, rawBody: string): Promise<UpstreamResult>;
  /** 转发 OpenAI 格式的 /v1/chat/completions 请求。 */
  openai(model: string, rawBody: string): Promise<UpstreamResult>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function rewriteModel(rawBody: string, model: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { model?: string };
    parsed.model = model;
    return JSON.stringify(parsed);
  } catch {
    return rawBody;
  }
}

export function extractStreamFlag(rawBody: string): boolean {
  try {
    return (JSON.parse(rawBody) as { stream?: boolean }).stream === true;
  } catch {
    return false;
  }
}

export async function toUpstreamResult(res: Response): Promise<UpstreamResult> {
  const contentType = res.headers.get("content-type") ?? "application/json";
  if (contentType.includes("text/event-stream") || res.body === null) {
    return { status: res.status, contentType, body: res.body as ReadableStream<Uint8Array> };
  }
  return { status: res.status, contentType, body: await res.text() };
}
