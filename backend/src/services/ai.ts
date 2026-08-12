import type { Response } from "express";

export type ChatMessage = { role: string; content: string };

export type AiConfig = { apiKey: string; apiUrl: string; model: string };

export function aiConfig(): AiConfig | null {
  const apiKey = process.env.AI_API_KEY?.trim();
  const apiUrl = process.env.AI_API_URL?.trim();
  const model = process.env.AI_MODEL?.trim();
  if (!apiKey || !apiUrl || !model) return null;
  // Tolerate a URL given with or without the /v1 suffix, since both are common.
  return { apiKey, apiUrl: apiUrl.replace(/\/+$/, "").replace(/\/v1$/, ""), model };
}

/**
 * Proxies an OpenAI-compatible chat completion straight through to the browser as SSE.
 *
 * The upstream bytes are forwarded unchanged rather than parsed and re-emitted: the client
 * already understands the `data: {...}` delta format, and re-encoding would only add a
 * place for it to break. The proxy exists so the AI key never reaches the browser.
 */
export async function streamCompletion(
  config: AiConfig,
  messages: ChatMessage[],
  res: Response,
  signal: AbortSignal,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Tells nginx not to buffer the stream, which would otherwise hold the whole response
    // until it completed and defeat the point of streaming.
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const upstream = await fetch(`${config.apiUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, messages, stream: true }),
      signal,
    });

    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => "");
      throw new Error(`AI request failed: ${upstream.status} ${detail}`);
    }

    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch (error) {
    // The client aborting is the normal "stop" button, not a failure worth reporting.
    if (!signal.aborted) {
      sendEvent("error", { error: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    res.end();
  }
}
