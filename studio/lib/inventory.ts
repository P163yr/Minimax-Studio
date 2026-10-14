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

