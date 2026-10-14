import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import {
  callRunpod, normaliseEndpoint, parseOutputs, revokeOutputs,
  retryAfterMilliseconds, RunpodError, RUNPOD_ASYNC_MAX_BYTES,
} from "../lib/runpod.ts";

// Execute the actual framework route in Node, resolving its bundler-style import.
const helperUrl = new URL("../lib/runpod.ts", import.meta.url).href;
const routeSource = (await readFile(new URL("../app/api/runpod/route.ts", import.meta.url), "utf8"))
  .replace('"../../../lib/runpod"', JSON.stringify(helperUrl));
const { POST } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(routeSource)).toString("base64")}`);
const originalFetch = globalThis.fetch;
const workflow = { input: { workflow: { "1": { class_type: "SaveVideo", inputs: {} } } } };

function browserRequest(body, headers = {}, url = "https://studio.example/api/runpod") {
  return new Request(url, {
    method: "POST",
    headers: { Origin: "https://studio.example", "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function settings(extra = {}) {
  return { endpoint: "my-endpoint_123", apiKey: "session-only-test-key", operation: "run", payload: workflow, ...extra };
}
async function withFetch(mock, task) {
  globalThis.fetch = mock;
  try { await task(); } finally { globalThis.fetch = originalFetch; }
}

test("endpoint input normalizes an ID or official endpoint URL", () => {
  assert.equal(normaliseEndpoint(" endpoint-id_1 "), "https://api.runpod.ai/v2/endpoint-id_1");
  assert.equal(normaliseEndpoint("https://api.runpod.ai/v2/endpoint-id_1/run"), "https://api.runpod.ai/v2/endpoint-id_1");
  assert.equal(normaliseEndpoint("https://api.runpod.ai/v2/endpoint-id_1/"), "https://api.runpod.ai/v2/endpoint-id_1");
});

test("endpoint allowlist rejects SSRF, redirects, path traversal, and URL credentials", () => {
  for (const endpoint of [
    "http://api.runpod.ai/v2/abc", "https://api.runpod.ai.evil.example/v2/abc",
    "https://localhost/v2/abc", "https://127.0.0.1/v2/abc", "https://api.runpod.ai:444/v2/abc",
    "https://api.runpod.ai@evil.example/v2/abc", "https://user:secret@api.runpod.ai/v2/abc",
    "https://api.runpod.ai/v2/abc/../../evil", "https://api.runpod.ai/v2/%2e%2e/abc",
    "https://api.runpod.ai/v2/abc?webhook=https://evil.example", "https://api.runpod.ai/v2/abc#fragment",
    "https://api.runpod.ai\\evil.example/v2/abc", "https://api.runpod.ai/v2/abc/purge-queue",
  ]) assert.throws(() => normaliseEndpoint(endpoint), undefined, endpoint);
});

test("proxy rejects foreign origin, missing origin, non-JSON, and bad job IDs before fetch", async () => {
  await withFetch(() => { throw new Error("Fetch must not happen"); }, async () => {
    assert.equal((await POST(browserRequest(settings(), { Origin: "https://evil.example" }))).status, 403);
    assert.equal((await POST(browserRequest(settings(), { Origin: "null" }))).status, 403);
    const missing = browserRequest(settings());
    missing.headers.delete("origin");
    assert.equal((await POST(missing)).status, 403);
    assert.equal((await POST(browserRequest(settings(), { "Sec-Fetch-Site": "cross-site" }))).status, 403);
    assert.equal((await POST(browserRequest(settings(), { "Content-Type": "text/plain" }))).status, 415);
    assert.equal((await POST(browserRequest(settings({ operation: "status", jobId: "../../health" })))).status, 400);
    assert.equal((await POST(browserRequest(settings({ endpoint: "https://evil.example/endpoint" })))).status, 400);
    assert.equal((await POST(browserRequest(settings({ apiKey: "key\r\nAuthorization: injected" })))).status, 400);
    assert.equal((await POST(browserRequest(settings({ operation: "purge-queue" })))).status, 400);
  });
});

test("async submit sends the exact worker input once and carries only the caller key", async () => {
  const calls = [];
  await withFetch(async (url, options) => {
    calls.push({ url, options });
    return Response.json({ id: "job-123", status: "IN_QUEUE" });
  }, async () => {
    const response = await POST(browserRequest(settings()));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: "job-123", status: "IN_QUEUE" });
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.runpod.ai/v2/my-endpoint_123/run");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer session-only-test-key");
  assert.equal(calls[0].options.redirect, "manual");
  assert.deepEqual(JSON.parse(calls[0].options.body), workflow);
  assert.ok(!calls[0].options.body.includes("session-only-test-key"));
});

test("network failure is marked uncertain and never repeats a paid submission", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; throw new TypeError("Disconnected"); }, async () => {
    const response = await POST(browserRequest(settings()));
    assert.equal(response.status, 504);
    const result = await response.json();
    assert.equal(result.uncertainSubmission, true);
    assert.match(result.error, /job may already be running/);
    assert.ok(!JSON.stringify(result).includes("session-only-test-key"));
  });
  assert.equal(calls, 1);
});

test("redirect is rejected without forwarding credentials to its target", async () => {
  let calls = 0;
  await withFetch(async () => { calls++; return new Response(null, { status: 307, headers: { Location: "https://evil.example" } }); }, async () => {
    assert.equal((await POST(browserRequest(settings()))).status, 502);
  });
  assert.equal(calls, 1);
});

test("status and health use GET; cancel/retry use POST without a workflow body", async () => {
  const calls = [];
  await withFetch(async (url, options) => { calls.push({ url, options }); return Response.json({ status: "IN_QUEUE" }); }, async () => {
    for (const operation of ["health", "status", "cancel", "retry"]) {
      const response = await POST(browserRequest(settings({ operation, jobId: "job-1" })));
      await response.json();
    }
  });
  assert.deepEqual(calls.map(({ options }) => options.method), ["GET", "GET", "POST", "POST"]);
  assert.deepEqual(calls.map(({ options }) => options.body), [undefined, undefined, undefined, undefined]);
  assert.deepEqual(calls.map(({ url }) => url.split("/v2/my-endpoint_123/")[1]), ["health", "status/job-1", "cancel/job-1", "retry/job-1"]);
});

test("proxy enforces the upstream 10 MB limit in UTF-8 bytes before any submit", async () => {
  const hugePayload = { input: { workflow: workflow.input.workflow, prompt: "💚".repeat(2_500_000) } };
  assert.ok(new TextEncoder().encode(JSON.stringify(hugePayload)).byteLength > RUNPOD_ASYNC_MAX_BYTES);
  await withFetch(() => { throw new Error("Oversize input must not be sent"); }, async () => {
    assert.equal((await POST(browserRequest(settings({ payload: hugePayload })))).status, 413);
    assert.equal((await POST(browserRequest(settings({ payload: { input: {} } })))).status, 400);
  });
});

test("proxy preserves upstream authentication and rate-limit status/Retry-After", async () => {
  await withFetch(async () => Response.json({ error: "Too many requests" }, { status: 429, headers: { "Retry-After": "12" } }), async () => {
    const response = await POST(browserRequest(settings({ operation: "status", jobId: "job-1" })));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "12");
    assert.deepEqual(await response.json(), { error: "Too many requests" });
  });
  await withFetch(async () => Response.json({ error: "Unauthorized" }, { status: 401 }), async () => {
    const response = await POST(browserRequest(settings()));
    assert.equal(response.status, 401);
    await response.json();
  });
});

test("proxy limits a large announced response and closes its timeout", async () => {
  await withFetch(async () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "64000001" } }), async () => {
    const response = await POST(browserRequest(settings({ operation: "status", jobId: "job-1" })));
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /S3 output/);
  });
});

test("proxy also stops chunked responses that exceed the inline size limit", async () => {
  let canceled = false;
  const chunk = new Uint8Array(1_000_000);
  let sent = 0;
  await withFetch(async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(chunk); if (++sent === 66) controller.close(); },
    cancel() { canceled = true; },
  }), { headers: { "Content-Type": "application/json" } }), async () => {
    const response = await POST(browserRequest(settings({ operation: "status", jobId: "job-1" })));
    await assert.rejects(response.arrayBuffer(), /inline limit/);
  });
  assert.equal(canceled, true);
});

test("client propagates read backoff and does not auto-repeat an uncertain submit", async () => {
  let polls = 0;
  await assert.rejects(
    callRunpod(settings({ operation: "status", jobId: "job-1" }), { fetch: async () => { polls++; return Response.json({ error: "Rate limited" }, { status: 429, headers: { "Retry-After": "7" } }); } }),
    (error) => error instanceof RunpodError && error.status === 429 && error.retryAfterMs === 7000 && !error.uncertainSubmission,
  );
  assert.equal(polls, 1);
  let submissions = 0;
  await assert.rejects(
    callRunpod(settings(), { fetch: async () => { submissions++; throw new TypeError("Lost response"); } }),
    (error) => error instanceof RunpodError && error.uncertainSubmission,
  );
  assert.equal(submissions, 1);
  assert.equal(retryAfterMilliseconds("10", 0), 10_000);
  assert.equal(retryAfterMilliseconds("Thu, 01 Jan 1970 00:00:20 GMT", 0), 20_000);
  assert.equal(retryAfterMilliseconds("nonsense", 0), 0);
});

test("output mapper recognizes worker files/images, audio, video URLs, and duplicate media", () => {
  const outputs = parseOutputs({ output: {
    files: [{ filename: "scene.mp4", type: "s3_url", data: "https://bucket.example/scene.mp4?token=123" }],
    images: [{ filename: "still.png", type: "s3_url", data: "https://bucket.example/still.png" }],
    audio_url: "https://bucket.example/sound.wav",
    video_url: "https://bucket.example/scene.mp4?token=123",
  } });
  assert.equal(outputs.length, 3);
  assert.deepEqual(outputs.map(({ kind }) => kind), ["video", "image", "audio"]);
  assert.ok(outputs.every(({ isObjectUrl }) => !isObjectUrl));
  assert.equal(outputs[0].filename, "scene.mp4");
});

test("nested video records and JSON-string worker output retain playable media type", () => {
  const outputs = parseOutputs({ output: JSON.stringify({ video: { url: "https://bucket.example/signed-download?key=abc" } }) });
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].kind, "video");
  assert.equal(outputs[0].mime, "video/mp4");
  assert.equal(parseOutputs({ type: "audio", url: "https://bucket.example/download" })[0].kind, "audio");
});

test("base64 media becomes a correctly typed playable Blob and can be cleaned up", async () => {
  const bytes = Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  const outputs = parseOutputs({ files: [{ type: "base64", data: bytes.toString("base64") }] });
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].kind, "video");
  assert.equal(outputs[0].mime, "video/mp4");
  assert.match(outputs[0].url, /^blob:/);
  const response = await originalFetch(outputs[0].url);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  revokeOutputs(outputs);
  await assert.rejects(originalFetch(outputs[0].url));
});

test("legacy base64/data URIs map, invalid outputs and unsafe URL schemes are ignored", () => {
  const png = Buffer.from([0x89, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  const outputs = parseOutputs({ images: [
    { filename: "frame.png", type: "base64", data: `data:image/png;base64,${png}` },
    { filename: "bad.mp4", type: "base64", data: "Invalid@base64!" },
    { filename: "bad.mp4", type: "s3_url", data: "javascript:alert(1)" },
  ], message: png, video_url: "file:///C:/private.mp4" });
  assert.equal(outputs.length, 2);
  assert.ok(outputs.every(({ kind }) => kind === "image"));
  revokeOutputs(outputs);
  assert.deepEqual(parseOutputs({ files: [{ filename: "scene.mp4", subfolder: "video", type: "output" }], errors: ["No media"] }), []);
});

