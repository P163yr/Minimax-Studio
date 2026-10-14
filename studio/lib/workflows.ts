import { getFeatureLoraMetadata, getRecommendedFeatureLora } from "./inventory";
/** API prompts verified against ComfyUI v0.38.2 and the packs installed by Minimax-Studio. */
export type MediaKind = "image" | "video" | "audio";
export type ModelFamily = "fl2va" | "ref2va";
export type FeatureId = "text-to-video" | "image-to-video" | "last-frame" | "first-last-frame" | "reference-to-video" | "video-edit" | "motion-transfer" | "character-swap" | "style-transfer" | "voice-reference" | "audio-to-video" | "keyframes" | "extend-video" | "photo-edit" | "character-sheet" | "scene-coverage" | "camera-motion" | "union-controlnet" | "relight" | "latent-upscale";
export interface MediaSlot { role: string; label: string; kind: MediaKind; required: boolean; max: number }
export interface Feature { id: FeatureId; title: string; description: string; color: string; icon: string; media: MediaSlot[]; modelFamily: ModelFamily; status: "ready" | "requires-model"; output: "video" | "image"; notes: string[]; sources: { title: string; url: string }[] }
export interface MediaFile { role: string; name: string; mime_type?: string; mimeType?: string; data?: string; url?: string; frame_idx?: number; duration?: number; hasAudio?: boolean }
export type WorkflowLink = [string, number];
export interface WorkflowNode { class_type: string; inputs: Record<string, unknown>; _meta?: { title: string } }
export type Workflow = Record<string, WorkflowNode>;
export interface BuildConfig {
  feature: FeatureId | string;
  prompt: string;
  duration: number;
  aspectRatio: string;
  megapixels: number;
  seed: number;
  steps: number;
  model?: string;
  lora?: string;
  clip?: string;
  videoVae?: string;
  audioVae?: string;
  files?: MediaFile[];
  extras?: {
    audio?: boolean; loraStrength?: number; refImageSize?: "match" | "max";
    shiftVideo?: number; shiftAudio?: number; scheduler?: string; sampler?: string;
    denoise?: number; guideFrame?: number; includeVideoAudio?: boolean;
    loras?: {name: string; strength: number}[]; controlStrength?: number;
    upscaleScale?: number; upscaler?: string;
    lightAzimuth?: number; lightElevation?: number; lightIntensity?: number; lightKelvin?: number;
    attention?: "pytorch attention" | "comfy kitchen attention";
    featureLora?: {name:string;strength:number;enabled:boolean};
  };
}
export interface RunpodRequest { input: { workflow: Workflow; files: MediaFile[]; parameters: {seed:number;duration_seconds:number;fps:24;steps:number} } }
export const DEFAULT_MODELS = {
  fl2va: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
  ref2va: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  suggestedRef2va: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
  clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
  videoVae: "minimax_h3_video_vae_int8_convrot.safetensors",
  audioVae: "minimax_h3_audio_vae_fp32.safetensors",
  fl2vaLora: "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors",
  ref2vaLora: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
};
export const PDMD_LORA = "minimax_h3_pdmd_4nfe_comfyui_v6.safetensors";
export const PDMD_PROFILE = {
  id:"pdmd-4", name:"pDMD · 4 steps", steps:4, sampler:"euler", scheduler:"simple",
  shiftVideo:12, shiftAudio:3, loraStrength:1, denoise:1, attention:"pytorch attention",
  fixed:true, modelFamily:"fl2va",
  notes:["Sampling follows your mini-fast 4-step T2V/I2V graphs: Euler, simple, video/audio shifts 12/3, adapter strength 1 and BasicGuider without CFG.","Standard attention is the default for your pruned INT8 models. ComfyKitchen remains an optional backend matching the mini-fast graph; ComfyUI warns of INT8 alignment failures on some builds.","The upstream pDMD model targets the base T2VA transformer. Your mini-fast graph supplies the I2V adaptation; other FL2VA conditioning modes reuse that recipe without a quality benchmark. REF2VA is incompatible."],
  sources:[{title:"Your working pDMD T2V graph",url:"https://github.com/P163yr/mini-fast/blob/main/Step%204%20T2V.txt"},{title:"Your working pDMD I2V graph",url:"https://github.com/P163yr/mini-fast/blob/main/Step%204%20I2V.txt"},{title:"pDMD conversion and usage",url:"https://huggingface.co/Iwannapose/minimax_h3_pdmd_4nfe_comfyui"},{title:"Official pDMD task support",url:"https://github.com/ZeamoxWang/pdmd"}],
} as const;
const CORE = { title: "ComfyUI H3 nodes · v0.38.2", url: "https://github.com/Comfy-Org/ComfyUI/blob/v0.38.2/comfy_extras/nodes_minimax_h3.py" };
const REFERENCE = { title: "Official reference workflow", url: "https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_r2v.json" };
const EDIT = { title: "H3 Edit node schemas", url: "https://github.com/ethanfel/ComfyUI-MiniMax-H3-Edit/blob/main/h3edit/nodes.py" };
const EXTENSION = { title: "H3 preserved AV extension", url: "https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef/blob/main/existing_video_extension.py" };
const TURBO = {title:"LightX2V sampler and shift specifications",url:"https://github.com/ModelTC/Minimax-H3-Turbo"};
const T2V = {title:"Official text-to-video workflow",url:"https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_t2v.json"};
const I2V = {title:"Official first / last-frame workflow",url:"https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_i2v.json"};
const slot = (role: string, label: string, kind: MediaKind, required = false, max = 1): MediaSlot => ({role,label,kind,required,max});
const first = slot("first_frame", "First frame", "image", true);
const last = slot("last_frame", "Last frame", "image", true);
const refImages = slot("reference_image", "Reference images", "image", false, 9);
const refVideos = slot("reference_video", "Reference videos", "video", false, 3);
const refAudios = slot("reference_audio", "Reference audio", "audio", false, 3);
const sourceVideo = slot("source_video", "Source video", "video", true);
const sourceImage = slot("source_image", "Source image", "image", true);
const refNote = "Uses the REF2VA checkpoint from your model inventory; reference conditioning uses separate weights from the FL2VA path.";
const tagNote = "Native prompt tags are <Picture 1>, <Video 1>, <Audio 1> in connection order. Video soundtrack references receive audio ordinals before standalone audio.";
function feature(id: FeatureId, title: string, description: string, color: string, icon: string, media: MediaSlot[], modelFamily: ModelFamily = "fl2va", notes: string[] = [], sources = [CORE], output: "video" | "image" = "video"): Feature {
  return {id,title,description,color,icon,media,modelFamily,status:"ready",output,notes:[...(modelFamily === "ref2va" ? [refNote] : []),...notes],sources};
}
export const FEATURES: Feature[] = [
  feature("text-to-video", "Text to video", "Turn an idea into a film with native sound.", "#dbf7cc", "sparkles", []),
  feature("image-to-video", "Image to video", "Give your first frame movement and sound.", "#ffe4b4", "image", [first]),
  feature("last-frame", "End on a frame", "Build a scene that arrives at your final image.", "#f6d9f3", "flag", [last]),
  feature("first-last-frame", "First + last frame", "Connect two moments with a generated scene.", "#dbd7fb", "frames", [first,last]),
  feature("reference-to-video", "Reference mix", "Combine characters, scenes, motion and audio.", "#cdeafa", "layers", [refImages,refVideos,refAudios], "ref2va", [tagNote,"Up to 9 images, 3 videos, 3 audio clips and 12 total files. Video and audio references are each 2–15 seconds, at most 15 seconds per kind."], [CORE,REFERENCE]),
  feature("video-edit", "Video edit", "Reimagine a clip with a precise instruction.", "#ffdddb", "scissors", [sourceVideo,refImages,refAudios], "ref2va", ["Prompt-guided REF2VA edit. Describe what to change in <Video 1> and what to preserve; pixels and timing are not guaranteed exact.",tagNote], [CORE,REFERENCE]),
  feature("motion-transfer", "Motion transfer", "Bring a reference performance to a new subject.", "#d8f2df", "move", [slot("reference_image","New subject","image",true),sourceVideo,refAudios], "ref2va", ["Assign identity to <Picture 1> and motion / camera / timing to <Video 1>. This is generative reference conditioning.",tagNote], [CORE,REFERENCE]),
  feature("character-swap", "Character swap", "Cast a new character in an existing scene.", "#ffe7b9", "users", [slot("reference_image","New character","image",true),sourceVideo,refAudios], "ref2va", ["Use <Picture 1> for the replacement character and <Video 1> for the scene, performance and camera.",tagNote], [CORE,REFERENCE]),
  feature("style-transfer", "Style transfer", "Give an existing clip a new visual language.", "#ede0ff", "palette", [slot("reference_image","Style reference","image",true),sourceVideo,refAudios], "ref2va", ["Describe the style from <Picture 1> and the scene / motion from <Video 1>.",tagNote], [CORE,REFERENCE]),
  feature("voice-reference", "Voice + audio", "Guide a scene with a voice or sound reference.", "#d4eeee", "mic", [refImages,refVideos,slot("reference_audio","Voice / audio reference","audio",true,3)], "ref2va", ["Reference audio guides voice, music or effects; it is not a guaranteed exact voice clone or lip-sync service.",tagNote], [CORE,REFERENCE]),
  feature("audio-to-video", "Audio performance", "Anchor a soundtrack and generate a performance.", "#ffcfe0", "music", [slot("first_frame","First frame / performer","image"),slot("source_audio","Performance audio","audio",true)], "fl2va", ["MiniMaxH3AddGuide anchors uploaded audio at frame 0. Audio is cropped to the generated duration. Describe the visible speech / singing performance; exact lip sync depends on the model."]),
  feature("keyframes", "Keyframe story", "Place image guides along a short visual timeline.", "#d2e9fc", "film", [slot("first_frame","First frame","image"),slot("guide_image","Intermediate guides","image",true,3),slot("last_frame","Last frame","image")], "fl2va", ["Guide images use MiniMaxH3AddGuide at explicit frame_idx (zero based), or are evenly spaced through the video. First / last frames remain optional."]),
  feature("extend-video", "Continue a clip", "Carry an existing clip into its next moment.", "#f6edc5", "arrow-right", [sourceVideo,slot("source_audio","Separate source soundtrack","audio")], "fl2va", ["Installed Motion Context extension preserves a 39-frame source tail with AV masks, samples the continuation, trims the overlap from both streams and assembles the original source with the new clip.","Source needs at least 39 frames at 24 fps and audio, or a separately uploaded soundtrack. The loader normalizes frame rate. Duration controls the new section and rounds up after adding the 39-frame context.","Requires the installed Motion Context pack and H3 AV-mask compatibility. This is an open-weight extension, not the H3 Max hosted extension endpoint."], [CORE,EXTENSION]),
  feature("photo-edit", "Photo edit", "Make a focused edit to a single image.", "#f8d5c0", "wand", [sourceImage,slot("reference_image","Optional visual guide","image")], "fl2va", ["Installed H3 Edit uses a five-frame context and selects one stable decoded image. This is a still-image extension, distinct from video editing."], [CORE,EDIT], "image"),
  feature("character-sheet", "Character sheet", "See one character in six calibrated views.", "#e2dbfa", "grid", [sourceImage,slot("reference_image","Optional character guide","image")], "ref2va", ["Installed H3 Edit generates one 124-frame orbit and decodes a six-view contact sheet. The source is a native REF2VA identity reference."], [CORE,EDIT], "image"),
  feature("scene-coverage", "Scene coverage", "Explore a frozen scene through twelve views.", "#d7ecd2", "camera", [sourceImage,slot("reference_image","Optional scene guide","image")], "fl2va", ["Installed H3 Edit compiles a 124-frame frozen-scene camera path and returns a contact sheet with selected viewpoints."], [CORE,EDIT], "image"),
  feature("camera-motion", "Camera direction", "Shape a shot with cinematic camera movement.", "#cbeaf4", "camera", [slot("first_frame","Optional first frame","image")], "fl2va", ["Stacks your installed camera_motion_h3_lora_v1_3000_pruned adapter with the selected sampling LoRA. Describe the camera move in the prompt. Open-weight guidance differs from H3 Max's dedicated camera-control endpoint."]),
  feature("union-controlnet", "Structure control", "Guide motion with a pose, edge or depth clip.", "#eed7d0", "scan", [slot("control_video","Prepared control video","video",true),slot("first_frame","Optional first frame","image")], "fl2va", ["Uses your Fun ControlNet Union 2.0 model patch and the native MiniMaxH3FunControlNetApply node. Upload a prepared pose, depth, edge or other compatible control sequence; this workflow does not run an external preprocessor.","Install the Union file under models/model_patches as configured by your worker. Frames are normalized to 24 fps, fitted to the output canvas and extended to the output length."], [CORE,{title:"ComfyUI model patch loader",url:"https://github.com/Comfy-Org/ComfyUI/blob/v0.38.2/comfy_extras/nodes_model_patch.py"}]),
  feature("relight", "Relight an image", "Design a fresh light while preserving your scene.", "#fff0bd", "sun", [sourceImage], "fl2va", ["The installed Relight controller renders a lighting sphere, compiles a prompt and supplies H3 Edit options. A 39-frame anchored settle returns one image; direction and intensity remain generative guidance."], [EDIT,{title:"H3 Relight controller",url:"https://github.com/NyckM/H3-Relight-Minimax-ComfyUI/blob/main/relight.py"}], "image"),
  feature("latent-upscale", "Neural upscale", "Render a clip, then enlarge its video latent.", "#dedafa", "maximize", [slot("first_frame","Optional first frame","image")], "fl2va", ["Samples at the chosen base resolution, then uses your 3D latent upscaler through FL's native AV wrapper. Video dimensions grow by the upscale factor; timing and the original audio latent are preserved. This is learned latent enlargement without a second diffusion refinement pass.","Uses minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors from models/latent_upscale_models. The raw LBH upscaler expects a video-only tensor; the FL wrapper preserves the joint H3 AV structure."], [CORE,{title:"FL native H3 neural upscaler",url:"https://github.com/filliptm/ComfyUI-FL-MiniMaxH3/blob/main/nodes/FL_MiniMaxH3NeuralLatentUpscale.py"}]),
];

export interface SamplingProfile {
  id:string; name:string; steps:number; sampler:string; scheduler:string; shiftVideo:number; shiftAudio:number;
  loraStrength:number; denoise:number; fixed:boolean; modelFamily:ModelFamily | "any";
  notes:readonly string[]; sources:readonly {title:string;url:string}[];
}
/** Source-backed defaults. Explicit non-pDMD sampler overrides remain available. */
export function getSamplingProfile(lora: string | undefined, family: ModelFamily = "fl2va"): SamplingProfile {
  const filename=lora ?? (family === "ref2va" ? DEFAULT_MODELS.ref2vaLora : DEFAULT_MODELS.fl2vaLora);
  if(filename === PDMD_LORA) return PDMD_PROFILE;
  const shared={shiftAudio:3,loraStrength:1,denoise:1,fixed:false,scheduler:"simple"};
  if(filename === DEFAULT_MODELS.ref2vaLora) return {...shared,id:"ref2va-turbo-4",name:"REF2VA Turbo · 4 steps",steps:4,sampler:"euler",shiftVideo:12,modelFamily:"ref2va",notes:["The adapter author's reference graph uses Euler / simple, 4 steps and shifts 12/3. Use match reference sizing to follow its training policy."],sources:[TURBO,REFERENCE]};
  if(filename === "minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors") return {...shared,id:"fl2va-turbo-4-768p",name:"FL2VA 768p Turbo · 4 steps",steps:4,sampler:"euler",shiftVideo:6,modelFamily:"fl2va",notes:["The 768p 4-step adapter was trained with video shift 6, audio shift 3; it needs that model-sampling patch rather than the base 12/3 shift."],sources:[TURBO,I2V]};
  if(filename === DEFAULT_MODELS.fl2vaLora) return {...shared,id:"fl2va-turbo-8",name:"FL2VA Turbo · 8 steps",steps:8,sampler:"res_multistep",shiftVideo:12,modelFamily:"fl2va",notes:["Matches your working mini-fast 8-step res_multistep / simple graph. The adapter author's Euler / simple alternative is available with an explicit sampler override."],sources:[{title:"Your working FL2VA 8-step graph",url:"https://github.com/P163yr/mini-fast/blob/main/Step%208%20T2V.txt"},TURBO,T2V]};
  return {...shared,id:"base",name:"Base model · 20 steps",steps:20,sampler:"res_multistep",shiftVideo:12,modelFamily:"any",notes:["Official ComfyUI base workflow: res_multistep / simple at 20 steps. Reference-heavy scenes can use 25 steps for fidelity."],sources:[T2V,REFERENCE]};
}
export function recommendedSteps(lora: string | undefined, family: ModelFamily = "fl2va"): number {
  return getSamplingProfile(lora,family).steps;
}

// Every catalog recipe links to its actual conditioning / sampling example.
for(const item of FEATURES) {
  if(item.id === "text-to-video") item.sources.push(T2V);
  if(["image-to-video","last-frame","first-last-frame","camera-motion"].includes(item.id)) item.sources.push(I2V);
  if(item.id === "audio-to-video" || item.id === "keyframes") item.sources.push({title:"Native guide / custom keyframes example",url:"https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef/blob/main/example_workflows/UTILITY%20-%20Custom%20Keyframes.json"});
  if(item.id === "extend-video") item.sources.push({title:"Installed AV extension example",url:"https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef/blob/main/example_workflows/NEW%20-%20AV%20Extension.json"});
  if(item.id === "photo-edit") item.sources.push({title:"H3 Edit mixed-reference example",url:"https://github.com/ethanfel/ComfyUI-MiniMax-H3-Edit/blob/main/example_workflows/H3_Edit_Mixed_References.json"});
  if(item.id === "character-sheet") item.sources.push({title:"H3 six-view character sheet example",url:"https://github.com/ethanfel/ComfyUI-MiniMax-H3-Edit/blob/main/example_workflows/H3_Character_Sheet_6_Panel.json"});
  if(item.id === "scene-coverage") item.sources.push({title:"H3 frozen scene camera-path example",url:"https://github.com/ethanfel/ComfyUI-MiniMax-H3-Edit/blob/main/example_workflows/H3_Empty_Drawing_Studio_15s_Travel.json"});
  if(item.output === "video") item.notes.push("Sampling follows the selected adapter's source-backed profile. Base mode recommends 20 steps; reference-heavy base generation can use 25. These recipes have structural checks, not a comparative GPU quality benchmark.");
}

export function getFeature(id: string): Feature {
  const selected = FEATURES.find(item => item.id === id);
  if (!selected) throw new Error(`Unknown feature: ${id}`);
  return selected;
}
export function framesForDuration(seconds: number, fps = 24): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || fps !== 24) throw new Error("H3 requires a positive duration at 24 fps.");
  const desired = Math.max(5,Math.round(seconds * fps));
  return 5 + 17 * Math.ceil((desired - 5) / 17);
}
export function dimensionsForRatio(aspectRatio: string, megapixels: number): {width:number;height:number} {
  const matched = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/.exec(aspectRatio);
  if (!matched) throw new Error("Choose an aspect ratio such as 16:9 or 9:16.");
  const ratio = Number(matched[1]) / Number(matched[2]);
  if (!Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(megapixels) || megapixels < 0.1 || megapixels > 4.5) throw new Error("Resolution must be between 0.1 and 4.5 megapixels.");
  return {width:Math.max(32,Math.round(Math.sqrt(megapixels * 1e6 * ratio)/32)*32),height:Math.max(32,Math.round(Math.sqrt(megapixels * 1e6 / ratio)/32)*32)};
}
function safetensors(value: string, label: string): string {
  if (!value.trim() || !value.endsWith(".safetensors")) throw new Error(`${label} must be the exact installed .safetensors filename.`);
  if (/h3[\s_-]*max/i.test(value)) throw new Error("This Studio supports MiniMax H3 open weights; H3 Max is a different hosted model.");
  return value.trim();
}
function canonicalFiles(files: MediaFile[], selected: Feature): MediaFile[] {
  const slots = new Map(selected.media.map(s=>[s.role,s]));
  for (const s of selected.media) {
    const matching = files.filter(f=>f.role === s.role);
    if(s.required && matching.length === 0) throw new Error(`Upload ${s.label.toLowerCase()} to use ${selected.title}.`);
    if(matching.length > s.max) throw new Error(`${s.label} accepts up to ${s.max} file${s.max === 1 ? "" : "s"}.`);
  }
  if(selected.modelFamily === "ref2va" && files.length > 12) throw new Error("Use at most 12 reference files in one generation.");
  if(selected.id === "reference-to-video" && !files.length) throw new Error("Upload at least one image, video or audio reference.");
  for (const kind of ["video","audio"] as const) {
    const durations = files.filter(f=>slots.get(f.role)?.kind === kind && f.duration != null).map(f=>f.duration!);
    if(selected.modelFamily === "ref2va" && (durations.some(d=>d<2||d>15) || durations.reduce((a,b)=>a+b,0)>15.01)) throw new Error(`Reference ${kind} clips must be 2–15 seconds each and at most 15 seconds combined.`);
  }
  // Ordering also drives the enhanced handler's deterministic media-role binding.
  return selected.media.flatMap(s=>files.filter(f=>f.role===s.role)).map((file,index)=>{
    const s = slots.get(file.role);
    if(!s) throw new Error(`Media role ${file.role} is not used by ${selected.title}.`);
    const mime = file.mime_type || file.mimeType || `${s.kind}/${s.kind === "image" ? "png" : s.kind === "video" ? "mp4" : "wav"}`;
    if(!mime.startsWith(`${s.kind}/`)) throw new Error(`${s.label} needs a ${s.kind} file.`);
    if(!file.data && !file.url) throw new Error(`${file.name || s.label} needs uploaded data or an HTTPS URL.`);
    if(file.url && !/^https:\/\//i.test(file.url)) throw new Error("Remote media URLs must use HTTPS.");
    const raw = file.name.replace(/^.*[\\/]/,"").replace(/[^A-Za-z0-9._-]+/g,"_") || "upload";
    return {...file,name:`${String(index+1).padStart(2,"0")}_${file.role}_${raw}`,mime_type:mime};
  });
}

export function buildRequest(config: BuildConfig): RunpodRequest {
  const selected = getFeature(config.feature);
  if(!config.prompt.trim()) throw new Error("Describe the scene or edit before generating.");
  if(config.prompt.length > 7000) throw new Error("Keep the prompt at or below 7,000 characters.");
  if(!Number.isSafeInteger(config.seed) || config.seed < 0) throw new Error("Seed must be a nonnegative safe integer.");
  if(!Number.isInteger(config.steps) || config.steps < 1 || config.steps > 100) throw new Error("Sampling steps must be between 1 and 100.");
  if(selected.output === "video" && (!Number.isFinite(config.duration) || config.duration < 5 || config.duration > 15)) throw new Error("Choose a video duration from 5 to 15 seconds.");
  const extras = config.extras || {};
  const model = config.model || DEFAULT_MODELS[selected.modelFamily];
  if(!model && selected.modelFamily === "ref2va") throw new Error(`Confirm your installed REF2VA checkpoint filename. Suggested filename: ${DEFAULT_MODELS.suggestedRef2va}`);
  safetensors(model,"Diffusion model");
  if(selected.modelFamily === "ref2va" && /fl2v/i.test(model)) throw new Error("This feature requires REF2VA weights. FL2VA weights are for text and keyframe generation.");
  if(selected.modelFamily === "fl2va" && /ref2v/i.test(model)) throw new Error("This feature requires FL2VA weights. REF2VA weights are for reference conditioning.");
  const lora = config.lora ?? (selected.output === "image" ? "" : selected.modelFamily === "fl2va" ? DEFAULT_MODELS.fl2vaLora : DEFAULT_MODELS.ref2vaLora);
  const recommendedFeature=getRecommendedFeatureLora(selected.id);
  const featureLora=extras.featureLora ?? (recommendedFeature ? {name:recommendedFeature.name,strength:recommendedFeature.strength,enabled:true} : undefined);
  const featureMetadata=featureLora?.enabled ? getFeatureLoraMetadata(featureLora.name) : null;
  if(featureLora?.enabled && !featureMetadata) throw new Error("Choose a documented Feature LoRA. Unverified inventory adapters can be added through the optional extra stack.");
  if(featureMetadata && featureMetadata.modelFamily !== "any" && featureMetadata.modelFamily !== selected.modelFamily) throw new Error(`${featureMetadata.label} requires ${featureMetadata.modelFamily.toUpperCase()} weights and cannot be used with this feature's ${selected.modelFamily.toUpperCase()} model.`);
  const candidates=[...(lora ? [{name:lora,strength:extras.loraStrength ?? 1,role:"speed"}] : []),...(featureLora?.enabled ? [{name:featureLora.name,strength:featureLora.strength,role:"feature"}] : []),...(extras.loras || []).map(adapter=>({...adapter,role:"extra"}))];
  // Keep the explicit Feature / Speed selection authoritative if an extra repeats it.
  const loras=candidates.filter((adapter,index)=>candidates.findIndex(item=>item.name === adapter.name) === index);
  const distillationFiles=new Set([PDMD_LORA,DEFAULT_MODELS.fl2vaLora,DEFAULT_MODELS.ref2vaLora,"minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"]);
  if(new Set(loras.filter(adapter=>distillationFiles.has(adapter.name)).map(adapter=>adapter.name)).size > 1) throw new Error("Use one sampling adapter: pDMD or one Turbo LoRA. Creative adapters may be added separately.");
  const isPdmd=loras.some(adapter=>adapter.name === PDMD_LORA);
  if(isPdmd && selected.modelFamily === "ref2va") throw new Error("pDMD supports the base FL2VA / text-to-video transformer. REF2VA needs its matching reference Turbo adapter or base sampling.");
  if(isPdmd) for(const adapter of loras) if(adapter.name === PDMD_LORA) adapter.strength=PDMD_PROFILE.loraStrength;
  const sampling=getSamplingProfile(loras.find(adapter=>distillationFiles.has(adapter.name))?.name || lora || "",selected.modelFamily);
  const effectiveSteps=isPdmd ? PDMD_PROFILE.steps : config.steps;
  const activeMetadata=loras.map(adapter=>getFeatureLoraMetadata(adapter.name)).filter(item=>item !== null);
  for(const metadata of activeMetadata) if(metadata.modelFamily !== "any" && metadata.modelFamily !== selected.modelFamily) throw new Error(`${metadata.label} is documented for ${metadata.modelFamily.toUpperCase()}, not ${selected.modelFamily.toUpperCase()}.`);
  const loadedLoras=new Set<string>();
  for(const adapter of loras) {
    safetensors(adapter.name,"LoRA");
    if(loadedLoras.has(adapter.name)) throw new Error(`LoRA ${adapter.name} appears twice. Load each adapter once.`);
    loadedLoras.add(adapter.name);
    if(!Number.isFinite(adapter.strength) || adapter.strength < -2 || adapter.strength > 2) throw new Error("LoRA strengths must be between -2 and 2.");
    if(selected.modelFamily === "ref2va" && /fl2v/i.test(adapter.name)) throw new Error("Select a REF2VA-compatible LoRA or disable LoRA for this feature.");
    if(selected.modelFamily === "fl2va" && /ref2v/i.test(adapter.name)) throw new Error("Select a FL2VA-compatible LoRA or disable LoRA for this feature.");
    if(/pdmd/i.test(adapter.name) && adapter.name !== PDMD_LORA) throw new Error("Select the verified pDMD v6 ComfyUI adapter from your model inventory.");
  }
  const files = canonicalFiles(config.files || [],selected);
  // Reject unknown roles before canonicalFiles orders them; do not silently drop uploads.
  if(files.length !== (config.files || []).length) throw new Error("One or more uploaded files use a role that this feature does not accept.");
  const usesAlignedGuide=activeMetadata.some(metadata=>metadata.sourceGuide);
  const sourceGuideFile=usesAlignedGuide ? files.find(file=>file.role === "source_video") || files.find(file=>file.role === "reference_video") : undefined;
  if(usesAlignedGuide && !sourceGuideFile) throw new Error("This Feature LoRA requires a source video for its frame-aligned guide workflow.");
  const length = framesForDuration(selected.id === "extend-video" ? config.duration + 39/24 : config.duration);
  let finalPrompt=config.prompt.trim();
  const triggers=[...new Set(activeMetadata.map(metadata=>metadata.trigger).filter((trigger):trigger is string=>Boolean(trigger)))];
  // Task triggers come before optional visual-style triggers when adapters are stacked.
  triggers.sort((a,b)=>Number(a === "r34l1sm") - Number(b === "r34l1sm"));
  for(const trigger of [...triggers].reverse()) if(!finalPrompt.toLowerCase().startsWith(trigger.toLowerCase())) finalPrompt=`${trigger}${trigger.endsWith(":") ? " " : ", "}${finalPrompt}`;
  const {width,height} = dimensionsForRatio(config.aspectRatio,config.megapixels);
  const workflow: Workflow = {};
  const add = (id: string,class_type: string,inputs: Record<string,unknown>,title?: string): WorkflowLink => {
    workflow[id] = {class_type,inputs,...(title?{_meta:{title}}:{})}; return [id,0];
  };
  let activeModel = add("1","UNETLoader",{unet_name:model,weight_dtype:"default"});
  const clip = add("2","CLIPLoader",{clip_name:safetensors(config.clip || DEFAULT_MODELS.clip,"Text encoder"),type:"minimax",device:"default"});
  const videoVae = add("3","VAELoader",{vae_name:safetensors(config.videoVae || DEFAULT_MODELS.videoVae,"Video VAE")});
  const audioVae = add("4","VAELoader",{vae_name:safetensors(config.audioVae || DEFAULT_MODELS.audioVae,"Audio VAE")});
  for(let i=0;i<loras.length;i++) activeModel = add(loras[i].role === "speed" ? "1b" : loras[i].role === "feature" ? "feature-lora" : `lora-${i}`,"LoraLoaderModelOnly",{model:activeModel,lora_name:loras[i].name,strength_model:loras[i].strength});
  if(isPdmd || sampling.id !== "base" || extras.shiftVideo !== undefined || extras.shiftAudio !== undefined) activeModel = add("1d","MiniMaxH3SigmaShift",{model:activeModel,shift_video:isPdmd ? PDMD_PROFILE.shiftVideo : extras.shiftVideo ?? sampling.shiftVideo,shift_audio:isPdmd ? PDMD_PROFILE.shiftAudio : extras.shiftAudio ?? sampling.shiftAudio});
  if(isPdmd || extras.attention) activeModel=add("1c","ModelAttentionBackend",{model:activeModel,attention:extras.attention || PDMD_PROFILE.attention});
  const byRole = (role:string) => files.filter(f=>f.role===role);
  const fileLinks = new Map<MediaFile,WorkflowLink>();
  let mediaId = 100;
  for(const file of files) {
    const kind = selected.media.find(s=>s.role===file.role)!.kind;
    const id = String(mediaId++);
    const title = file.role === "source_image" ? "source image" : file.role.replace(/_/g," ");
    if(kind === "image") fileLinks.set(file,add(id,"LoadImage",{image:file.name},title));
    else if(kind === "audio") fileLinks.set(file,add(id,"LoadAudio",{audio:file.name},title));
    else fileLinks.set(file,add(id,"VHS_LoadVideo",{video:file.name,force_rate:24,custom_width:0,custom_height:0,frame_load_cap:selected.id === "extend-video" ? 0 : file === sourceGuideFile ? Math.min(length,360) : 360,skip_first_frames:0,select_every_nth:1,format:selected.id === "extend-video" ? "None" : "H3"},title));
  }
  const firstLink = (role:string): WorkflowLink | undefined => byRole(role)[0] ? fileLinks.get(byRole(role)[0]) : undefined;
  const videoAudio = (file:MediaFile): WorkflowLink => [fileLinks.get(file)![0],2];
  if(selected.id === "union-controlnet") {
    const strength=extras.controlStrength ?? 1;
    if(!Number.isFinite(strength) || strength < 0 || strength > 2) throw new Error("Control strength must be between 0 and 2.");
    const patch=add("control-model","ModelPatchLoader",{name:"minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors"});
    activeModel=add("control-apply","MiniMaxH3FunControlNetApply",{model:activeModel,model_patch:patch,vae:videoVae,strength,start_percent:0,end_percent:1,control_video:firstLink("control_video")});
  }
  let conditioning: WorkflowLink;
  let latent: WorkflowLink;
  if(selected.output === "image") {
    const role = selected.id === "character-sheet" ? "generate | native Picture 1 (REF2VA)" : "edit | strong scene anchor (FL2VA)";
    const encoderInputs: Record<string,unknown> = {clip,vae:videoVae,source_image:firstLink("source_image"),prompt:finalPrompt,primary_image_role:role,reference_mode:"semantic (Qwen only)",width,height,source_fit:"crop center",prompt_mode:selected.id === "scene-coverage" ? "directed | frozen scene coverage" : "edit instruction",semantic_resolution:1024,native_reference_size:"match output area",quality_profile:selected.id === "character-sheet" ? "character sheet | 6 panels / 124-frame orbit" : selected.id === "scene-coverage" ? "scene coverage | 124-frame camera path" : "recommended | 5-frame context -> 1 image"};
    if(firstLink("reference_image")) encoderInputs.reference_image=firstLink("reference_image");
    if(selected.id === "scene-coverage") Object.assign(encoderInputs,{coverage_views:12,coverage_arc_degrees:360,coverage_direction:"clockwise / camera right",coverage_hold_frames:5,coverage_loop_closure:true});
    if(selected.id === "relight") {
      const azimuth=extras.lightAzimuth ?? 45,elevation=extras.lightElevation ?? 35,intensity=extras.lightIntensity ?? 60,kelvin=extras.lightKelvin ?? 5600;
      if(!Number.isFinite(azimuth)||azimuth < -180||azimuth > 180||!Number.isFinite(elevation)||elevation < -90||elevation > 90||!Number.isFinite(intensity)||intensity < 10||intensity > 100||!Number.isInteger(kelvin)||kelvin < 1000||kelvin > 10000) throw new Error("Lighting needs azimuth -180–180, elevation -90–90, intensity 10–100 and Kelvin 1,000–10,000.");
      const relight=add("relight","H3RelightEditor",{lighting:JSON.stringify({version:1,preset:null,lights:[{type:"rectAreaLight",intensity,azimuth,elevation,colorMode:"kelvin",color:"#ffffff",kelvin}],background:"default",effect:"default"}),runtime_task:"directed | 39-frame settle",instruction:finalPrompt,image:firstLink("source_image"),subject:"auto",relight_strength:"balanced",light_reference:"semantic sphere (Picture 2)",ball_style:"sphere (MiniMax)"});
      Object.assign(encoderInputs,{compiled_prompt:relight,options:["relight",1],reference_image:["relight",2],quality_profile:"directed change | 39-frame settle -> 1 image"});
    }
    conditioning=add("6","TextEncodeH3Edit",encoderInputs); latent=["6",1];
  } else if(selected.modelFamily === "ref2va") {
    const inputs: Record<string,unknown> = {clip,vae:videoVae,audio_vae:audioVae,prompt:finalPrompt,width,height,length,ref_image_size:extras.refImageSize || "match"};
    byRole("reference_image").forEach((f,i)=>inputs[`ref_images.ref_image_${i}`]=fileLinks.get(f));
    const videos = [...byRole("source_video"),...byRole("reference_video")].filter(file=>file !== sourceGuideFile);
    videos.forEach((f,i)=>{inputs[`ref_videos.ref_video_${i}`]=fileLinks.get(f);if(extras.includeVideoAudio && f.hasAudio !== false) inputs[`ref_video_audios.ref_video_audio_${i}`]=videoAudio(f);});
    byRole("reference_audio").forEach((f,i)=>inputs[`ref_audios.ref_audio_${i}`]=fileLinks.get(f));
    conditioning=add("6","MiniMaxH3ReferenceToVideo",inputs); latent=["6",1];
    if(sourceGuideFile) conditioning=add("feature-guide","MiniMaxH3AddGuide",{positive:conditioning,latent,vae:videoVae,image:fileLinks.get(sourceGuideFile),frame_idx:0,...(extras.includeVideoAudio && sourceGuideFile.hasAudio !== false ? {audio_vae:audioVae,audio:videoAudio(sourceGuideFile)} : {})});
  } else {
    const inputs: Record<string,unknown> = {clip,vae:videoVae,prompt:finalPrompt,width,height,length};
    if(firstLink("first_frame")) inputs.first_frame=firstLink("first_frame");
    if(firstLink("last_frame")) inputs.last_frame=firstLink("last_frame");
    conditioning=add("6","MiniMaxH3ImageToVideo",inputs);latent=["6",1];
    const guides=byRole("guide_image");
    for(let i=0;i<guides.length;i++) {
      const frame_idx=guides[i].frame_idx ?? extras.guideFrame ?? Math.round((i+1)*((length-1)/(guides.length+1)));
      if(!Number.isInteger(frame_idx) || frame_idx <= 0 || frame_idx >= length-1) throw new Error(`Guide ${i+1} must be at an intermediate frame between 1 and ${length-2}.`);
      conditioning=add(`guide-${i}`,"MiniMaxH3AddGuide",{positive:conditioning,latent,vae:videoVae,image:fileLinks.get(guides[i]),frame_idx});
    }
    if(selected.id === "audio-to-video") conditioning=add("guide-audio","MiniMaxH3AddGuide",{positive:conditioning,latent,audio_vae:audioVae,audio:firstLink("source_audio"),frame_idx:0});
    if(selected.id === "extend-video") {
      const source=byRole("source_video")[0];
      if(source.hasAudio === false && !firstLink("source_audio")) throw new Error("A silent source needs a separate source soundtrack for preserved AV continuation.");
      latent=add("extension-context","MiniMaxH3ExistingVideoMaskedContext",{latent,vae:videoVae,audio_vae:audioVae,source_frames:fileLinks.get(source),source_audio:firstLink("source_audio") || videoAudio(source),source_fps:24,context_length:39,crop:"center",audio_feather_ticks:8,insert_frame:0});
    }
  }
  const stillDirected=selected.output === "image" && selected.id !== "photo-edit";
  const sampler = add("7","KSamplerSelect",{sampler_name:isPdmd ? PDMD_PROFILE.sampler : extras.sampler || (stillDirected && !lora ? "euler" : sampling.sampler)});
  const sigmas = add("8","BasicScheduler",{model:activeModel,scheduler:isPdmd ? PDMD_PROFILE.scheduler : extras.scheduler || (stillDirected && !lora ? "linear_quadratic" : sampling.scheduler),steps:effectiveSteps,denoise:isPdmd ? PDMD_PROFILE.denoise : extras.denoise ?? 1});
  const noise = add("9","RandomNoise",{noise_seed:config.seed});
  const guider = add("10","BasicGuider",{model:activeModel,conditioning});
  let sampled = add("11","SamplerCustomAdvanced",{noise,guider,sampler,sigmas,latent_image:latent});
  if(selected.id === "latent-upscale") {
    const scale=extras.upscaleScale ?? 2;
    if(!Number.isFinite(scale) || scale < 1 || scale > 4) throw new Error("Upscale factor must be between 1 and 4.");
    const upscaleModel=add("upscale-model","FL_MiniMaxH3LatentUpscaleModelLoader",{model_name:safetensors(extras.upscaler || "minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors","Latent upscaler"),precision:"fp16"});
    sampled=add("upscale","FL_MiniMaxH3NeuralLatentUpscale3D",{upscale_model:upscaleModel,latent:sampled,mode:"scale by multiplier","mode.scale":scale,align:32,temporal_chunk_size:32});
  }
  if(selected.output === "image") {
    const class_type = selected.id === "character-sheet" ? "DecodeH3CharacterSheet" : selected.id === "scene-coverage" ? "DecodeH3SceneCoverage" : "DecodeH3SingleFrame";
    const inputs: Record<string,unknown>={samples:sampled,vae:videoVae};
    if(selected.id === "character-sheet") Object.assign(inputs,{layout:"auto from encoded profile",gutter_px:6,gutter_color:"white"});
    if(selected.id === "scene-coverage") Object.assign(inputs,{columns:4,gutter_px:6,gutter_color:"white"});
    const image=add("12",class_type,inputs);
    add("15","SaveImage",{images:image,filename_prefix:`MiniMax_Studio/${selected.id}`});
  } else {
    let images=add("12","VAEDecode",{samples:sampled,vae:videoVae});
    let audio=add("13","VAEDecodeAudio",{samples:sampled,vae:audioVae});
    if(selected.id === "extend-video") {
      const source=byRole("source_video")[0];
      const trimmed=add("extension-trim","MiniMaxH3MotionContextTrim",{images,audio,trim_frames:["extension-context",1],fps:24,match_tail:true,video_crossfade_frames:39});
      images=add("extension-assemble","MiniMaxH3AssembleExtension",{source_frames:fileLinks.get(source),source_audio:firstLink("source_audio")||videoAudio(source),source_fps:24,continuation_images:trimmed,continuation_audio:[trimmed[0],1],fps:24,crop:"center"});
      audio=[images[0],1];
    }
    const video=add("14","CreateVideo",{images,...(extras.audio === false ? {} : {audio}),fps:24,bit_depth:8});
    // V3 DynamicCombo children use dotted input names in API prompts.
    add("15","SaveVideo",{video,filename_prefix:`video/MiniMax_Studio/${selected.id}`,format:"mp4","format.codec":"h264","format.codec.encoding":"auto"});
  }
  // The deployed enhanced handler recognizes source_video but not control_video.
  // Its title matching selects our "control video" loader using the video hint.
  const handlerFiles=files.map(file=>file.role === "control_video" ? {...file,role:"source_video"} : file);
  // apply_parameters in the supplied handler defaults to seed=0 and 5 seconds
  // even for API graphs. Explicit parameters preserve the authored graph.
  return {input:{workflow,files:handlerFiles,parameters:{seed:config.seed,duration_seconds:selected.id === "extend-video" ? config.duration + 39/24 : config.duration,fps:24,steps:effectiveSteps}}};
}

