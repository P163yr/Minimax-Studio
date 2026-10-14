import { normaliseEndpoint, RUNPOD_ASYNC_MAX_BYTES } from "../../../lib/runpod";

const ENVELOPE_MAX_BYTES = RUNPOD_ASYNC_MAX_BYTES + 8_192;
const RESPONSE_MAX_BYTES = 64_000_000;
const OPERATIONS = new Set(["health", "run", "status", "cancel", "retry"]);
const encoder = new TextEncoder();

const safeHeaders = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
};

function fail(message: string, status: number, uncertainSubmission = false) {
  return Response.json({ error: message, ...(uncertainSubmission ? { uncertainSubmission: true } : {}) }, { status, headers: safeHeaders });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function readLimitedJson(request: Request): Promise<unknown> {
  const advertisedSize = Number(request.headers.get("content-length"));
  if (advertisedSize > ENVELOPE_MAX_BYTES) throw new RangeError("Payload is too large.");
  if (!request.body) throw new SyntaxError("Empty request.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ENVELOPE_MAX_BYTES) {
        await reader.cancel();
        throw new RangeError("Payload is too large.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } finally {
    reader.releaseLock();
  }
}

/** Browser-only, same-origin proxy with an exact RunPod upstream allowlist. */
export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return fail("Use this studio's connection panel to send RunPod requests.", 403);
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return fail("Requests must use application/json.", 415);
  }

  let parsed: unknown;
  try {
    parsed = await readLimitedJson(request);
  } catch (error) {
    return fail(error instanceof RangeError ? "The request exceeds RunPod's 10 MB async payload limit." : "Enter a valid JSON request.", error instanceof RangeError ? 413 : 400);
  }
  if (!isRecord(parsed)) return fail("Invalid request object.", 400);
  const { endpoint, apiKey, operation, jobId, payload } = parsed;
  if (typeof endpoint !== "string" || typeof apiKey !== "string" || typeof operation !== "string" || !OPERATIONS.has(operation)) {
    return fail("Endpoint, API key, and a supported operation are required.", 400);
  }
  let base: string;
  try { base = normaliseEndpoint(endpoint); } catch { return fail("Only RunPod Serverless endpoint IDs and api.runpod.ai/v2 URLs are supported.", 400); }
  const key = apiKey.trim().replace(/^Bearer\s+/i, "");
  if (!key || key.length > 512 || /[^\x21-\x7E]/.test(key)) return fail("Enter a valid RunPod API key.", 400);

  const isJobOperation = operation === "status" || operation === "cancel" || operation === "retry";
  if (isJobOperation && (typeof jobId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(jobId))) {
    return fail("A valid job ID is required for this operation.", 400);
  }
  let body: string | undefined;
  if (operation === "run") {
    if (!isRecord(payload) || !isRecord(payload.input) || !isRecord(payload.input.workflow) || Object.keys(payload.input.workflow).length === 0) {
      return fail("The payload must contain input.workflow in ComfyUI API format.", 400);
    }
    body = JSON.stringify(payload);
    if (encoder.encode(body).byteLength > RUNPOD_ASYNC_MAX_BYTES) return fail("The workflow exceeds RunPod's 10 MB async payload limit. Reduce input image size or use remote media URLs.", 413);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 55_000);
  const stop = () => { clearTimeout(timeout); controller.abort(); };

  try {
    // Redirects are rejected to prevent forwarding the API key to another host.
    // Submit exactly once: retrying a lost /run response could create another paid job.
    const upstream = await fetch(`${base}/${operation}${isJobOperation ? `/${jobId}` : ""}`, {
      method: operation === "health" || operation === "status" ? "GET" : "POST",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body,
      redirect: "manual",
      cache: "no-store",
      signal: controller.signal,
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      stop();
      return fail("RunPod returned an unexpected redirect. Verify the endpoint ID.", 502, operation === "run");
    }
    if (Number(upstream.headers.get("content-length")) > RESPONSE_MAX_BYTES) {
      stop();
      return fail("The video result is too large to return inline. Configure S3 output on your RunPod worker.", 502);
    }
    const headers = new Headers({ ...safeHeaders, "Content-Type": "application/json" });
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers.set("Retry-After", retryAfter);
    if (!upstream.body || upstream.status === 204) {
      stop();
      return new Response(null, { status: upstream.status, headers });
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      stop();
      const status = upstream.ok ? 502 : upstream.status;
      const response = fail(upstream.status === 429 ? "RunPod is rate limiting requests. Wait before refreshing the status." : `RunPod returned an unexpected response (${upstream.status}).`, status, operation === "run" && upstream.status >= 500);
      if (retryAfter) response.headers.set("Retry-After", retryAfter);
      return response;
    }
    const reader = upstream.body.getReader();
    let received = 0;
    // Stream JSON so large base64 video outputs do not fill the Worker isolate.
    const limited = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const { done, value } = await reader.read();
          if (done) { clearTimeout(timeout); reader.releaseLock(); stream.close(); return; }
          received += value.byteLength;
          if (received > RESPONSE_MAX_BYTES) {
            await reader.cancel();
            stop();
            stream.error(new Error("RunPod output exceeds the inline limit; configure S3 output."));
            return;
          }
          stream.enqueue(value);
        } catch {
          stop();
          stream.error(new Error("RunPod's response stream ended unexpectedly."));
        }
      },
      async cancel() { stop(); await reader.cancel(); },
    });
    return new Response(limited, { status: upstream.status, headers });
  } catch {
    stop();
    return fail(
      operation === "run"
        ? "The submission response was lost. A job may already be running. Check RunPod Requests before submitting again."
        : "RunPod did not respond in time. Refresh the job status to reconnect.",
      504,
      operation === "run",
    );
  }
}

