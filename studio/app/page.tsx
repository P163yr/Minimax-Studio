"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ChangeEvent } from "react";
import { ArrowDownToLine, ArrowRight, AudioLines, BookOpen, Camera, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Code2, Copy, Film, Flag, Grid2X2, Image as ImageIcon, Layers3, LoaderCircle, Maximize2, Mic, Move, Music2, Palette, Play, Plus, RefreshCw, ScanLine, Scissors, Settings2, ShieldCheck, Shuffle, Sparkles, Sun, Upload, Users, WandSparkles, X, Zap, type LucideIcon } from "lucide-react";
import { FEATURES, DEFAULT_MODELS, PDMD_LORA, PDMD_PROFILE, buildRequest, dimensionsForRatio, framesForDuration, recommendedSteps, type FeatureId, type MediaFile, type MediaSlot } from "@/lib/workflows";
import { BASE_MODELS, VIDEO_VAES, LORAS, CREATIVE_LORAS, CONTROLNET, UPSCALER } from "@/lib/inventory";
import { callRunpod, normaliseEndpoint, parseOutputs, revokeOutputs, RunpodError, type RunpodJob, type RunpodHealth, type RunpodOutput } from "@/lib/runpod";

type Modal = "connection" | "models" | "request" | "guide" | null;
type ModelSettings = typeof DEFAULT_MODELS;
type Asset = MediaFile & { id: string };
type HistoryItem = { id: string; endpoint: string; title: string; prompt: string; createdAt: number; seed?: number; duration?: number; aspectRatio?: string; status: string; job?: RunpodJob };
type JsonRecord = Record<string, unknown>;
const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"]);
const ICONS: Record<string, LucideIcon> = { sparkles: Sparkles, image: ImageIcon, flag: Flag, frames: Film, layers: Layers3, scissors: Scissors, move: Move, users: Users, palette: Palette, mic: Mic, music: Music2, film: Film, "arrow-right": ArrowRight, wand: WandSparkles, grid: Grid2X2, camera: Camera, scan: ScanLine, sun: Sun, maximize: Maximize2 };
const PROMPTS: Partial<Record<FeatureId, string>> = {
  "text-to-video": "An astronaut wanders through a lavender landscape, soft rolling hills and a glowing moon on the horizon. A slow cinematic dolly forward. Gentle wind and distant, ethereal music.",
  "image-to-video": "Bring this scene to life with natural, subtle movement. A slow cinematic camera push-in, soft atmospheric light and ambient sound.",
  "last-frame": "Create a cinematic scene that gradually arrives at the composition of the final image. Smooth, natural motion and atmospheric sound.",
  "first-last-frame": "Create a seamless, cinematic transition from the first image to the last. Keep the subject consistent and the movement natural.",
  "reference-to-video": "Create a cinematic scene using the character in <Picture 1>. Preserve their identity, with expressive natural motion and atmospheric sound.",
  "video-edit": "Edit <Video 1> into a cinematic scene at golden hour. Preserve the subject's action and camera movement while changing the lighting and environment.",
  "motion-transfer": "The subject from <Picture 1> performs the movement from <Video 1>. Preserve the new subject's identity and follow the reference performance and camera.",
  "character-swap": "Replace the main character in <Video 1> with the character in <Picture 1>. Preserve the scene, action and camera direction.",
  "style-transfer": "Reimagine <Video 1> in the visual style of <Picture 1>. Preserve the action and composition, with consistent textures and colors.",
  "voice-reference": "A character speaks naturally using the voice qualities and tone of <Audio 1>. Cinematic close-up, expressive performance and soft room ambience.",
  "audio-to-video": "A natural, expressive performance following the supplied soundtrack. Keep the performer consistent, with a cinematic close-up and subtle camera motion.",
  keyframes: "Connect the guide images into one coherent visual story with smooth movement and a consistent subject, lighting and atmosphere.",
  "extend-video": "Continue the existing scene naturally. Preserve the subject, camera movement, lighting and sound, and gently advance the action.",
  "photo-edit": "Change the scene to soft golden-hour lighting. Preserve the subject's identity, composition and fine detail.",
  "character-sheet": "Create a consistent character sheet with six clear views. Preserve the character's identity, clothing, proportions and material detail.",
  "scene-coverage": "Explore this frozen scene from cinematic camera angles. Preserve the characters, objects, lighting and spatial arrangement.",
  "camera-motion": "A cinematic slow orbit around the subject, transitioning into a gentle dolly-in. Smooth controlled camera movement, natural light and atmospheric sound.",
  "union-controlnet": "A cinematic scene following the supplied control sequence. Natural movement, consistent subjects, rich detail and atmospheric sound.",
  relight: "Relight the subject with a soft directional key light and natural shadows. Preserve identity, composition, textures and background.",
  "latent-upscale": "A cinematic landscape with intricate textures and natural movement. Soft atmospheric light, a gentle dolly forward and ambient sound.",
};

function record(value: unknown): value is JsonRecord { return !!value && typeof value === "object" && !Array.isArray(value); }
function message(error: unknown): string { return error instanceof Error ? error.message : typeof error === "string" ? error : "Something went wrong. Please try again."; }
function randomSeed(): number { const n = crypto.getRandomValues(new Uint32Array(2)); return (n[0] & 0x1fffff) * 4294967296 + n[1]; }
function readableStatus(status: string): string { return status.toLowerCase().replaceAll("_", " "); }
function samplingLabel(filename: string): string {
  if (filename === PDMD_LORA) return "pDMD fast · 4-step Euler";
  if (filename.includes("ref2v_turbo_4step")) return "Reference Turbo · 4 steps";
  if (filename.includes("fl2v_turbo_4step")) return "Turbo · 4 steps · 768p";
  if (filename.includes("fl2v_turbo_8step")) return "Turbo · 8 steps";
  return filename;
}
function jobError(error: unknown): string { return typeof error === "string" ? error : error ? JSON.stringify(error, null, 2) : "The worker could not finish this job."; }
function workerError(job?: RunpodJob): string {
  if (!job) return "";
  let output = job.output;
  if (typeof output === "string") { try { output = JSON.parse(output); } catch { /* A plain output string is not an error. */ } }
  const details = [job.error, ...(record(output) ? [output.error, output.error_type, output.hint, output.errors] : [])].filter(value => value !== undefined && value !== null && value !== "" && !(Array.isArray(value) && !value.length));
  return [...new Set(details.map(value => jobError(value).slice(0, 3000)))].join("\n");
}
function requestFromJson(text: string): { payload?: JsonRecord; error?: string } {
  try {
    const payload: unknown = JSON.parse(text);
    if (!record(payload) || !record(payload.input) || !record(payload.input.workflow) || !Object.keys(payload.input.workflow).length) throw new Error("Use a request containing input.workflow in ComfyUI API format.");
    const workflow = payload.input.workflow;
    for (const [id, node] of Object.entries(workflow)) {
      if (!record(node) || typeof node.class_type !== "string" || !node.class_type || !record(node.inputs)) throw new Error(`Node ${id} needs class_type and an inputs object. Export in API format, not the canvas format.`);
      for (const value of Object.values(node.inputs)) {
        if (Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && typeof value[1] === "number" && !(value[0] in workflow)) throw new Error(`Node ${id} links to missing node ${value[0]}.`);
      }
    }
    if (payload.input.files !== undefined && !Array.isArray(payload.input.files)) throw new Error("input.files must be an array.");
    if (Array.isArray(payload.input.files)) for (const file of payload.input.files) {
      if (!record(file) || typeof file.name !== "string" || (!file.data && !file.url)) throw new Error("Every input file needs a name and actual base64 data or an HTTPS URL.");
      if (typeof file.url === "string" && !/^https:\/\//i.test(file.url)) throw new Error("Input file URLs must use HTTPS.");
      if (typeof file.data === "string" && /^(?:<.*>|BASE64(?:_|\s)|REPLACE[_ ]|PLACEHOLDER)/i.test(file.data.trim())) throw new Error("Replace media placeholders with actual base64 data before submitting.");
      if (file.data !== undefined && (typeof file.data !== "string" || !/^(?:data:[^;,]+;base64,)?[A-Za-z0-9+/\s]+={0,2}$/.test(file.data))) throw new Error("Input file data must contain valid base64 media.");
    }
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 10_000_000) throw new Error("This request exceeds RunPod's 10 MB limit. Use smaller images or HTTPS media URLs.");
    return { payload };
  } catch (error) { return { error: message(error) }; }
}
function normalizeImport(value: unknown): JsonRecord {
  if (!record(value)) throw new Error("The imported JSON must be a workflow or request object.");
  if (record(value.input)) return value;
  if (record(value.workflow)) return { input: value };
  if (Object.values(value).length && Object.values(value).every(node => record(node) && typeof node.class_type === "string")) return { input: { workflow: value } };
  throw new Error("Export the ComfyUI workflow in API format, or import a RunPod request containing input.workflow.");
}
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`)); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(file); });
}
async function mediaDuration(file: File, kind: "image" | "video" | "audio"): Promise<number | undefined> {
  if (kind === "image") return undefined;
  return new Promise(resolve => { const element = document.createElement(kind); const url = URL.createObjectURL(file); let done = false; const finish = (duration?: number) => { if (done) return; done = true; clearTimeout(timer); element.removeAttribute("src"); element.load(); URL.revokeObjectURL(url); resolve(duration); }; const timer = setTimeout(() => finish(), 8000); element.preload = "metadata"; element.onloadedmetadata = () => finish(Number.isFinite(element.duration) ? element.duration : undefined); element.onerror = () => finish(); element.src = url; });
}
function saveDownload(data: string, filename: string, mime = "application/json"): void { const url = URL.createObjectURL(new Blob([data], { type: mime })); const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }

function Landscape() {
  return <svg className="landscape" viewBox="0 0 600 380" role="img" aria-label="An astronaut exploring a dreamy lavender landscape">
    <defs><linearGradient id="sky" x2="0" y2="1"><stop stopColor="#e9e5fc"/><stop offset="1" stopColor="#c6baf2"/></linearGradient><linearGradient id="hill" x2="0" y2="1"><stop stopColor="#9480cf"/><stop offset="1" stopColor="#7661b4"/></linearGradient><radialGradient id="moon"><stop stopColor="#fffdf5"/><stop offset="1" stopColor="#fcf3d9"/></radialGradient></defs>
    <rect width="600" height="380" fill="url(#sky)"/><circle cx="444" cy="94" r="38" fill="url(#moon)"/>
    <g fill="#fff" opacity=".65"><circle cx="83" cy="46" r="2"/><circle cx="287" cy="71" r="2"/><circle cx="538" cy="167" r="2"/><circle cx="166" cy="119" r="1.5"/><circle cx="376" cy="38" r="1.5"/></g>
    <path d="M0 214 Q84 178 180 223 T365 198 T600 205V380H0Z" fill="#b1a1de"/><path d="M0 276Q90 228 188 276T405 244T600 273V380H0Z" fill="#a08dd2"/><path d="M0 318Q99 267 218 305T600 310V380H0Z" fill="url(#hill)"/>
    <path d="M276 380Q240 339 289 303Q316 278 331 243" fill="none" stroke="#d8c8eb" strokeWidth="25" opacity=".7"/>
    <g transform="translate(325 208)"><ellipse cx="9" cy="81" rx="28" ry="7" fill="#5b4892" opacity=".25"/><path d="M0 54L-7 80M17 53L26 80" stroke="#fffdf6" strokeWidth="12" strokeLinecap="round"/><rect x="-5" y="25" width="31" height="36" rx="12" fill="#fffdf6"/><rect x="-12" y="30" width="12" height="26" rx="5" fill="#ded8e6"/><path d="M-1 35L-14 50M23 35L34 49" stroke="#fffdf6" strokeWidth="10" strokeLinecap="round"/><circle cx="10" cy="16" r="20" fill="#fffdf6"/><rect x="-4" y="5" width="28" height="22" rx="11" fill="#7763a5"/><path d="M1 10Q8 5 17 10" fill="none" stroke="#c7b2ec" strokeWidth="3" strokeLinecap="round"/><rect x="4" y="35" width="13" height="10" rx="3" fill="#c8c0d4"/><circle cx="8" cy="40" r="2" fill="#adf183"/></g>
    <g fill="#b6a1d9"><ellipse cx="72" cy="345" rx="20" ry="6"/><ellipse cx="501" cy="319" rx="13" ry="4"/></g>
  </svg>;
}

export default function Home() {
  const [view, setView] = useState<"studio" | "history">("studio");
  const [featureId, setFeatureId] = useState<FeatureId>("text-to-video");
  const [category, setCategory] = useState("All tools");
  const [prompt, setPrompt] = useState(PROMPTS["text-to-video"]!);
  const [duration, setDuration] = useState(5);
  const [aspectRatio, setAspectRatio] = useState("16:9");
  const [megapixels, setMegapixels] = useState(1.032192);
  const [seed, setSeed] = useState(421804992);
  const [steps, setSteps] = useState(8);
  const [audio, setAudio] = useState(true);
  const [includeVideoAudio, setIncludeVideoAudio] = useState(true);
  const [lora, setLora] = useState(DEFAULT_MODELS.fl2vaLora);
  const [loraStrength, setLoraStrength] = useState(1);
  const [creativeLoras, setCreativeLoras] = useState<{ name: string; strength: number }[]>([]);
  const [models, setModels] = useState<ModelSettings>({ ...DEFAULT_MODELS });
  const [files, setFiles] = useState<Asset[]>([]);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const [controlStrength, setControlStrength] = useState(1);
  const [upscaleScale, setUpscaleScale] = useState(2);
  const [lightAzimuth, setLightAzimuth] = useState(45);
  const [lightElevation, setLightElevation] = useState(35);
  const [lightIntensity, setLightIntensity] = useState(60);
  const [lightKelvin, setLightKelvin] = useState(5600);
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [connected, setConnected] = useState(false);
  const [health, setHealth] = useState<RunpodHealth | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [toast, setToast] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [jobBusy, setJobBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [customRequest, setCustomRequest] = useState<JsonRecord | null>(null);
  const [customAuthored, setCustomAuthored] = useState(false);
  const [customName, setCustomName] = useState("");
  const [editorImported, setEditorImported] = useState(false);
  const [updatedHandler, setUpdatedHandler] = useState(false);
  const [importName, setImportName] = useState("");
  const [outputs, setOutputs] = useState<RunpodOutput[]>([]);
  const [outputIndex, setOutputIndex] = useState(0);
  const [pollPaused, setPollPaused] = useState("");
  const [pollAttempt, setPollAttempt] = useState(0);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const currentFeatureRef = useRef(featureId);
  const credentialsRef = useRef({ endpoint, apiKey });
  const jobEpochsRef = useRef<Record<string, number>>({});
  const manualJobsRef = useRef(new Set<string>());
  const feature = FEATURES.find(item => item.id === featureId)!;
  const usingPdmd = lora === PDMD_LORA;
  const Icon = ICONS[feature.icon] || Sparkles;
  const activeJob = history.find(item => item.id === activeId);
  const currentOutput = outputs[outputIndex] || outputs[0];
  const running = !!activeJob && !TERMINAL.has(activeJob.status);
  const activeWorkerError = workerError(activeJob?.job);
  const filteredFeatures = FEATURES.filter(item => category === "All tools" || (category === "Create" && item.output === "video" && !["video-edit", "motion-transfer", "character-swap", "style-transfer", "extend-video"].includes(item.id)) || (category === "Remix" && ["video-edit", "motion-transfer", "character-swap", "style-transfer", "extend-video"].includes(item.id)) || (category === "Image" && item.output === "image") || (category === "Audio" && ["voice-reference", "audio-to-video", "reference-to-video"].includes(item.id)));
  const dimensions = dimensionsForRatio(aspectRatio, megapixels);
  const builder = useMemo(() => {
    try {
      if (feature.modelFamily === "ref2va") for (const file of files) { const slot = feature.media.find(item => item.role === file.role); if (slot && slot.kind !== "image" && !Number.isFinite(file.duration)) throw new Error(`Enter the duration of ${file.name} so reference limits can be checked.`); }
      if (featureId === "extend-video") { const source = files.find(file => file.role === "source_video"); if (source?.duration !== undefined && source.duration < 39 / 24) throw new Error("The source clip needs at least 39 frames at 24 fps (1.625 seconds)."); }
      return { payload: buildRequest({ feature: featureId, prompt, duration, aspectRatio, megapixels, seed, steps, model: models[feature.modelFamily], clip: models.clip, videoVae: models.videoVae, audioVae: models.audioVae, lora, files, extras: { audio, includeVideoAudio, loraStrength, loras: creativeLoras, controlStrength, upscaleScale, lightAzimuth, lightElevation, lightIntensity, lightKelvin } }) as unknown as JsonRecord, error: "" };
    }
    catch (err) { return { payload: undefined, error: message(err) }; }
  }, [featureId, feature.modelFamily, prompt, duration, aspectRatio, megapixels, seed, steps, models, lora, files, audio, includeVideoAudio, loraStrength, creativeLoras, controlStrength, upscaleScale, lightAzimuth, lightElevation, lightIntensity, lightKelvin]);
  const jsonResult = useMemo(() => requestFromJson(jsonText), [jsonText]);
  const payload = customRequest || builder.payload;
  const draftAuthored = !!jsonResult.payload && (editorImported || JSON.stringify(jsonResult.payload) !== JSON.stringify(builder.payload));
  const importedNeedsHandler = !!customRequest && customAuthored && !updatedHandler;
  const draftNeedsHandler = draftAuthored && !updatedHandler;
  const updateHistory = useCallback((id: string, job: RunpodJob, resetResult = false) => setHistory(items => items.map(item => {
    if (item.id !== id) return item;
    if (!resetResult && TERMINAL.has(item.status) && job.status && !TERMINAL.has(job.status)) return item;
    return { ...item, status: job.status || item.status, job: resetResult ? { ...job, id } : { ...item.job, ...job, id } };
  })), []);

  useEffect(() => {
    try {
      setEndpoint(localStorage.getItem("minimax-studio.endpoint") || "");
      const savedModels: unknown = JSON.parse(localStorage.getItem("minimax-studio.models") || "null");
      if (record(savedModels)) { setModels(current => Object.fromEntries(Object.entries(current).map(([key, value]) => [key, typeof savedModels[key] === "string" ? savedModels[key] : value])) as ModelSettings); if (typeof savedModels.fl2vaLora === "string") { setLora(savedModels.fl2vaLora); setSteps(recommendedSteps(savedModels.fl2vaLora, "fl2va") ?? 20); } }
      const savedHistory: unknown = JSON.parse(localStorage.getItem("minimax-studio.history") || "[]");
      if (Array.isArray(savedHistory)) setHistory(savedHistory.filter(item => record(item) && typeof item.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.id) && typeof item.endpoint === "string" && typeof item.title === "string" && typeof item.status === "string" && typeof item.createdAt === "number").slice(0, 40) as HistoryItem[]);
    } catch { /* Private browsing and unavailable local storage do not block the studio. */ }
    setHydrated(true);
  }, []);
  useEffect(() => { if (!hydrated) return; try { localStorage.setItem("minimax-studio.endpoint", endpoint); localStorage.setItem("minimax-studio.models", JSON.stringify(models)); localStorage.setItem("minimax-studio.history", JSON.stringify(history.map(({ job: _job, ...item }) => item).slice(0, 40))); } catch { /* Session-only operation is still available. */ } }, [hydrated, endpoint, models, history]);
  useEffect(() => { setConnected(false); setHealth(null); }, [endpoint, apiKey]);
  useEffect(() => { currentFeatureRef.current = featureId; }, [featureId]);
  useEffect(() => { credentialsRef.current = { endpoint, apiKey }; }, [endpoint, apiKey]);
  useEffect(() => { setPollPaused(""); }, [activeId, endpoint, apiKey]);
  useEffect(() => { const dialog = dialogRef.current; if (modal && !dialog?.open) dialog?.showModal(); if (!modal && dialog?.open) dialog.close(); }, [modal]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 3500); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => { const parsed = parseOutputs(activeJob?.job?.output); setOutputs(parsed); setOutputIndex(0); return () => revokeOutputs(parsed); }, [activeJob?.id, activeJob?.job?.output]);
  useEffect(() => {
    if (!activeJob || !running || !apiKey.trim() || pollPaused) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>; let failures = 0;
    const poll = async () => {
      let delay = 4000;
      if (manualJobsRef.current.has(activeJob.id)) { timer = setTimeout(poll, delay); return; }
      const epoch = jobEpochsRef.current[activeJob.id] || 0;
      try {
        const job = await callRunpod({ endpoint: activeJob.endpoint, apiKey, operation: "status", jobId: activeJob.id }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (epoch !== (jobEpochsRef.current[activeJob.id] || 0) || manualJobsRef.current.has(activeJob.id)) { timer = setTimeout(poll, delay); return; }
        failures = 0; updateHistory(activeJob.id, job); setError(workerError(job)); if (TERMINAL.has(job.status || "")) return;
      }
      catch (err) {
        if (controller.signal.aborted) return;
        failures++; const stopped = err instanceof RunpodError && [401, 403, 404].includes(err.status) || failures >= 5;
        const detail = message(err); setError(detail);
        if (stopped) { setPollPaused(`${detail} Automatic checks paused. Refresh this job manually or reconnect RunPod.`); return; }
        delay = err instanceof RunpodError ? Math.max(8000, err.retryAfterMs) : 8000;
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, 2500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [activeJob?.id, activeJob?.endpoint, activeJob?.status, apiKey, running, pollPaused, pollAttempt, updateHistory]);

  function chooseFeature(id: FeatureId) {
    const next = FEATURES.find(item => item.id === id)!;
    setFeatureId(id); setPrompt(PROMPTS[id] || ""); setFiles([]); setMediaUrls({}); setCustomRequest(null); setCustomAuthored(false); setCustomName(""); setImportName(""); setEditorImported(false); setCreativeLoras([]); setError(""); setView("studio");
    const adapter = next.output === "image" ? "" : next.modelFamily === "ref2va" ? models.ref2vaLora : models.fl2vaLora;
    setLora(adapter); setSteps(recommendedSteps(adapter, next.modelFamily) ?? 20);
  }
  function changeLora(value: string) { setLora(value); const suggested = recommendedSteps(value, feature.modelFamily); if (suggested) setSteps(suggested); }
  function openRequest() { setJsonText(payload ? JSON.stringify(payload, null, 2) : ""); setImportName(customRequest ? customName : ""); setEditorImported(customRequest ? customAuthored : false); setModal("request"); }
  async function testConnection() {
    setConnecting(true); setConnectionError("");
    try { const result = await callRunpod<RunpodHealth>({ endpoint, apiKey, operation: "health" }); if (credentialsRef.current.endpoint !== endpoint || credentialsRef.current.apiKey !== apiKey) return; setHealth(result); setConnected(true); setPollPaused(""); setPollAttempt(current => current + 1); setToast("RunPod connection verified"); }
    catch (err) { setConnected(false); setConnectionError(message(err)); }
    finally { setConnecting(false); }
  }
  async function addFiles(slot: MediaSlot, event: ChangeEvent<HTMLInputElement>) {
    const incoming = Array.from(event.target.files || []); event.target.value = "";
    if (!incoming.length) return;
    const featureAtStart = featureId;
    const remaining = slot.max - files.filter(file => file.role === slot.role).length;
    if (incoming.length > remaining) { setError(`${slot.label} accepts up to ${slot.max} file${slot.max > 1 ? "s" : ""}.`); return; }
    setUploading(true); setError("");
    try {
      const assets = await Promise.all(incoming.map(async file => {
        if (!file.type.startsWith(`${slot.kind}/`)) throw new Error(`${file.name} must be a ${slot.kind} file.`);
        if (file.size > 7_000_000) throw new Error(`${file.name} is too large for an inline request. Add an HTTPS URL instead.`);
        const [data, measuredDuration] = await Promise.all([readFile(file), mediaDuration(file, slot.kind)]);
        return { id: crypto.randomUUID(), role: slot.role, name: file.name, mime_type: file.type, data, ...(measuredDuration !== undefined ? { duration: measuredDuration } : {}), ...(slot.kind === "video" ? { hasAudio: true } : {}) };
      }));
      if (currentFeatureRef.current === featureAtStart) setFiles(current => [...current, ...assets]);
    } catch (err) { setError(message(err)); }
    finally { setUploading(false); }
  }
  function addMediaUrl(slot: MediaSlot) {
    try {
      const url = new URL(mediaUrls[slot.role] || "");
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("Enter a public HTTPS media URL.");
      if (files.filter(file => file.role === slot.role).length >= slot.max) throw new Error(`${slot.label} accepts up to ${slot.max} files.`);
      const fallback = `reference.${slot.kind === "image" ? "png" : slot.kind === "video" ? "mp4" : "wav"}`;
      setFiles(current => [...current, { id: crypto.randomUUID(), role: slot.role, name: decodeURIComponent(url.pathname.split("/").pop() || fallback), url: url.href, mime_type: `${slot.kind}/${slot.kind === "image" ? "png" : slot.kind === "video" ? "mp4" : "wav"}`, ...(slot.kind === "video" ? { hasAudio: true } : {}) }]);
      setMediaUrls(current => ({ ...current, [slot.role]: "" })); setError("");
    } catch (err) { setError(message(err)); }
  }
  async function generate(request = payload, fromEditor = false) {
    if (!request || busy || uploading) return;
    if (!endpoint.trim() || !apiKey.trim()) { setModal("connection"); setConnectionError("Add your endpoint and API key to generate."); return; }
    const authored = fromEditor ? draftAuthored : !!customRequest && customAuthored;
    if (authored && !updatedHandler) { setError("Confirm that your worker uses the included updated handler before submitting this authored workflow."); return; }
    const checked = requestFromJson(JSON.stringify(request));
    if (!checked.payload) { setError(checked.error || "Check the request JSON."); return; }
    setBusy(true); setError("");
    try {
      const job = await callRunpod({ endpoint, apiKey, operation: "run", payload: checked.payload });
      const resultError = workerError(job);
      if (!job.id) throw new Error(resultError || "RunPod did not return a job ID. Check RunPod Requests before submitting again.");
      const item: HistoryItem = { id: job.id, endpoint: normaliseEndpoint(endpoint), title: authored ? (fromEditor ? importName : customName) || "Custom API workflow" : feature.title, prompt: authored ? "Authored workflow · see request JSON" : prompt, createdAt: Date.now(), status: job.status || "IN_QUEUE", job, ...(!authored ? { seed, duration, aspectRatio } : {}) };
      setHistory(current => [item, ...current.filter(old => old.id !== item.id)].slice(0, 40)); setActiveId(item.id); setView("studio"); setModal(null); setError(resultError); setToast(resultError ? "The worker returned an error" : "Your generation is in the queue");
    } catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }
  async function refreshJob(item: HistoryItem, operation: "status" | "cancel" | "retry" = "status") {
    if (!apiKey.trim()) { setModal("connection"); setConnectionError("Enter your API key to access this RunPod job."); return; }
    if (manualJobsRef.current.has(item.id)) return;
    manualJobsRef.current.add(item.id); jobEpochsRef.current[item.id] = (jobEpochsRef.current[item.id] || 0) + 1;
    setJobBusy(true); setError("");
    try { const job = await callRunpod({ endpoint: item.endpoint, apiKey, operation, jobId: item.id }); updateHistory(item.id, { ...job, status: job.status || (operation === "cancel" ? "CANCELLED" : operation === "retry" ? "IN_QUEUE" : item.status) }, operation === "retry"); setPollPaused(""); setPollAttempt(current => current + 1); setError(workerError(job)); setToast(operation === "status" ? "Job status refreshed" : operation === "cancel" ? "Cancellation requested" : "Retry requested"); }
    catch (err) { setError(message(err)); }
    finally { manualJobsRef.current.delete(item.id); setJobBusy(false); }
  }
  async function importWorkflow(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
    try { if (file.size > 10_000_000) throw new Error("Choose a JSON file smaller than 10 MB."); const imported = normalizeImport(JSON.parse(await file.text())); const text = JSON.stringify(imported, null, 2); const result = requestFromJson(text); if (!result.payload) throw new Error(result.error); setJsonText(text); setImportName(file.name); setEditorImported(true); setUpdatedHandler(false); setModal("request"); setError(""); }
    catch (err) { setError(message(err)); }
  }
  async function copyRequest() { try { await navigator.clipboard.writeText(jsonText); setToast("Request JSON copied"); } catch { setToast("Select the request JSON to copy it"); } }
  function toggleCreative(name: string) { setCreativeLoras(current => current.some(item => item.name === name) ? current.filter(item => item.name !== name) : [...current, { name, strength: 1 }]); }
  const loadedInventory = [...BASE_MODELS.fl2va, ...BASE_MODELS.ref2va, models.clip, ...VIDEO_VAES, models.audioVae, CONTROLNET, ...LORAS, UPSCALER];

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setView("studio"); }} aria-label="MiniMax Studio home"><span className="brand-mark"><Sparkles size={22}/></span><span>minimax<span className="brand-sub">STUDIO</span></span></a>
      <div className="sidebar-label">WORKSPACE</div>
      <nav aria-label="Workspace navigation"><button className={`nav-item ${view === "studio" ? "active" : ""}`} onClick={() => setView("studio")}><Grid2X2 size={19}/> Create studio <span className="nav-dot"/></button><button className={`nav-item ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}><Film size={19}/> My generations <span className="nav-count">{history.length}</span></button><button className="nav-item" onClick={() => setModal("models")}><Layers3 size={19}/> Models & LoRAs</button></nav>
      <div className="sidebar-label">RESOURCES</div><nav aria-label="Resource navigation"><button className="nav-item" onClick={() => setModal("guide")}><BookOpen size={19}/> Quick start</button><a className="nav-item" href="https://github.com/P163yr/Minimax-Studio" target="_blank" rel="noreferrer"><Code2 size={19}/> ComfyUI repository <ArrowRight size={14}/></a></nav>
      <div className="engine-card"><span className="engine-logo"><Zap size={19} fill="currentColor"/></span><div className="engine-info"><strong>MiniMax H3</strong><span>Open weights. Big ideas.</span></div><span className="engine-live"/></div>
      <div className="sidebar-bottom"><div className="little-note"><Sparkles size={15}/><span>A little imagination.<br/>A whole new world.</span></div><div className="profile"><span className="avatar">Y</span><div><strong>Your workspace</strong><span>RunPod Serverless</span></div><button className="icon-button" aria-label="Connection settings" onClick={() => setModal("connection")}><Settings2 size={18}/></button></div></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb">Workspace <ChevronRight size={13}/> <strong>{view === "studio" ? "Create studio" : "My generations"}</strong></div><div className="top-actions"><span className="version-tag">H3 OPEN WEIGHTS</span><button className={`connection-pill ${connected ? "connected" : ""}`} onClick={() => setModal("connection")}><span/>{connected ? "RunPod connected" : "Connect RunPod"}<ChevronDown size={13}/></button></div></header>
      <main>
        {view === "studio" ? <>
          <section className="welcome"><div><div className="eyebrow"><span className="tiny-star">✦</span> YOUR NEXT GREAT IDEA STARTS HERE</div><h1>Imagine it.<br className="mobile-break"/> <span>Make it move.</span></h1><p>One studio. Endless possibilities. Create with MiniMax H3.</p></div><div className="welcome-decoration" aria-hidden="true"><div className="orbit"/><span className="deco-spark">✦</span><span className="deco-dot"/><span className="deco-small-star">✧</span></div></section>
          <section className="features-section" aria-label="Generation features"><div className="section-line"><div className="feature-tabs" role="tablist" aria-label="Feature categories">{["All tools", "Create", "Remix", "Image", "Audio"].map(tab => <button role="tab" aria-selected={category === tab} key={tab} className={category === tab ? "selected" : ""} onClick={() => setCategory(tab)}>{tab}{tab === "All tools" && <span>{FEATURES.length}</span>}</button>)}</div><div className="carousel-controls"><button className="icon-button" aria-label="Previous features" onClick={() => carouselRef.current?.scrollBy({ left: -450, behavior: "smooth" })}><ChevronLeft size={17}/></button><button className="icon-button" aria-label="Next features" onClick={() => carouselRef.current?.scrollBy({ left: 450, behavior: "smooth" })}><ChevronRight size={17}/></button></div></div>
            <div className="feature-carousel" ref={carouselRef}>{filteredFeatures.map((item, index) => { const CardIcon = ICONS[item.icon] || Sparkles; return <button key={item.id} className={`feature-card ${item.id === featureId ? "chosen" : ""}`} style={{ "--card-color": item.color } as CSSProperties} onClick={() => chooseFeature(item.id)} aria-pressed={item.id === featureId}><div className={`card-art art-${index % 6}`} aria-hidden="true"><span className="card-type">{item.modelFamily === "ref2va" ? "REFERENCE" : item.output === "image" ? "IMAGE" : "VIDEO"}</span><div className="card-orb"/><div className="card-ring"/><div className="card-sheet sheet-one"/><div className="card-sheet sheet-two"/><CardIcon className="art-symbol" size={32} strokeWidth={1.7}/></div><div className="card-bottom"><div><CardIcon size={17}/><h3>{item.title}</h3></div><p>{item.description}</p><span className="card-arrow">{item.id === featureId ? <Check size={14}/> : <ArrowRight size={14}/>}</span></div></button>; })}</div>
          </section>
          {error && <div className="error-box" role="alert"><CircleHelp size={18}/><span>{error}</span><button className="icon-button" onClick={() => setError("")} aria-label="Dismiss error"><X size={16}/></button></div>}
          <div className="creation-grid">
            <section className="composer"><div className="panel-header"><div className="panel-title"><span className="mode-icon" style={{ background: feature.color }}><Icon size={18}/></span><h2>{customRequest ? "Custom API workflow" : feature.title}</h2></div><span className="panel-kicker">{customRequest ? "AUTHORED JSON" : "LET'S CREATE"}</span></div>
              {customRequest && <div className="request-note"><Code2 size={17}/><div><strong>{customName || "Custom request active"}</strong><p>The authored JSON is submitted exactly as shown in the request inspector. Builder controls are paused.</p><button className="small-button" onClick={() => { setCustomRequest(null); setCustomAuthored(false); setCustomName(""); setImportName(""); setEditorImported(false); }}>Return to builder</button></div></div>}
              {!customRequest && feature.media.length > 0 && <div className="upload-grid">{feature.media.map(slot => <div className="media-slot" key={slot.role}><div className="label-row"><label>{slot.label}</label><span>{slot.required ? "Required" : "Optional"}{slot.max > 1 ? ` · up to ${slot.max}` : ""}</span></div><div className="media-items">{files.filter(file => file.role === slot.role).map((file, index) => <div className="asset" key={file.id}>{slot.kind === "image" ? <img src={file.url || `data:${file.mime_type};base64,${file.data}`} alt={file.name}/> : <span className="asset-icon">{slot.kind === "audio" ? <Music2 size={20}/> : <Film size={20}/>}</span>}<div><strong>{file.name}</strong><span>{file.url ? "HTTPS reference" : "Uploaded"}{file.duration ? ` · ${file.duration.toFixed(1)}s` : ""}</span>{slot.kind !== "image" && <label className="asset-duration">Duration (s)<input type="number" min="0.1" step="0.1" value={file.duration ?? ""} placeholder="Metadata" aria-label={`${file.name} duration`} onChange={event => setFiles(current => current.map(asset => asset.id === file.id ? { ...asset, duration: event.target.value ? Number(event.target.value) : undefined } : asset))}/></label>}{slot.kind === "video" && <label className="asset-checkbox"><input type="checkbox" checked={file.hasAudio !== false} onChange={event => setFiles(current => current.map(asset => asset.id === file.id ? { ...asset, hasAudio: event.target.checked } : asset))}/> Has soundtrack</label>}{slot.role === "guide_image" && <label className="asset-duration">Guide frame<input type="number" min="1" max={framesForDuration(duration) - 2} value={file.frame_idx ?? ""} placeholder={`Auto ${index + 1}`} aria-label={`${file.name} guide frame`} onChange={event => setFiles(current => current.map(asset => asset.id === file.id ? { ...asset, frame_idx: event.target.value ? Number(event.target.value) : undefined } : asset))}/></label>}</div><button className="icon-button" aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter(asset => asset.id !== file.id))}><X size={14}/></button></div>)}</div>{files.filter(file => file.role === slot.role).length < slot.max && <><label className="upload-box"><Upload size={20}/><strong>{uploading ? "Reading media…" : `Add ${slot.kind}`}</strong><span>Choose a file or add an HTTPS link</span><input className="file-input" type="file" accept={`${slot.kind}/*`} multiple={slot.max > 1} disabled={uploading} onChange={event => void addFiles(slot, event)}/></label><div className="media-url-row"><input type="url" aria-label={`${slot.label} HTTPS URL`} placeholder="https://…" value={mediaUrls[slot.role] || ""} onChange={event => setMediaUrls(current => ({ ...current, [slot.role]: event.target.value }))}/><button className="icon-button" aria-label={`Add ${slot.label} URL`} onClick={() => addMediaUrl(slot)} disabled={!mediaUrls[slot.role]?.trim()}><Plus size={16}/></button></div></>}</div>)}</div>}
              <div className="prompt-label"><label htmlFor="prompt">{feature.output === "image" ? "Describe your edit" : "Your prompt"}</label><span><Sparkles size={13}/> A little detail goes a long way</span></div><div className="prompt-box"><textarea id="prompt" value={prompt} maxLength={7000} disabled={!!customRequest} onChange={event => setPrompt(event.target.value)} placeholder="Describe the scene, movement, light and sound you imagine…"/><div className="prompt-footer"><button disabled={!!customRequest} onClick={() => setPrompt(PROMPTS[featureId] || "")}><WandSparkles size={14}/> Try an idea</button><span>{prompt.length} / 7,000</span></div></div>
              <div className="settings-row"><div className="field"><label htmlFor="ratio">Aspect ratio</label><select id="ratio" disabled={!!customRequest} value={aspectRatio} onChange={event => setAspectRatio(event.target.value)}><option>16:9</option><option>9:16</option><option>1:1</option><option>4:3</option><option>3:4</option><option>21:9</option></select></div><div className="field"><label htmlFor="duration">{feature.output === "image" ? "Output" : featureId === "extend-video" ? "New section" : "Duration"}</label>{feature.output === "image" ? <input id="duration" value="Still image" disabled/> : <select id="duration" value={duration} disabled={!!customRequest} onChange={event => setDuration(Number(event.target.value))}>{[5, 6, 8, 10, 12, 15].map(value => <option key={value} value={value}>{value} seconds</option>)}</select>}</div><div className="field"><label htmlFor="resolution">Base resolution</label><select id="resolution" value={megapixels} disabled={!!customRequest} onChange={event => setMegapixels(Number(event.target.value))}><option value={0.5}>0.5 MP · Draft</option><option value={1}>1 MP · Balanced</option><option value={1.032192}>Native 768p · 1.03 MP</option><option value={1.5}>1.5 MP · Detailed</option><option value={2}>2 MP · High</option></select></div></div>
              {feature.output === "video" && <div className="audio-row"><span className="audio-icon"><AudioLines size={19}/></span><div><strong>Native audio</strong><span>Let your scene sound as good as it looks</span></div><button className={`switch ${audio ? "on" : ""}`} role="switch" aria-checked={audio} aria-label="Include generated native audio" disabled={!!customRequest} onClick={() => setAudio(current => !current)}><span/></button></div>}
              <button className="advanced-toggle" onClick={() => setAdvanced(current => !current)} aria-expanded={advanced}><Settings2 size={15}/> Advanced settings <ChevronDown size={14}/></button>
              {advanced && <div className="advanced-settings"><div className="settings-row"><div className="field"><label htmlFor="seed">Seed <button className="icon-button" aria-label="Randomize seed" disabled={!!customRequest} onClick={() => setSeed(randomSeed())}><Shuffle size={13}/></button></label><input id="seed" type="number" min="0" max={Number.MAX_SAFE_INTEGER} value={seed} disabled={!!customRequest} onChange={event => setSeed(Number(event.target.value))}/></div><div className="field"><label htmlFor="steps">Sampling steps</label><input id="steps" type="number" min="1" max="100" value={usingPdmd ? PDMD_PROFILE.steps : steps} disabled={!!customRequest || usingPdmd} onChange={event => setSteps(Number(event.target.value))}/></div></div><div className="field"><label htmlFor="sampling-lora">Sampling profile</label><select id="sampling-lora" value={lora} disabled={!!customRequest} onChange={event => changeLora(event.target.value)}><option value="">No sampling LoRA · full model</option>{LORAS.filter(name => /pdmd|turbo/.test(name) && !(feature.modelFamily === "ref2va" ? /fl2v/.test(name) || name === PDMD_LORA : /ref2v/.test(name))).map(name => <option value={name} key={name}>{samplingLabel(name)}</option>)}</select><span className="helper-text">{usingPdmd ? "pDMD fast uses 4-step Euler sampling, strength 1 and video/audio shifts 12/3." : feature.modelFamily === "ref2va" ? "Reference Turbo recommends 4 steps. Choose the full model for undistilled sampling." : "Turbo profiles recommend 4 or 8 steps. pDMD fast uses its matched 4-step Euler preset."}</span></div><div className="field"><label htmlFor="lora-strength">Sampling LoRA strength</label><input id="lora-strength" type="number" min="-2" max="2" step="0.05" value={usingPdmd ? PDMD_PROFILE.loraStrength : loraStrength} disabled={!!customRequest || !lora || usingPdmd} onChange={event => setLoraStrength(Number(event.target.value))}/></div>{feature.modelFamily === "ref2va" && <label className="lora-check"><input type="checkbox" checked={includeVideoAudio} disabled={!!customRequest} onChange={event => setIncludeVideoAudio(event.target.checked)}/> Use soundtracks from video references</label>}{featureId === "union-controlnet" && <div className="field"><label>Control strength</label><input type="number" min="0" max="2" step="0.05" value={controlStrength} disabled={!!customRequest} onChange={event => setControlStrength(Number(event.target.value))}/></div>}{featureId === "latent-upscale" && <div className="field"><label>Latent upscale factor</label><select value={upscaleScale} disabled={!!customRequest} onChange={event => setUpscaleScale(Number(event.target.value))}><option value={1.5}>1.5×</option><option value={2}>2×</option><option value={3}>3×</option><option value={4}>4×</option></select></div>}{featureId === "relight" && <div className="settings-row">{[{ label: "Azimuth", value: lightAzimuth, min: -180, max: 180, setter: setLightAzimuth }, { label: "Elevation", value: lightElevation, min: -90, max: 90, setter: setLightElevation }, { label: "Intensity", value: lightIntensity, min: 10, max: 100, setter: setLightIntensity }, { label: "Kelvin", value: lightKelvin, min: 1000, max: 10000, setter: setLightKelvin }].map(item => <div className="field" key={item.label}><label>{item.label}</label><input type="number" min={item.min} max={item.max} value={item.value} disabled={!!customRequest} onChange={event => item.setter(Number(event.target.value))}/></div>)}</div>}<div className="creative-loras"><div className="select-heading">Creative adapters <span>Stack your installed LoRAs</span></div>{CREATIVE_LORAS.filter(name => name !== lora && !(featureId === "camera-motion" && name.startsWith("camera_motion")) && !(feature.modelFamily === "fl2va" && /ref2va/.test(name))).map(name => { const selected = creativeLoras.find(item => item.name === name); return <div className="lora-check" key={name}><label><input type="checkbox" checked={!!selected} disabled={!!customRequest} onChange={() => toggleCreative(name)}/><span>{name.replace(/\.safetensors$/, "")}</span></label>{selected && <input aria-label={`${name} strength`} type="number" min="-2" max="2" step="0.05" value={selected.strength} disabled={!!customRequest} onChange={event => setCreativeLoras(current => current.map(item => item.name === name ? { ...item, strength: Number(event.target.value) } : item))}/>}</div>; })}</div></div>}
              {!customRequest && builder.error && <p className="helper-text validation-note">{builder.error}</p>}{importedNeedsHandler && <p className="helper-text validation-note">Confirm the updated worker handler in the request inspector before generating.</p>}
              <div className="generate-row"><button className="generate-button" disabled={busy || uploading || !payload || importedNeedsHandler} onClick={() => void generate()}>{busy ? <LoaderCircle size={18} className="spin"/> : <Sparkles size={18}/>} {busy ? "Submitting…" : customRequest ? "Generate request" : `Generate ${feature.output === "image" ? "image" : "video"}`}<ArrowRight size={18}/></button><button className="inspect-button" onClick={openRequest} aria-label="Inspect or import request JSON"><Code2 size={19}/></button></div><div className="composer-foot"><ShieldCheck size={13}/><span>Your API key stays in this tab.</span><span>{dimensions.width} × {dimensions.height} {feature.output === "video" ? `· 24 fps · ${framesForDuration(duration)} frames` : ""}</span></div>
            </section>
            <section className="preview-panel"><div className="preview-heading"><h2>Your canvas</h2><span className="preview-badge"><span/>{currentOutput ? "READY TO PLAY" : running ? "CREATING" : "A WORLD OF POSSIBILITIES"}</span></div><div className="preview-canvas">{currentOutput ? currentOutput.kind === "video" ? <video key={currentOutput.url} src={currentOutput.url} controls playsInline/> : currentOutput.kind === "image" ? <img src={currentOutput.url} alt="Generated output"/> : currentOutput.kind === "audio" ? <div className="empty-preview"><AudioLines size={38}/><audio src={currentOutput.url} controls/></div> : <div className="empty-preview"><ArrowDownToLine size={32}/><p>Your file is ready to download.</p></div> : <><Landscape/><span className="illustration-badge"><Sparkles size={12}/> A little inspiration</span>{running && <div className="preview-progress"><LoaderCircle size={25} className="spin"/><span>{activeJob?.status === "IN_QUEUE" ? "Waiting for your RunPod worker…" : "Your idea is taking shape…"}</span></div>}</>}</div>
              {currentOutput ? <div className="preview-meta"><div><strong>{currentOutput.filename}</strong><span>{currentOutput.mime}</span></div><a className="download-link" href={currentOutput.url} download={currentOutput.filename} target={currentOutput.isObjectUrl ? undefined : "_blank"} rel="noreferrer"><ArrowDownToLine size={16}/> Download</a></div> : <div className="empty-preview"><span className="preview-spark">✧</span><h3>{running ? "Good things are in motion" : "Your imagination, in motion"}</h3><p>{running ? "You can keep exploring while your worker creates." : "Write a prompt, make it yours, and hit generate. Your creation will appear right here."}</p></div>}
              {outputs.length > 1 && <div className="output-tabs">{outputs.map((output, index) => <button key={`${output.url}-${index}`} className={index === outputIndex ? "selected" : ""} onClick={() => setOutputIndex(index)}>{output.kind} {index + 1}</button>)}</div>}
              {activeJob && <div className="job-card"><div className="job-card-heading"><strong>{activeJob.title}</strong><span className={`status-tag ${activeJob.status === "COMPLETED" && !activeWorkerError ? "done" : ""}`}>{activeWorkerError ? "worker error" : readableStatus(activeJob.status)}</span></div><span className="job-id">{activeJob.id}</span>{activeJob.job?.executionTime !== undefined && <p>Worker time: {(activeJob.job.executionTime / 1000).toFixed(1)}s</p>}{activeWorkerError && <p className="helper-text" role="alert" style={{ whiteSpace: "pre-wrap" }}>{activeWorkerError}</p>}{pollPaused && <p className="helper-text" role="status">{pollPaused}</p>}{activeJob.status === "COMPLETED" && !activeWorkerError && !outputs.length && <p className="helper-text">The job completed without a playable output. Inspect the worker result.</p>}<div className="job-actions"><button disabled={jobBusy} onClick={() => void refreshJob(activeJob)}><RefreshCw size={13}/> Refresh</button>{pollPaused && <button onClick={() => setModal("connection")}><Zap size={13}/> Reconnect</button>}{running && <button disabled={jobBusy} onClick={() => void refreshJob(activeJob, "cancel")}><X size={13}/> Cancel</button>}{["FAILED", "TIMED_OUT"].includes(activeJob.status) && <button disabled={jobBusy} onClick={() => void refreshJob(activeJob, "retry")}><RefreshCw size={13}/> Retry job</button>}<button onClick={() => saveDownload(JSON.stringify(activeJob.job || { id: activeJob.id, status: activeJob.status }, null, 2), `runpod-${activeJob.id}.json`)}><Code2 size={13}/> Result JSON</button></div></div>}
              <div className="idea-note"><span>✦</span><p><strong>Make it unmistakably yours.</strong><br/>Try a camera move, a sound, or a surprising detail.</p></div><div className="preview-footer"><span>Powered by your ComfyUI worker</span><button onClick={() => setModal("guide")}><CircleHelp size={14}/> Workflow guide</button></div>
            </section>
          </div>
        </> : <section className="history-view"><div className="welcome"><div><div className="eyebrow">YOUR CREATIVE TRAIL</div><h1>Ideas, <span>in motion.</span></h1><p>Your RunPod jobs, all in one place. Reconnect your key to refresh an earlier generation.</p></div><button className="small-button" onClick={() => setView("studio")}><Plus size={16}/> New generation</button></div>{error && <div className="error-box" role="alert">{error}</div>}<div className="history-list">{history.length ? history.map(item => <article className="history-card" key={item.id}><span className="history-icon"><Film size={22}/></span><div><h3>{item.title}</h3><p>{item.prompt}</p><span>{new Date(item.createdAt).toLocaleString()} · {item.id}</span></div><span className={`status-tag ${item.status === "COMPLETED" ? "done" : ""}`}>{readableStatus(item.status)}</span><button className="small-button" disabled={jobBusy} onClick={() => { setActiveId(item.id); setView("studio"); void refreshJob(item); }}>Open <ArrowRight size={14}/></button></article>) : <div className="empty-preview"><Sparkles size={35}/><h3>Your first idea is waiting</h3><p>Generate a scene and it will be saved here.</p><button className="small-button" onClick={() => setView("studio")}>Go to studio <ArrowRight size={14}/></button></div>}</div></section>}
        <footer className="site-footer"><span>MINIMAX STUDIO</span><p>Made for the moments you haven’t imagined yet.</p><span>H3 · ComfyUI · RunPod</span></footer>
      </main>
    </div>
    <input className="file-input" ref={importRef} type="file" accept="application/json,.json" onChange={event => void importWorkflow(event)}/>
    <dialog className={`modal ${modal === "models" || modal === "request" || modal === "guide" ? "wide" : ""}`} ref={dialogRef} onCancel={() => setModal(null)} onClick={event => { if (event.target === event.currentTarget) { const r = event.currentTarget.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) setModal(null); } }}>
      <div className="modal-head"><div><span className="eyebrow">YOUR STUDIO, YOUR SETUP</span><h2>{modal === "connection" ? "Connect to RunPod" : modal === "models" ? "Models & LoRAs" : modal === "request" ? "Request inspector" : "A little guidance"}</h2></div><button className="icon-button" aria-label="Close dialog" onClick={() => setModal(null)}><X size={20}/></button></div>
      {modal !== "connection" && error && <div className="error-box" role="alert">{error}</div>}
      {modal === "connection" && <div className="connection-modal-body"><p>Connect your serverless ComfyUI endpoint. Generations run on your own RunPod worker.</p><div className="field"><label htmlFor="endpoint">RunPod endpoint</label><input id="endpoint" value={endpoint} placeholder="Endpoint ID or https://api.runpod.ai/v2/…" autoComplete="off" spellCheck={false} onChange={event => setEndpoint(event.target.value)}/><span className="helper-text">Use the endpoint ID or its RunPod API URL.</span></div><div className="field"><label htmlFor="api-key">API key</label><div className="password-input"><input id="api-key" type={showKey ? "text" : "password"} value={apiKey} placeholder="Your RunPod API key" autoComplete="off" spellCheck={false} onChange={event => setApiKey(event.target.value)}/><button className="small-button" onClick={() => setShowKey(current => !current)}>{showKey ? "Hide" : "Show"}</button></div></div>{connectionError && <div className="error-box" role="alert">{connectionError}</div>}{health && <div className="health-result"><Check size={18}/><div><strong>Connected to your endpoint</strong><p>{Object.entries(health.workers || {}).map(([key, value]) => `${value} ${key}`).join(" · ") || "RunPod health check passed"}</p></div></div>}<button className="generate-button" disabled={connecting || !endpoint.trim() || !apiKey.trim()} onClick={() => void testConnection()}>{connecting ? <LoaderCircle size={17} className="spin"/> : <Zap size={17}/>} {connecting ? "Checking connection…" : "Test connection"}</button><div className="modal-footnote"><ShieldCheck size={15}/><p>Your key is held in memory and sent through the same-origin proxy to RunPod. It is never saved to browser storage. The endpoint ID is remembered on this device.</p></div>{apiKey && <button className="small-button" onClick={() => { setApiKey(""); setShowKey(false); setToast("API key removed from this tab"); }}>Disconnect and clear key</button>}</div>}
      {modal === "models" && <div className="models-body"><p>Exact filenames from your inventory. Adjust them if your worker uses a different folder prefix or filename.</p><div className="model-grid">{[{ key: "fl2va", label: "FL2VA · text and keyframes", options: BASE_MODELS.fl2va }, { key: "ref2va", label: "REF2VA · reference generation", options: BASE_MODELS.ref2va }, { key: "clip", label: "Qwen text encoder", options: [DEFAULT_MODELS.clip] }, { key: "videoVae", label: "Video VAE", options: VIDEO_VAES }, { key: "audioVae", label: "Audio VAE", options: [DEFAULT_MODELS.audioVae] }, { key: "fl2vaLora", label: "Default FL2VA sampling profile", options: LORAS.filter(name => /fl2v.*turbo/.test(name) || name === PDMD_LORA) }, { key: "ref2vaLora", label: "Default REF2VA sampling profile", options: LORAS.filter(name => /ref2v.*turbo/.test(name)) }].map(item => <div className="field" key={item.key}><label htmlFor={`model-${item.key}`}>{item.label}</label><input id={`model-${item.key}`} list={`options-${item.key}`} value={models[item.key as keyof ModelSettings]} onChange={event => setModels(current => ({ ...current, [item.key]: event.target.value }))}/><datalist id={`options-${item.key}`}>{item.options.map(option => <option value={option} label={samplingLabel(option)} key={option}/>)}</datalist></div>)}</div><div className="inventory-strip"><Layers3 size={16}/><strong>{loadedInventory.length} installed assets</strong><span>4 checkpoints · 23 LoRAs · encoder, VAEs, control and upscale</span></div><div className="inventory-list">{loadedInventory.map((name, index) => <div key={`${name}-${index}`}><Check size={12}/><code>{name}</code></div>)}</div><div className="request-actions"><button className="small-button" onClick={() => { setModels({ ...DEFAULT_MODELS }); setToast("Inventory defaults restored"); }}>Restore defaults</button><button className="generate-button" onClick={() => { setModal(null); setToast("Model filenames saved on this device"); }}><Check size={16}/> Done</button></div></div>}
      {modal === "request" && <div className="request-body"><div className="request-note"><Code2 size={19}/><div><strong>{importName || "Your exact RunPod payload"}</strong><p>{builder.error && !customRequest && !jsonText ? builder.error : "Inspect, edit, copy or import an authored ComfyUI API workflow. Credentials are sent separately."}</p></div></div><div className="request-toolbar"><button className="small-button" onClick={() => importRef.current?.click()}><Upload size={14}/> Import API JSON</button><button className="small-button" disabled={!jsonText} onClick={() => void copyRequest()}><Copy size={14}/> Copy</button><button className="small-button" disabled={!jsonText} onClick={() => saveDownload(jsonText, "minimax-runpod-request.json")}><ArrowDownToLine size={14}/> Download</button></div><textarea className="json-editor" spellCheck={false} aria-label="RunPod request JSON" value={jsonText} onChange={event => setJsonText(event.target.value)} placeholder={'{\n  "input": {\n    "workflow": { ... }\n  }\n}'}/>{jsonResult.error && <div className="error-box" role="alert">{jsonText ? jsonResult.error : "Add required media in the builder, or import your authored API workflow."}</div>}{jsonResult.payload && draftAuthored && <div className="request-note"><ShieldCheck size={18}/><div><strong>Preserve your authored seed and frame lengths</strong><p>Use the included updated handler for imported or edited workflows. Your JSON and declared parameter overrides pass through exactly; the worker applies those overrides. Without declared overrides, the updated handler keeps authored node settings.</p><label className="lora-check"><input type="checkbox" checked={updatedHandler} onChange={event => setUpdatedHandler(event.target.checked)}/> My worker uses the included updated handler</label></div></div>}<div className="request-actions"><button className="small-button" disabled={!jsonResult.payload || draftNeedsHandler} onClick={() => { if (!jsonResult.payload) return; setCustomRequest(jsonResult.payload); setCustomAuthored(draftAuthored); setCustomName(importName); setModal(null); setToast("Custom workflow active — inspect it before generating"); }}>Use this request</button><button className="generate-button" disabled={!jsonResult.payload || draftNeedsHandler || busy} onClick={() => void generate(jsonResult.payload, true)}>{busy ? <LoaderCircle size={16} className="spin"/> : <Play size={16}/>} Generate request</button></div><p className="modal-footnote">Only the valid JSON currently in this editor is submitted. Your JSON and declared overrides pass through exactly; the worker applies declared overrides.</p></div>}
      {modal === "guide" && <div className="guide-body"><div className="guide-step"><span>01</span><div><h3>Connect your worker</h3><p>Enter your RunPod endpoint and API key, then test the connection. Your endpoint needs the enhanced handler, current ComfyUI H3 nodes and the installed custom-node packs. Deploy the included updated handler before importing authored workflows so their seeds and frame lengths stay intact.</p><button className="small-button" onClick={() => setModal("connection")}>Connection settings <ArrowRight size={13}/></button></div></div><div className="guide-step"><span>02</span><div><h3>Pick your creative starting point</h3><p>FL2VA handles text, keyframes, audio guides and continuation. REF2VA handles multimodal references and prompt-guided video edits. Your exact model inventory is already loaded.</p></div></div><div className="guide-step"><span>03</span><div><h3>Give the workflow what it needs</h3><p>Add required media, describe movement and sound, then inspect the request if needed. For REF2VA, prompt tags are &lt;Picture 1&gt;, &lt;Video 1&gt; and &lt;Audio 1&gt; in connection order; video soundtracks receive audio numbers first.</p></div></div><div className="guide-limits">{usingPdmd && <><h3>{PDMD_PROFILE.name} · sampling notes</h3>{PDMD_PROFILE.notes.map(note => <p key={note}>{note}</p>)}<div className="guide-sources">{PDMD_PROFILE.sources.map(source => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>{source.title} <ArrowRight size={12}/></a>)}</div></>}<h3>{feature.title} · workflow notes</h3>{feature.notes.length ? feature.notes.map(note => <p key={note}>{note}</p>) : <p>The stock H3 workflow samples joint video and audio latents, then decodes both into a 24 fps video.</p>}<p>Requested duration rounds up to H3's 5 + 17n frame grid. Reference video and audio clips must be 2–15 seconds each, with at most 15 seconds per kind. Use HTTPS media URLs for larger files; RunPod async JSON is limited to 10 MB.</p><div className="guide-sources">{feature.sources.map(source => <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>{source.title} <ArrowRight size={12}/></a>)}</div></div><div className="import-section"><Code2 size={22}/><div><h3>Have your own workflow?</h3><p>pDMD fast is built into the FL2VA sampling profiles and uses standard PyTorch attention by default for the INT8 checkpoints. Import an API-format graph for another custom workflow; the request inspector lets you review the complete payload and any declared overrides.</p></div><button className="small-button" onClick={() => importRef.current?.click()}><Upload size={14}/> Import JSON</button></div><p className="modal-footnote">These tools use MiniMax H3 open weights and the node packs in your repository. Hosted H3 Max endpoints are separate. Generative reference edits and audio guidance depend on the model.</p></div>}
    </dialog>
    {toast && <div className="toast" role="status"><Check size={16}/>{toast}</div>}
  </div>;
}

