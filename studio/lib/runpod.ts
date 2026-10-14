/** RunPod queue API helpers. Credentials stay in the current request only. */
export const RUNPOD_ASYNC_MAX_BYTES = 10_000_000;
export type RunpodOperation = "health" | "run" | "status" | "cancel" | "retry";

export interface RunpodRequest {
  endpoint: string;
  apiKey: string;
  operation: RunpodOperation;
  jobId?: string;
  payload?: Record<string, unknown>;
}

export interface RunpodJob {
  id?: string;
  status?: string;
  output?: unknown;
  error?: unknown;
  delayTime?: number;
  executionTime?: number;
  [key: string]: unknown;
}

export interface RunpodHealth {
  workers?: Record<string, number>;
  jobs?: Record<string, number>;
  [key: string]: unknown;
}

export interface RunpodOutput {
  url: string;
  filename: string;
  kind: "video" | "audio" | "image" | "file";
  mime: string;
  isObjectUrl: boolean;
}

/** Returns a canonical endpoint base, never a caller-controlled upstream host. */
export function normaliseEndpoint(value: string): string {
  const endpoint = value.trim();
  if (/^[A-Za-z0-9_-]{1,128}$/.test(endpoint)) {
    return `https://api.runpod.ai/v2/${endpoint}`;
  }
  // Match the original string before URL parsing can normalize dot segments,
  // escaped slashes, ports, usernames, or backslashes into a different path.
  const match = /^https:\/\/api\.runpod\.ai\/v2\/([A-Za-z0-9_-]{1,128})(?:\/(?:run|runsync|health|status|cancel|retry)(?:\/[A-Za-z0-9_-]{1,128})?)?\/?$/.exec(endpoint);
  if (!match) {
    throw new Error("Enter a RunPod endpoint ID or an https://api.runpod.ai/v2/ endpoint URL.");
  }
  return `https://api.runpod.ai/v2/${match[1]}`;
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(300_000, delay)) : 0;
}

export class RunpodError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;
  readonly uncertainSubmission: boolean;

  constructor(message: string, status = 0, retryAfterMs = 0, uncertainSubmission = false) {
    super(message);
    this.name = "RunpodError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.uncertainSubmission = uncertainSubmission;
  }
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 1500);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string") return record.message.slice(0, 1500);
    if (typeof record.error === "string") return record.error.slice(0, 1500);
  }
  return undefined;
}

/** One HTTP call per operation; a lost submission is never automatically repeated. */
export async function callRunpod<T = RunpodJob>(
  request: RunpodRequest,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<T> {
  const body = { ...request, endpoint: normaliseEndpoint(request.endpoint) };
  if (!request.apiKey.trim()) throw new RunpodError("Enter your RunPod API key.", 400);
  if (request.operation === "run" && request.payload) {
    const size = new TextEncoder().encode(JSON.stringify(request.payload)).byteLength;
    if (size > RUNPOD_ASYNC_MAX_BYTES) {
      throw new RunpodError("This workflow exceeds RunPod's 10 MB request limit. Use smaller input images or remote media URLs.", 413);
    }
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 65_000);
  try {
    const response = await (options.fetch ?? fetch)("/api/runpod", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
      credentials: "same-origin",
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new RunpodError(
        "RunPod returned an unreadable response. For large videos, configure S3 output on your worker.",
        response.status,
        retryAfterMilliseconds(response.headers.get("retry-after")),
        request.operation === "run",
      );
    }
    if (!response.ok) {
      const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
      throw new RunpodError(
        errorMessage(record.error) ?? errorMessage(record.message) ?? `RunPod request failed (${response.status}).`,
        response.status,
        retryAfterMilliseconds(response.headers.get("retry-after")) || (response.status === 429 ? 10_000 : 0),
        record.uncertainSubmission === true || (request.operation === "run" && response.status >= 500),
      );
    }
    return data as T;
  } catch (error) {
    if (error instanceof RunpodError) throw error;
    throw new RunpodError(
      request.operation === "run"
        ? "The submission response was lost. A job may already be running. Check RunPod Requests before submitting again."
        : controller.signal.aborted
          ? "The request timed out or was stopped. You can refresh this job's status."
          : "Could not reach RunPod. Check your connection and try refreshing the job status.",
      0,
      0,
      request.operation === "run",
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

const extensionMimes: Record<string, string> = {
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  m4v: "video/mp4", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", avif: "image/avif",
  wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac",
};

function mimeFromFilename(filename: string): string | undefined {
  return extensionMimes[filename.split("?")[0].split(".").pop()?.toLowerCase() ?? ""];
}

function sniffMime(bytes: Uint8Array): string | undefined {
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (ascii(4, 4) === "ftyp") return "video/mp4";
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  if (bytes[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  return undefined;
}

function kindFromMime(mime: string): RunpodOutput["kind"] {
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  return "file";
}

function publicMediaUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) return url.href;
  } catch { /* Base64 strings and local worker filenames are not media URLs. */ }
  return undefined;
}

/** Handles current worker files/images, legacy message, and common video URL outputs. */
export function parseOutputs(output: unknown): RunpodOutput[] {
  const results: RunpodOutput[] = [];
  const seen = new Set<string>();
  const mediaKeys = ["output", "outputs", "files", "images", "videos", "audios", "video", "audio", "image", "video_url", "audio_url", "image_url", "url", "message"];

  function add(value: string, filename: string, mimeHint: string, base64: boolean, context: string) {
    if (!value || results.length >= 64 || seen.has(value)) return;
    const dataMatch = /^data:([^;,]*);base64,([\s\S]+)$/i.exec(value);
    const url = !base64 && !dataMatch ? publicMediaUrl(value) : undefined;
    if (url) {
      let name = filename;
      if (!name) {
        try { name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? ""); } catch { /* Use a safe fallback name. */ }
      }
      const mime = mimeHint || mimeFromFilename(name) || (context.includes("video") ? "video/mp4" : context.includes("audio") ? "audio/wav" : context.includes("image") ? "image/png" : "application/octet-stream");
      results.push({ url, filename: name || `output-${results.length + 1}`, mime, kind: kindFromMime(mime), isObjectUrl: false });
      seen.add(value);
      return;
    }
    if (!base64 && !dataMatch) {
      // Legacy worker-comfyui output.message can be a raw base64 string.
      if (context !== "message" && context !== "image") return;
    }
    const encoded = (dataMatch?.[2] ?? value).replace(/\s/g, "");
    if (!encoded || encoded.length > 64_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return;
    try {
      const binary = atob(encoded);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
      const dataMime = dataMatch?.[1];
      const mime = mimeHint || (dataMime && /^(video|audio|image)\/[a-zA-Z0-9.+-]+$/.test(dataMime) ? dataMime : undefined) || mimeFromFilename(filename) || sniffMime(bytes) || "application/octet-stream";
      const kind = kindFromMime(mime);
      // Do not turn arbitrary worker messages into downloadable text blobs.
      if (!base64 && kind === "file") return;
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
      const extension = Object.keys(extensionMimes).find((key) => extensionMimes[key] === mime);
      results.push({ url: objectUrl, filename: filename || `output-${results.length + 1}${extension ? `.${extension}` : ""}`, mime, kind, isObjectUrl: true });
      seen.add(value);
    } catch { /* An invalid output item should not hide other usable outputs. */ }
  }

  function visit(value: unknown, context = "", depth = 0): void {
    if (depth > 8 || results.length >= 64) return;
    if (typeof value === "string") {
      if (value.trim().startsWith("{") || value.trim().startsWith("[")) {
        try { visit(JSON.parse(value), context, depth + 1); return; } catch { /* Try normal media parsing. */ }
      }
      add(value, "", "", false, context);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, context, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const filename = typeof record.filename === "string" ? record.filename : typeof record.name === "string" ? record.name : "";
    const mimeHint = [record.mime, record.mime_type, record.content_type].find((item): item is string => typeof item === "string" && /^(video|audio|image)\/[a-zA-Z0-9.+-]+$/.test(item)) ?? "";
    const mediaContext = record.type === "video" || record.type === "audio" || record.type === "image" ? record.type : context;
    if (typeof record.data === "string" && (record.type === "base64" || record.type === "s3_url" || record.type === "url" || record.data.startsWith("data:"))) {
      add(record.data, filename, mimeHint, record.type === "base64", mediaContext);
    }
    for (const key of mediaKeys) {
      if (!(key in record)) continue;
      const next = record[key];
      const nextContext = /video|audio|image/.test(key) || key === "message" ? key : mediaContext || key;
      if (typeof next === "string" && !(key === "output" && /^[\s]*[{[]/.test(next))) add(next, filename, mimeHint, false, nextContext);
      else visit(next, nextContext, depth + 1);
    }
    // ComfyUI history commonly groups outputs under numeric node IDs.
    if (context === "outputs") {
      for (const [key, item] of Object.entries(record)) if (/^[A-Za-z0-9_-]+$/.test(key) && !mediaKeys.includes(key)) visit(item, context, depth + 1);
    }
  }

  visit(output);
  return results;
}

export function revokeOutputs(outputs: RunpodOutput[]): void {
  for (const output of outputs) if (output.isObjectUrl) URL.revokeObjectURL(output.url);
}

