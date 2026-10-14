"""Check the browser's file loader graphs against the repository's actual handler.

No ComfyUI, GPU, network or deployment packages are needed. Runtime-only modules
are stubbed while the unmodified bind_media implementation is imported.
Run workflows.test.mjs first to create representative requests in work/tests.
"""
import importlib.util
import copy
import json
from pathlib import Path
import sys
import types

base = types.ModuleType("handler_base")
base.get_history = lambda *_args: {}
sys.modules["handler_base"] = base
sys.modules["runpod"] = types.ModuleType("runpod")
sys.modules["requests"] = types.ModuleType("requests")
root = Path(__file__).resolve().parent.parent
worker_path = root / "worker" / "handler_enhanced.py"
if not worker_path.exists():
    worker_path = root.parent / "handler_enhanced.py"
spec = importlib.util.spec_from_file_location("handler_under_test", worker_path)
handler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handler)

requests = json.loads((root / "work" / "tests" / "requests.json").read_text(encoding="utf-8"))
for example in requests:
    workflow = example["request"]["input"]["workflow"]
    files = example["request"]["input"]["files"]
    saved = [{"role": file["role"], "name": file["name"], "relative": f"h3_studio/job/{file['name']}", "absolute": f"/comfyui/input/h3_studio/job/{file['name']}", "mime_type": file["mime_type"]} for file in files]
    authored_seed = workflow["9"]["inputs"]["noise_seed"]
    authored_length = workflow["6"]["inputs"].get("length")
    authored_steps = workflow["8"]["inputs"]["steps"]
    # An imported authored graph must run unchanged when overrides are absent.
    for absent in (None, {}):
        imported = copy.deepcopy(workflow)
        handler.apply_parameters(imported, absent)
        assert imported == workflow, f"{example['id']}: absent parameters changed authored graph"
    # A seed-only request must preserve every authored frame count and schedule.
    partial = copy.deepcopy(workflow)
    expected_partial = copy.deepcopy(workflow)
    for node in expected_partial.values():
        for key in ("noise_seed", "seed", "random_seed"):
            if key in node["inputs"] and not isinstance(node["inputs"][key], list):
                node["inputs"][key] = 0
    handler.apply_parameters(partial, {"seed": 0})
    assert partial == expected_partial, f"{example['id']}: seed-only override changed undeclared keys"
    handler.apply_parameters(workflow, example["request"]["input"]["parameters"])
    assert workflow["9"]["inputs"]["noise_seed"] == authored_seed, f"{example['id']}: seed changed by handler"
    assert workflow["6"]["inputs"].get("length") == authored_length, f"{example['id']}: duration changed by handler"
    assert workflow["8"]["inputs"]["steps"] == authored_steps, f"{example['id']}: steps changed by handler"
    loader_fields = {"LoadImage": "image", "LoadAudio": "audio", "VHS_LoadVideo": "video"}
    loaders = [(node_id,node) for node_id,node in workflow.items() if node["class_type"] in loader_fields]
    expected = {node_id: next(file["relative"] for file in saved if file["name"] == node["inputs"][loader_fields[node["class_type"]]]) for node_id,node in loaders}
    handler.bind_media(workflow, saved)
    for node_id,node in loaders:
        actual = node["inputs"][loader_fields[node["class_type"]]]
        assert actual == expected[node_id], f"{example['id']}: loader {node_id} received the wrong file: {actual}"
assert handler._frames_for_duration(5,24) == 124
assert handler._frames_for_duration(15,24) == 362

authored = {
    "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "authored.safetensors", "weight_dtype": "default"}},
    "2": {"class_type": "CustomTimeline", "inputs": {"seed": 432, "steps": 23, "length": 171, "fps": 24, "denoise": 0.65, "prompt": "authored prompt", "negative_prompt": "authored negative", "shift_video": 12, "shift_audio": 3}},
    "3": {"class_type": "CustomTimeline", "inputs": {"seed": ["2",0], "steps": ["2",1], "length": ["2",2], "fps": ["2",3], "denoise": ["2",4]}},
    "4": {"class_type": "LoraLoaderModelOnly", "inputs": {"model": ["1",0], "lora_name": "authored_lora.safetensors", "strength_model": 0.75}},
}
for overrides, changed in (({"steps": 12}, {"steps": 12}), ({"fps": 30}, {"fps": 30}), ({"duration_seconds": 10}, {"length": 243}), ({"denoise": 0}, {"denoise": 0}), ({"prompt": ""}, {"prompt": ""}), ({"negative_prompt": ""}, {"negative_prompt": ""}), ({"prompt_prefix": "cinematic"}, {"prompt": "cinematic, authored prompt"})):
    actual = copy.deepcopy(authored)
    expected = copy.deepcopy(authored)
    expected["2"]["inputs"].update(changed)
    handler.apply_parameters(actual, overrides)
    assert actual == expected, f"Partial override {overrides} changed undeclared or linked inputs"

actual = copy.deepcopy(authored)
handler.apply_parameters(actual, {"lora_name": "authored_lora.safetensors"})
assert actual == authored, "Selecting an existing LoRA must preserve its authored strength when unspecified"
handler.apply_parameters(actual, {"lora_name": "authored_lora.safetensors", "lora_strength": 0})
assert actual["4"]["inputs"]["strength_model"] == 0, "Explicit zero LoRA strength must be respected"

print(f"Enhanced handler bindings, absent/partial overrides and seed/duration preservation passed for all {len(requests)} feature graphs.")

