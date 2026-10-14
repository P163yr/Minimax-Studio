import assert from "node:assert/strict";
import {readFile,mkdir,writeFile} from "node:fs/promises";
import {pathToFileURL} from "node:url";
import path from "node:path";
import ts from "typescript";

// Keep these tests executable with the bundled Node runtime, without a TS loader.
const source = await readFile(new URL("../lib/workflows.ts",import.meta.url),"utf8");
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText.replace('from "./inventory"','from "./inventory.mjs"');
const testDir=path.resolve("work/tests");
await mkdir(testDir,{recursive:true});
const generatedPath=path.join(testDir,"workflows.mjs");
await writeFile(generatedPath,compiled);
const inventorySource=await readFile(new URL("../lib/inventory.ts",import.meta.url),"utf8");
await writeFile(path.join(testDir,"inventory.mjs"),ts.transpileModule(inventorySource,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022}}).outputText);
const {getRecommendedFeatureLora,getCompatibleFeatureLoras,getFeatureLoraMetadata}=await import(pathToFileURL(path.join(testDir,"inventory.mjs")).href);
const {buildRequest,FEATURES,DEFAULT_MODELS,PDMD_LORA,PDMD_PROFILE,framesForDuration,dimensionsForRatio,recommendedSteps,getSamplingProfile} = await import(pathToFileURL(generatedPath).href);
const config = {feature:"text-to-video",prompt:"A kite over a bright seaside, with surf and wind.",duration:5,aspectRatio:"16:9",megapixels:1,seed:757358688076805,steps:8};
const upload=(role,kind="image",name="reference.png")=>({role,name,mime_type:`${kind}/${kind === "image" ? "png" : kind === "video" ? "mp4" : "wav"}`,data:"dGVzdA==",...(kind === "video" ? {duration:3,hasAudio:true} : kind === "audio" ? {duration:3} : {})});
const allRequests=new Map();
for(const feature of FEATURES) {
  const files=feature.media.filter(s=>s.required).map(s=>upload(s.role,s.kind));
  if(feature.id === "reference-to-video") files.push(upload("reference_image"));
  const request=buildRequest({...config,feature:feature.id,model:feature.modelFamily === "ref2va" ? DEFAULT_MODELS.suggestedRef2va : DEFAULT_MODELS.fl2va,lora:"",files});
  const graph=request.input.workflow;
  assert.equal(graph["1"].inputs.unet_name,feature.modelFamily === "ref2va" ? DEFAULT_MODELS.suggestedRef2va : DEFAULT_MODELS.fl2va);
  const output=Object.values(graph).filter(n=>["SaveVideo","SaveImage"].includes(n.class_type));
  assert.equal(output.length,1,`${feature.id}: one deliverable output`);
  assert.equal(output[0].class_type,feature.output === "image" ? "SaveImage" : "SaveVideo");
  for(const [nodeId,node] of Object.entries(graph)) {
    for(const [input,value] of Object.entries(node.inputs)) {
      if(Array.isArray(value) && value.length === 2 && typeof value[0] === "string") {
        assert.ok(graph[value[0]],`${feature.id}: ${nodeId}.${input} links to existing node`);
        assert.ok(Number.isInteger(value[1]) && value[1]>=0,`${feature.id}: valid output index`);
      }
      assert.notEqual(value,undefined,`${feature.id}: no missing input ${nodeId}.${input}`);
    }
  }
  allRequests.set(feature.id,request);
}
assert.equal(framesForDuration(5),124);
assert.equal(framesForDuration(10),243);
assert.equal(framesForDuration(15),362);
assert.throws(()=>framesForDuration(5,30),/24 fps/);
const size=dimensionsForRatio("16:9 (Widescreen)",1);
assert.equal(size.width%32,0);
assert.equal(size.height%32,0);
const t2v=allRequests.get("text-to-video").input.workflow;
assert.equal(allRequests.get("text-to-video").input.parameters.seed,config.seed);
assert.equal(allRequests.get("text-to-video").input.parameters.duration_seconds,5);
assert.equal(t2v["6"].class_type,"MiniMaxH3ImageToVideo");
assert.equal(t2v["6"].inputs.first_frame,undefined);
assert.deepEqual(t2v["11"].inputs.latent_image,["6",1]);
assert.deepEqual(t2v["12"].inputs.samples,["11",0]);
assert.deepEqual(t2v["13"].inputs.samples,["11",0]);
assert.equal(t2v["14"].inputs.fps,24);
assert.equal(t2v["15"].inputs["format.codec"],"h264");
assert.equal(t2v["15"].inputs.codec,undefined);
const frames=allRequests.get("first-last-frame");
assert.deepEqual(frames.input.workflow["6"].inputs.first_frame,["100",0]);
assert.deepEqual(frames.input.workflow["6"].inputs.last_frame,["101",0]);
assert.notEqual(frames.input.files[0].name,frames.input.files[1].name,"same original filenames do not overwrite each other");
const r2v=buildRequest({...config,feature:"reference-to-video",model:DEFAULT_MODELS.suggestedRef2va,lora:"",files:[upload("reference_image"),upload("reference_video","video"),upload("reference_audio","audio")],extras:{includeVideoAudio:true}}).input.workflow;
assert.equal(r2v["6"].class_type,"MiniMaxH3ReferenceToVideo");
assert.deepEqual(r2v["6"].inputs["ref_images.ref_image_0"],["100",0]);
assert.deepEqual(r2v["6"].inputs["ref_videos.ref_video_0"],["101",0]);
assert.deepEqual(r2v["6"].inputs["ref_video_audios.ref_video_audio_0"],["101",2]);
assert.deepEqual(r2v["6"].inputs["ref_audios.ref_audio_0"],["102",0]);
assert.equal(r2v["101"].inputs.force_rate,24,"reference video normalized to model FPS");
const performance=allRequests.get("audio-to-video").input.workflow;
assert.equal(performance["guide-audio"].class_type,"MiniMaxH3AddGuide");
assert.equal(performance["guide-audio"].inputs.frame_idx,0);
assert.deepEqual(performance["10"].inputs.conditioning,["guide-audio",0]);
const extended=allRequests.get("extend-video").input.workflow;
assert.equal(extended["100"].inputs.format,"None","continuation keeps all original source frames");
assert.equal(extended["extension-context"].inputs.context_length,39);
assert.deepEqual(extended["11"].inputs.latent_image,["extension-context",0]);
assert.deepEqual(extended["extension-trim"].inputs.trim_frames,["extension-context",1]);
assert.deepEqual(extended["extension-assemble"].inputs.continuation_audio,["extension-trim",1]);
assert.deepEqual(extended["14"].inputs.audio,["extension-assemble",1]);
assert.equal(extended["6"].inputs.length%17,5);
const muted=buildRequest({...config,extras:{audio:false}}).input.workflow;
assert.equal(muted["14"].inputs.audio,undefined);
const guides=buildRequest({...config,feature:"keyframes",files:[{...upload("guide_image"),frame_idx:30}]}).input.workflow;
assert.equal(guides["guide-0"].inputs.frame_idx,30);
assert.deepEqual(guides["10"].inputs.conditioning,["guide-0",0]);
assert.throws(()=>buildRequest({...config,feature:"keyframes",files:[{...upload("guide_image"),frame_idx:999}]}),/intermediate frame/);
const defaultReference=buildRequest({...config,feature:"reference-to-video",steps:4,files:[upload("reference_image")]}).input.workflow;
assert.equal(defaultReference["1"].inputs.unet_name,DEFAULT_MODELS.ref2va);
assert.equal(defaultReference["1b"].inputs.lora_name,DEFAULT_MODELS.ref2vaLora);
assert.equal(recommendedSteps(undefined,"ref2va"),4);
assert.equal(recommendedSteps(undefined,"fl2va"),8);
assert.equal(recommendedSteps("minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors"),4);
assert.equal(recommendedSteps(""),20);
assert.equal(recommendedSteps(PDMD_LORA),4);
const stacked=buildRequest({...config,extras:{loras:[{name:"better_motion_h3_lora_v1_500.safetensors",strength:0.8}]}}).input.workflow;
assert.equal(stacked["1b"].inputs.lora_name,DEFAULT_MODELS.fl2vaLora);
const [stackedExtraId,stackedExtra]=Object.entries(stacked).find(([,node])=>node.class_type === "LoraLoaderModelOnly" && node.inputs.lora_name === "better_motion_h3_lora_v1_500.safetensors");
assert.deepEqual(stackedExtra.inputs.model,["feature-lora",0]);
assert.deepEqual(stacked["feature-lora"].inputs.model,["1b",0]);
assert.deepEqual(stacked["1d"].inputs.model,[stackedExtraId,0]);
assert.deepEqual(stacked["8"].inputs.model,["1d",0]);
const deduplicated=buildRequest({...config,extras:{loras:[{name:DEFAULT_MODELS.fl2vaLora,strength:1}]}}).input.workflow;
assert.equal(Object.values(deduplicated).filter(node=>node.class_type === "LoraLoaderModelOnly" && node.inputs.lora_name === DEFAULT_MODELS.fl2vaLora).length,1,"duplicate Speed adapter is loaded only once");
const pdmd=buildRequest({...config,lora:PDMD_LORA,steps:8,extras:{loraStrength:0.75,sampler:"res_multistep",scheduler:"beta",shiftVideo:6,shiftAudio:6,denoise:0.5}});
assert.equal(pdmd.input.workflow["1b"].inputs.strength_model,1,"pDMD distillation delta always uses strength1");
assert.equal(pdmd.input.workflow["7"].inputs.sampler_name,"euler");
assert.equal(pdmd.input.workflow["8"].inputs.scheduler,"simple");
assert.equal(pdmd.input.workflow["8"].inputs.steps,4);
assert.equal(pdmd.input.workflow["8"].inputs.denoise,1);
assert.equal(pdmd.input.parameters.steps,4,"handler cannot revert pDMD to stale8-step UI state");
assert.equal(pdmd.input.workflow["1d"].inputs.shift_video,12);
assert.equal(pdmd.input.workflow["1d"].inputs.shift_audio,3);
assert.equal(pdmd.input.workflow["1c"].inputs.attention,"pytorch attention");
assert.equal(pdmd.input.workflow["10"].class_type,"BasicGuider","no CFG as distillation requires");
assert.deepEqual(pdmd.input.workflow["1c"].inputs.model,["1d",0]);
assert.equal(PDMD_PROFILE.modelFamily,"fl2va");
assert.equal(getSamplingProfile("minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors").shiftVideo,6);
const fl4=buildRequest({...config,lora:"minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors",steps:4}).input.workflow;
assert.equal(fl4["7"].inputs.sampler_name,"euler");
assert.equal(fl4["1d"].inputs.shift_video,6);
assert.equal(fl4["1d"].inputs.shift_audio,3);
assert.equal(defaultReference["7"].inputs.sampler_name,"euler");
assert.equal(defaultReference["1d"].inputs.shift_video,12);
assert.equal(defaultReference["1d"].inputs.shift_audio,3);

// Compare the authored recipe, rather than guessing a custom sigma list.
for(const mode of ["t2v","i2v"]) {
  const authored=JSON.parse(await readFile(new URL(`./fixtures/mini-fast-${mode}.json`,import.meta.url),"utf8")).input.workflow;
  const built=buildRequest({...config,lora:PDMD_LORA,feature:mode === "i2v" ? "image-to-video" : "text-to-video",steps:4,files:mode === "i2v" ? [upload("first_frame")] : [],extras:{attention:"comfy kitchen attention"}}).input.workflow;
  for(const id of ["1b","1d","1c","7","8","10","11"]) {
    assert.equal(built[id].class_type,authored[id].class_type,`${mode}: authored node ${id}`);
    for(const field of ["lora_name","strength_model","shift_video","shift_audio","attention","sampler_name","scheduler","steps","denoise"]) {
      if(authored[id].inputs[field] !== undefined) assert.equal(built[id].inputs[field],authored[id].inputs[field],`${mode}: authored ${id}.${field}`);
    }
  }
}
for(const feature of FEATURES) {
  const files=feature.media.filter(s=>s.required).map(s=>upload(s.role,s.kind));
  const requestConfig={...config,feature:feature.id,lora:PDMD_LORA,steps:4,files};
  if(feature.modelFamily === "ref2va") assert.throws(()=>buildRequest(requestConfig),/pDMD supports.*FL2VA/,`${feature.id}: wrong task partition rejected`);
  else {
    const variant=buildRequest(requestConfig);
    assert.equal(variant.input.workflow["8"].inputs.steps,4);
    assert.equal(variant.input.workflow["7"].inputs.sampler_name,"euler");
    allRequests.set(`${feature.id}-pdmd`,variant);
  }
}
assert.throws(()=>buildRequest({...config,lora:PDMD_LORA,extras:{loras:[{name:DEFAULT_MODELS.fl2vaLora,strength:1}]}}),/one sampling adapter/);
const control=allRequests.get("union-controlnet").input.workflow;
assert.equal(control["control-model"].inputs.name,"minimax_h3_fun_controlnet_union_2.0_pruned_int8_convrot.safetensors");
assert.equal(control["control-apply"].class_type,"MiniMaxH3FunControlNetApply");
assert.deepEqual(control["10"].inputs.model,["control-apply",0]);
const relight=allRequests.get("relight").input.workflow;
assert.equal(relight["relight"].class_type,"H3RelightEditor");
assert.deepEqual(relight["6"].inputs.options,["relight",1]);
assert.deepEqual(relight["6"].inputs.compiled_prompt,["relight",0]);
assert.deepEqual(relight["6"].inputs.reference_image,["relight",2]);
assert.equal(relight["relight"].inputs.runtime_task,"directed | 39-frame settle");
const upscaled=allRequests.get("latent-upscale").input.workflow;
assert.equal(upscaled["upscale"].class_type,"FL_MiniMaxH3NeuralLatentUpscale3D");
assert.deepEqual(upscaled["upscale"].inputs.latent,["11",0]);
assert.equal(upscaled["upscale"].inputs["mode.scale"],2);
assert.deepEqual(upscaled["12"].inputs.samples,["upscale",0]);
assert.deepEqual(upscaled["13"].inputs.samples,["upscale",0]);
assert.throws(()=>buildRequest({...config,feature:"video-edit",model:DEFAULT_MODELS.fl2va,files:[upload("source_video","video")]}),/requires REF2VA/);
assert.throws(()=>buildRequest({...config,feature:"image-to-video",files:[]}),/first frame/);
assert.throws(()=>buildRequest({...config,files:[upload("mask")]}),/role/);
assert.throws(()=>buildRequest({...config,model:"minimax_h3_max.safetensors"}),/H3 Max/);
assert.throws(()=>buildRequest({...config,seed:Number.MAX_SAFE_INTEGER+1}),/safe integer/);
assert.throws(()=>buildRequest({...config,feature:"reference-to-video",model:DEFAULT_MODELS.suggestedRef2va,files:[...Array.from({length:10},()=>upload("reference_image"))]}),/up to 9/);
assert.throws(()=>buildRequest({...config,feature:"reference-to-video",model:DEFAULT_MODELS.suggestedRef2va,files:[{...upload("reference_audio","audio"),duration:16}]}),/2–15 seconds/);

// Every mode receives its recommended Feature adapter independently of Speed.
for(const feature of FEATURES) {
  const recommendation=getRecommendedFeatureLora(feature.id);
  assert.ok(recommendation,`${feature.id}: documented feature recommendation`);
  assert.ok(recommendation.sources.length,`${feature.id}: feature recommendation provenance`);
  assert.ok(recommendation.modelFamily === "any" || recommendation.modelFamily === feature.modelFamily,`${feature.id}: family-compatible recommendation`);
  const files=feature.media.filter(slot=>slot.required).map(slot=>upload(slot.role,slot.kind));
  if(feature.id === "reference-to-video") files.push(upload("reference_image"));
  const speed=feature.modelFamily === "ref2va" ? DEFAULT_MODELS.ref2vaLora : DEFAULT_MODELS.fl2vaLora;
  const both=buildRequest({...config,feature:feature.id,lora:speed,files});
  const adapters=Object.values(both.input.workflow).filter(node=>node.class_type === "LoraLoaderModelOnly").map(node=>node.inputs.lora_name);
  assert.ok(adapters.includes(speed),`${feature.id}: Speed enabled`);
  assert.ok(adapters.includes(recommendation.name),`${feature.id}: Feature enabled`);
  assert.equal(adapters.filter(name=>name === recommendation.name).length,1);
  allRequests.set(`${feature.id}-both-adapters`,both);
  const disabled=buildRequest({...config,feature:feature.id,lora:speed,files,extras:{featureLora:{name:recommendation.name,strength:recommendation.strength,enabled:false}}});
  assert.ok(!Object.values(disabled.input.workflow).some(node=>node.class_type === "LoraLoaderModelOnly" && node.inputs.lora_name === recommendation.name),`${feature.id}: Feature disable honored`);
  const featureOnly=buildRequest({...config,feature:feature.id,lora:"",files});
  assert.ok(!Object.values(featureOnly.input.workflow).some(node=>node.class_type === "LoraLoaderModelOnly" && node.inputs.lora_name === speed),`${feature.id}: Speed disable honored`);
}
assert.ok(!getCompatibleFeatureLoras("ref2va").includes("better_motion_h3_lora_v1_500.safetensors"));
assert.ok(getCompatibleFeatureLoras("fl2va").includes("h3-realism-people-t2v-i2v-r2v.safetensors"));
assert.throws(()=>buildRequest({...config,extras:{featureLora:{name:"h3_character_swap_pro4500_1000.safetensors",strength:1,enabled:true}}}),/REF2VA/);
const cameraOff=buildRequest({...config,feature:"camera-motion",extras:{featureLora:{name:"camera_motion_h3_lora_v1_3000_pruned.safetensors",strength:0.9,enabled:false}}}).input.workflow;
assert.ok(!cameraOff["6"].inputs.prompt.startsWith("camera motion"),"disabled camera feature does not inject its trigger");
const cameraOn=buildRequest({...config,feature:"camera-motion"}).input.workflow;
assert.ok(cameraOn["6"].inputs.prompt.startsWith("camera motion,"),"camera trigger is applied with active Feature adapter");
for(const id of ["video-edit","style-transfer"]) {
  const example=allRequests.get(id).input.workflow;
  assert.equal(example["feature-guide"].class_type,"MiniMaxH3AddGuide");
  assert.equal(example["feature-guide"].inputs.frame_idx,0);
  assert.equal(example["6"].inputs["ref_videos.ref_video_0"],undefined,"specialized source is aligned guide rather than loose video reference");
  assert.deepEqual(example["10"].inputs.conditioning,["feature-guide",0]);
  assert.ok(example["6"].inputs.prompt.startsWith(getFeatureLoraMetadata(getRecommendedFeatureLora(id).name).trigger));
}
console.log(`Workflow checks passed: ${FEATURES.length} features, graph connections, media limits, model pairing, AV assembly and API serialization.`);
await writeFile(path.join(testDir,"requests.json"),JSON.stringify([...allRequests].map(([id,request])=>({id,request}))));

