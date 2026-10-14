export const BASE_MODELS = {
  fl2va: ['minimax_h3_fl2va_pruned_int8_convrot.safetensors', 'minimax_h3_fl2va_pruned_fp8_scaled.safetensors'],
  ref2va: ['minimax_h3_ref2va_pruned_int8_convrot.safetensors', 'minimax_h3_ref2va_pruned_fp8_scaled.safetensors'],
};
export const VIDEO_VAES = ['minimax_h3_video_vae_int8_convrot.safetensors', 'minimax_h3_video_vae_fp16.safetensors'];
export const LORAS = [
 'minimax_h3_pdmd_4nfe_comfyui_v6.safetensors',
 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors',
 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
 'camera_motion_h3_lora_v1_3000_pruned.safetensors',
 'better_motion_h3_lora_v1_500.safetensors',
 'h3-realism-people-t2v-i2v-r2v.safetensors',
 'ig_tiktok_aesthetic_h3_lora_v1_500.safetensors',
 'wushu_spatial_physics_clean_3000_pruned.safetensors',
 'wushu_action_h3_lora_v5_3000_fl2va_no-adaln.safetensors',
 'h3_character_swap_pro4500_1000.safetensors',
 'minimax_h3_head_swap_v1.0_r32.safetensors',
 'minimax_h3_style_transfer_v1.0_r64.safetensors',
 'minimax_h3_vfx_edit_v1.0_r128.safetensors',
 'minimax_h3_vfx_edit_v1.0_r128_ffp.safetensors',
 'minimax_h3_live_wallpaper_v1.0_ref2va_r64.safetensors',
 'minimax_h3_lms_v1.0_r64.safetensors',
 'low-poly.safetensors', 'retro-toon-70s.safetensors', 'vh5tape-comfyui.safetensors',
 'studio1939-strong.safetensors', 'minimax_h3_looping_sketch_anime_v1.safetensors',
 'minimax_h3_claymation_transformation.safetensors',
];
export const CONTROLNET = 'minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors';
export const UPSCALER = 'minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors';
export const CREATIVE_LORAS = LORAS.filter(name => !/pdmd|turbo/.test(name));

export interface FeatureLoraRecommendation {
  name: string;
  label: string;
  strength: number;
  modelFamily: 'fl2va' | 'ref2va' | 'any';
  trigger?: string;
  sourceGuide?: boolean;
  notes: string[];
  sources: {title: string; url: string}[];
}
const REALISM: FeatureLoraRecommendation = {
  name:'h3-realism-people-t2v-i2v-r2v.safetensors',label:'Realistic people',strength:0.8,modelFamily:'any',trigger:'r34l1sm',
  notes:['General visual fallback for human / photoreal scenes, rather than a task-specific adapter. The author explicitly supports text, image and reference generation through shared attention projections. Disable it for a neutral or stylized result.'],
  sources:[{title:'fal Realism People author card',url:'https://huggingface.co/fal/MiniMax-H3-Realism-People-LoRA'}],
};
const MOTION: FeatureLoraRecommendation = {
  name:'better_motion_h3_lora_v1_500.safetensors',label:'Better human motion',strength:0.6,modelFamily:'fl2va',
  notes:['Author supports T2V / I2V, strength 0.4–0.8 and base sampling at 20–30 steps. Pairing with a Speed LoRA is available, with unbenchmarked interaction between the adapters.'],
  sources:[{title:'Better Motion author card',url:'https://huggingface.co/vpakarinen/better-human-motion-h3-lora'}],
};
const CAMERA: FeatureLoraRecommendation = {
  name:'camera_motion_h3_lora_v1_3000_pruned.safetensors',label:'Camera motion',strength:0.9,modelFamily:'fl2va',trigger:'camera motion',
  notes:['Author requires camera motion at the start of the prompt and recommends strength 0.8–1.0. This controls the camera through the prompt.'],
  sources:[{title:'Camera Motion author card',url:'https://huggingface.co/Jojocodex/minimax-h3-Camera-Motion-lora'}],
};
const SWAP: FeatureLoraRecommendation = {
  name:'h3_character_swap_pro4500_1000.safetensors',label:'Character swap',strength:1,modelFamily:'ref2va',
  notes:['Author uses REF2VA, the source as <Video 1>, replacement as <Picture 1>, strength 1 and no additional trigger word. Timing and exact scene preservation remain generative.'],
  sources:[{title:'Akatz Character Swap author card',url:'https://huggingface.co/akatz-ai/MiniMax-H3-Character-Swap-LoRA'}],
};
const STYLE: FeatureLoraRecommendation = {
  name:'minimax_h3_style_transfer_v1.0_r64.safetensors',label:'Style transfer',strength:1,modelFamily:'ref2va',trigger:'style_transfer:',sourceGuide:true,
  notes:['Author uses a frame-aligned source video through MiniMaxH3AddGuide at frame 0 and the style image through native references. Start at 1; about 0.7 can preserve more motion.'],
  sources:[{title:'Style Transfer author guide',url:'https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/blob/main/docs/style-transfer.md'}],
};
const VFX: FeatureLoraRecommendation = {
  name:'minimax_h3_vfx_edit_v1.0_r128.safetensors',label:'VFX edit',strength:1,modelFamily:'ref2va',trigger:'vfx_edit:',sourceGuide:true,
  notes:['Author uses an aligned source clip through MiniMaxH3AddGuide at frame 0. The standard adapter is simpler than FFP and does not require an edited first-frame image.'],
  sources:[{title:'VFX Edit author guide',url:'https://huggingface.co/Alissonerdx/Minimax-H3-ComfyUI/blob/main/docs/vfx-edit.md'}],
};
export const FEATURE_LORA_METADATA: Record<string, FeatureLoraRecommendation> = Object.fromEntries([REALISM,MOTION,CAMERA,SWAP,STYLE,VFX].map(item=>[item.name,item]));
export const FEATURE_LORA_DEFAULTS: Record<string,string> = {
  'text-to-video':REALISM.name,'image-to-video':REALISM.name,'last-frame':REALISM.name,'first-last-frame':MOTION.name,
  'reference-to-video':REALISM.name,'video-edit':VFX.name,'motion-transfer':REALISM.name,'character-swap':SWAP.name,'style-transfer':STYLE.name,
  'voice-reference':REALISM.name,'audio-to-video':REALISM.name,'keyframes':MOTION.name,'extend-video':MOTION.name,
  'photo-edit':REALISM.name,'character-sheet':REALISM.name,'scene-coverage':REALISM.name,'camera-motion':CAMERA.name,'union-controlnet':REALISM.name,'relight':REALISM.name,'latent-upscale':REALISM.name,
};
export function getFeatureLoraMetadata(name:string): FeatureLoraRecommendation | null {
  const item=FEATURE_LORA_METADATA[name];
  return item ? {...item,notes:[...item.notes],sources:[...item.sources]} : null;
}
export function getRecommendedFeatureLora(featureId:string): FeatureLoraRecommendation | null {
  return getFeatureLoraMetadata(FEATURE_LORA_DEFAULTS[featureId] || '');
}
/** Known family-safe choices. Other unverified inventory adapters remain expert add-ons. */
export function getCompatibleFeatureLoras(family:'fl2va'|'ref2va'): string[] {
  return Object.values(FEATURE_LORA_METADATA).filter(item=>item.modelFamily === 'any' || item.modelFamily === family).map(item=>item.name);
}

