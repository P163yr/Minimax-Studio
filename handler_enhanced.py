"""Enhanced wrapper for runpod/worker-comfyui.

This file is intended to replace /handler.py *after* the stock handler has been
renamed to /handler_base.py. It keeps the stock worker's execution, websocket,
validation, and output encoding behavior, while adding:

- generic image/video/audio/file inputs via base64 data or URL;
- best-effort conversion of ComfyUI UI-format workflows to API format;
- support for current ComfyUI subgraph workflow templates;
- common prompt/seed/duration/model/LoRA parameter overrides;
- media-role binding to LoadImage/LoadVideo/LoadAudio-style nodes;
- promotion of video/audio/file history outputs so the stock handler returns
  them as base64 or S3 URLs just like image outputs.

Expected request shape:
{
  "input": {
    "workflow": { ... UI or API workflow ... },
    "parameters": { ... },
    "files": [
      {"role":"first_frame", "name":"input.png", "data":"data:image/png;base64,..."},
      {"role":"source_video", "name":"clip.mp4", "url":"https://..."}
    ],
    "explicit_overrides": [
      {"node_id":"8", "input":"steps", "value":12},
      {"class_type":"SaveVideo", "input":"filename_prefix", "value":"video/test"}
    ]
  }
}
"""

from __future__ import annotations

import base64
import copy
import json
import math
import mimetypes
import os
import re
import shutil
import tempfile
import urllib.parse
from pathlib import Path
from typing import Any

import requests
import runpod

try:
    import handler_base as base
except ImportError as exc:  # pragma: no cover - deployment-only guard
    raise RuntimeError(
        "handler_base.py is missing. Rename the stock /handler.py to "
        "/handler_base.py before copying handler_enhanced.py to /handler.py."
    ) from exc


COMFY_INPUT_DIR = Path(os.environ.get("COMFY_INPUT_DIR", "/comfyui/input"))
MAX_INPUT_MB = int(os.environ.get("H3_MAX_INPUT_MB", "500"))
MAX_INPUT_BYTES = MAX_INPUT_MB * 1024 * 1024

FRONTEND_ONLY_TYPES = {
    "MarkdownNote",
    "Note",
    "Reroute",
    "PrimitiveNode",
}

PRIMITIVE_PREFIXES = (
    "PrimitiveInt",
    "PrimitiveFloat",
    "PrimitiveString",
    "PrimitiveBoolean",
    "PrimitiveNumber",
)

MEDIA_OUTPUT_KEYS = {
    "videos",
    "video",
    "audio",
    "audios",
    "files",
    "gifs",
    "animations",
}


def _deepcopy(value: Any) -> Any:
    return copy.deepcopy(value)


def _is_api_workflow(workflow: Any) -> bool:
    if not isinstance(workflow, dict) or not workflow:
        return False
    values = list(workflow.values())
    return all(
        isinstance(node, dict)
        and isinstance(node.get("class_type"), str)
        and isinstance(node.get("inputs"), dict)
        for node in values
    )


def _unwrap_workflow(document: Any) -> Any:
    if isinstance(document, str):
        document = json.loads(document)
    if isinstance(document, dict):
        inner = document.get("input")
        if isinstance(inner, dict) and isinstance(inner.get("workflow"), dict):
            return inner["workflow"]
    return document


def _node_key(prefix: str, node_id: Any) -> str:
    raw = str(node_id)
    return f"{prefix}{raw}" if prefix else raw


def _widget_named(node: dict[str, Any]) -> dict[str, Any]:
    value = node.get("widgets_values_named")
    return dict(value) if isinstance(value, dict) else {}


def _primitive_value(node: dict[str, Any]) -> Any:
    named = _widget_named(node)
    if "value" in named:
        return named["value"]
    values = node.get("widgets_values")
    if isinstance(values, list) and values:
        return values[0]
    return None


def _schema_input_names(object_info: dict[str, Any], class_type: str) -> list[str]:
    info = object_info.get(class_type)
    if not isinstance(info, dict):
        return []
    inputs = info.get("input")
    if not isinstance(inputs, dict):
        return []
    names: list[str] = []
    for section in ("required", "optional"):
        values = inputs.get(section)
        if isinstance(values, dict):
            names.extend(values.keys())
    return names


class UIWorkflowConverter:
    """Best-effort ComfyUI UI workflow -> API prompt converter.

    It supports ordinary node/link graphs plus current `definitions.subgraphs`
    templates. It intentionally skips unregistered frontend-only notes. Workflows
    with unusual third-party serialization can still be imported as API-format
    JSON through the browser app.
    """

    def __init__(self, workflow: dict[str, Any], object_info: dict[str, Any]):
        self.workflow = workflow
        self.object_info = object_info or {}
        definitions = workflow.get("definitions", {})
        subgraphs = definitions.get("subgraphs", []) if isinstance(definitions, dict) else []
        self.definitions = {
            str(item.get("id")): item
            for item in subgraphs
            if isinstance(item, dict) and item.get("id") is not None
        }
        self.api: dict[str, dict[str, Any]] = {}
        self._expanding: set[tuple[str, str]] = set()

    def convert(self) -> dict[str, dict[str, Any]]:
        self._convert_graph(
            nodes=self.workflow.get("nodes", []),
            links=self.workflow.get("links", []),
            prefix="",
            external_inputs=None,
            graph_outputs=None,
        )
        if not self.api:
            raise ValueError("UI workflow conversion produced no executable nodes")
        return self.api

    @staticmethod
    def _link_map(links: Any) -> dict[Any, list[Any]]:
        result: dict[Any, list[Any]] = {}
        if not isinstance(links, list):
            return result
        for link in links:
            if isinstance(link, list) and len(link) >= 5:
                result[link[0]] = link
            elif isinstance(link, dict) and link.get("id") is not None:
                result[link["id"]] = [
                    link.get("id"),
                    link.get("origin_id"),
                    link.get("origin_slot", 0),
                    link.get("target_id"),
                    link.get("target_slot", 0),
                    link.get("type"),
                ]
        return result

    def _convert_graph(
        self,
        *,
        nodes: Any,
        links: Any,
        prefix: str,
        external_inputs: list[Any] | None,
        graph_outputs: dict[int, Any] | None,
    ) -> dict[int, Any]:
        node_list = [node for node in (nodes or []) if isinstance(node, dict)]
        node_map = {str(node.get("id")): node for node in node_list if node.get("id") is not None}
        link_map = self._link_map(links)
        instance_outputs: dict[tuple[str, int], Any] = {}
        expanded_instances: set[str] = set()

        def resolve_source(link_id: Any) -> Any:
            link = link_map.get(link_id)
            if not link:
                raise ValueError(f"Link {link_id!r} was not found")
            origin_id = str(link[1])
            origin_slot = int(link[2] or 0)

            if origin_id == "-10":
                if external_inputs is None or origin_slot >= len(external_inputs):
                    raise ValueError(f"Subgraph input {origin_slot} is not bound")
                return _deepcopy(external_inputs[origin_slot])

            origin_node = node_map.get(origin_id)
            if origin_node is None:
                return [_node_key(prefix, origin_id), origin_slot]

            origin_type = str(origin_node.get("type", ""))
            if origin_type in self.definitions:
                expand_instance(origin_id)
                key = (origin_id, origin_slot)
                if key not in instance_outputs:
                    raise ValueError(f"Subgraph {origin_id} output {origin_slot} is not connected")
                return _deepcopy(instance_outputs[key])

            if origin_type.startswith(PRIMITIVE_PREFIXES):
                return _primitive_value(origin_node)

            if origin_type == "Reroute":
                reroute_inputs = origin_node.get("inputs") or []
                if reroute_inputs and reroute_inputs[0].get("link") is not None:
                    return resolve_source(reroute_inputs[0]["link"])

            return [_node_key(prefix, origin_id), origin_slot]

        def unlinked_value(instance: dict[str, Any], input_info: dict[str, Any], index: int) -> Any:
            name = input_info.get("name")
            named = _widget_named(instance)
            if name in named:
                return _deepcopy(named[name])
            values = instance.get("widgets_values")
            if isinstance(values, list) and index < len(values):
                return _deepcopy(values[index])
            return None

        def expand_instance(instance_id: str) -> None:
            if instance_id in expanded_instances:
                return
            instance = node_map[instance_id]
            definition_id = str(instance.get("type"))
            definition = self.definitions.get(definition_id)
            if not definition:
                return
            guard = (prefix, instance_id)
            if guard in self._expanding:
                raise ValueError("Recursive subgraph reference detected")
            self._expanding.add(guard)
            try:
                bound_inputs: list[Any] = []
                instance_inputs = instance.get("inputs") or []
                definition_inputs = definition.get("inputs") or []
                max_count = max(len(instance_inputs), len(definition_inputs))
                for index in range(max_count):
                    item = instance_inputs[index] if index < len(instance_inputs) else {}
                    definition_item = definition_inputs[index] if index < len(definition_inputs) else item
                    if isinstance(item, dict) and item.get("link") is not None:
                        bound_inputs.append(resolve_source(item["link"]))
                    else:
                        bound_inputs.append(unlinked_value(instance, definition_item or {}, index))

                child_prefix = f"{prefix}sg{instance_id}_"
                outputs = self._convert_graph(
                    nodes=definition.get("nodes", []),
                    links=definition.get("links", []),
                    prefix=child_prefix,
                    external_inputs=bound_inputs,
                    graph_outputs={},
                )
                for slot, source in outputs.items():
                    instance_outputs[(instance_id, int(slot))] = source
                expanded_instances.add(instance_id)
            finally:
                self._expanding.discard(guard)

        # Expand all subgraph instances before converting downstream consumers.
        for node in node_list:
            if str(node.get("type")) in self.definitions:
                expand_instance(str(node.get("id")))

        # Convert ordinary nodes.
        for node in node_list:
            node_id = str(node.get("id"))
            class_type = str(node.get("type", ""))
            mode = int(node.get("mode", 0) or 0)
            if class_type in self.definitions or mode == 2:
                continue
            if class_type in FRONTEND_ONLY_TYPES:
                continue
            if class_type.startswith(PRIMITIVE_PREFIXES):
                continue
            if class_type not in self.object_info:
                linked = any(
                    str(link[1]) == node_id or str(link[3]) == node_id
                    for link in link_map.values()
                )
                if linked:
                    raise ValueError(
                        f"Workflow uses unavailable node type {class_type!r} "
                        f"(UI node {node_id}). Install the required custom node "
                        "in the Serverless image, or import an API workflow after "
                        "opening the graph in the matching ComfyUI build."
                    )
                # Unlinked notes and frontend-only decorations are harmless.
                continue

            inputs: dict[str, Any] = {}
            named = _widget_named(node)
            node_inputs = node.get("inputs") or []
            linked_names: set[str] = set()
            for input_info in node_inputs:
                if not isinstance(input_info, dict):
                    continue
                name = input_info.get("name")
                if not name:
                    continue
                link_id = input_info.get("link")
                if link_id is not None:
                    inputs[name] = resolve_source(link_id)
                    linked_names.add(name)
                elif name in named:
                    inputs[name] = _deepcopy(named[name])

            for name, value in named.items():
                inputs.setdefault(name, _deepcopy(value))

            # Older UI graphs may not carry widgets_values_named.
            if not named:
                values = node.get("widgets_values")
                if isinstance(values, list):
                    candidate_names = [
                        name
                        for name in self._input_names_for_node(class_type)
                        if name not in linked_names
                    ]
                    for name, value in zip(candidate_names, values):
                        inputs.setdefault(name, _deepcopy(value))

            api_node: dict[str, Any] = {"class_type": class_type, "inputs": inputs}
            title = node.get("title")
            if title:
                api_node["_meta"] = {"title": title}
            self.api[_node_key(prefix, node_id)] = api_node

        # Capture links entering the subgraph output pseudo-node (-20).
        outputs: dict[int, Any] = graph_outputs if graph_outputs is not None else {}
        for link in link_map.values():
            if str(link[3]) == "-20":
                outputs[int(link[4] or 0)] = resolve_source(link[0])
        return outputs

    def _input_names_for_node(self, class_type: str) -> list[str]:
        return _schema_input_names(self.object_info, class_type)


def convert_workflow(workflow: Any) -> dict[str, dict[str, Any]]:
    workflow = _unwrap_workflow(workflow)
    if _is_api_workflow(workflow):
        return _deepcopy(workflow)
    if not isinstance(workflow, dict) or not isinstance(workflow.get("nodes"), list):
        raise ValueError("Workflow is neither API format nor a supported ComfyUI UI workflow")
    object_info = base._fetch_object_info() or {}
    return UIWorkflowConverter(workflow, object_info).convert()


def _safe_filename(name: str, fallback: str) -> str:
    name = Path(str(name or "")).name
    name = re.sub(r"[^A-Za-z0-9._ -]+", "_", name).strip(" .")
    return name or fallback


def _decode_data(data: str) -> bytes:
    payload = data.split(",", 1)[1] if "," in data else data
    return base64.b64decode(payload, validate=False)


def _write_url(url: str, target: Path) -> None:
    with requests.get(url, stream=True, timeout=(30, 600)) as response:
        response.raise_for_status()
        total = 0
        with target.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if not chunk:
                    continue
                total += len(chunk)
                if total > MAX_INPUT_BYTES:
                    raise ValueError(f"Input URL exceeds H3_MAX_INPUT_MB={MAX_INPUT_MB}")
                handle.write(chunk)


def save_input_files(job_id: str, files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not files:
        return []
    safe_job = re.sub(r"[^A-Za-z0-9._-]+", "_", str(job_id or "job"))
    subfolder = Path("h3_studio") / safe_job
    directory = COMFY_INPUT_DIR / subfolder
    directory.mkdir(parents=True, exist_ok=True)
    saved: list[dict[str, Any]] = []

    for index, item in enumerate(files):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "generic_file")
        mime = str(item.get("mime_type") or item.get("mimeType") or "")
        extension = mimetypes.guess_extension(mime.split(";", 1)[0]) if mime else None
        name = _safe_filename(item.get("name"), f"{role}_{index}{extension or '.bin'}")
        target = directory / name
        partial = target.with_suffix(target.suffix + ".partial")
        partial.unlink(missing_ok=True)

        try:
            if item.get("url"):
                _write_url(str(item["url"]), partial)
            elif item.get("data"):
                blob = _decode_data(str(item["data"]))
                if len(blob) > MAX_INPUT_BYTES:
                    raise ValueError(f"Input file {name} exceeds H3_MAX_INPUT_MB={MAX_INPUT_MB}")
                partial.write_bytes(blob)
            else:
                raise ValueError(f"Input file {name} has neither data nor URL")
            os.replace(partial, target)
        except Exception:
            partial.unlink(missing_ok=True)
            raise

        relative = (subfolder / name).as_posix()
        saved.append(
            {
                "role": role,
                "name": name,
                "relative": relative,
                "absolute": str(target),
                "mime_type": mime,
            }
        )
    return saved


def _frames_for_duration(seconds: float, fps: int) -> int:
    desired = max(1, round(float(seconds) * max(1, int(fps))))
    if desired <= 5:
        return 5
    return 5 + 17 * math.ceil((desired - 5) / 17)


def _find_nodes(workflow: dict[str, Any], predicate) -> list[tuple[str, dict[str, Any]]]:
    return [
        (node_id, node)
        for node_id, node in workflow.items()
        if isinstance(node, dict) and predicate(node)
    ]


def _chain_lora(workflow: dict[str, Any], lora_name: str, strength: float | None = None) -> None:
    if not lora_name:
        return
    for node in workflow.values():
        if node.get("class_type") == "LoraLoaderModelOnly" and node.get("inputs", {}).get("lora_name") == lora_name:
            if strength is not None:
                node["inputs"]["strength_model"] = strength
            return

    unets = _find_nodes(workflow, lambda node: node.get("class_type") == "UNETLoader")
    if not unets:
        return
    unet_id = unets[0][0]
    numeric_ids = [int(key) for key in workflow if str(key).isdigit()]
    new_id = str((max(numeric_ids) if numeric_ids else 0) + 1001)
    while new_id in workflow:
        new_id = str(int(new_id) + 1)

    consumers: list[tuple[str, str]] = []
    for node_id, node in workflow.items():
        for input_name, value in (node.get("inputs") or {}).items():
            if isinstance(value, list) and len(value) >= 2 and str(value[0]) == str(unet_id) and int(value[1]) == 0:
                consumers.append((node_id, input_name))

    workflow[new_id] = {
        "class_type": "LoraLoaderModelOnly",
        "inputs": {
            "model": [str(unet_id), 0],
            "lora_name": lora_name,
            "strength_model": 1.0 if strength is None else float(strength),
        },
    }
    for node_id, input_name in consumers:
        if node_id != new_id:
            workflow[node_id]["inputs"][input_name] = [new_id, 0]


def apply_parameters(workflow: dict[str, Any], params: dict[str, Any] | None) -> None:
    """Override only declared parameters; imported API graphs keep authored values.

    In particular, an absent parameters object must not reset the random seed,
    every authored clip length, or export FPS. Duration conversion uses H3's
    native 24 fps unless the caller explicitly supplies fps as well.
    """
    if not isinstance(params, dict) or not params:
        return

    prompt_requested = "prompt" in params or "prompt_prefix" in params
    prefix = str(params.get("prompt_prefix") or "")
    negative_requested = "negative_prompt" in params
    negative = str(params.get("negative_prompt") or "")
    seed = int(params["seed"]) if "seed" in params else None
    fps = int(params["fps"]) if "fps" in params else None
    frames = (
        _frames_for_duration(float(params["duration_seconds"]), fps if fps is not None else 24)
        if "duration_seconds" in params else None
    )

    def final_prompt(authored: str) -> str:
        prompt = str(params["prompt"] or "") if "prompt" in params else authored
        return ", ".join(part for part in (prefix, prompt) if part)

    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        inputs = node.setdefault("inputs", {})
        class_type = str(node.get("class_type") or "")
        title = str(node.get("_meta", {}).get("title") or "").lower()

        if prompt_requested and isinstance(inputs.get("prompt"), str):
            inputs["prompt"] = final_prompt(inputs["prompt"])
        if prompt_requested and class_type == "CLIPTextEncode" and isinstance(inputs.get("text"), str) and "negative" not in title:
            inputs["text"] = final_prompt(inputs["text"])
        if negative_requested:
            if isinstance(inputs.get("negative_prompt"), str):
                inputs["negative_prompt"] = negative
            if class_type == "CLIPTextEncode" and isinstance(inputs.get("text"), str) and "negative" in title:
                inputs["text"] = negative

        for key in ("noise_seed", "seed", "random_seed"):
            if seed is not None and key in inputs and not isinstance(inputs[key], list):
                inputs[key] = seed
        if "steps" in params and "steps" in inputs and not isinstance(inputs["steps"], list):
            inputs["steps"] = int(params["steps"])
        if "denoise" in params and "denoise" in inputs and not isinstance(inputs["denoise"], list):
            inputs["denoise"] = float(params["denoise"])
        for key in ("length", "num_frames", "frame_count"):
            if frames is not None and key in inputs and not isinstance(inputs[key], list):
                inputs[key] = frames
        if fps is not None and "fps" in inputs and not isinstance(inputs["fps"], list):
            inputs["fps"] = fps
        if "aspect_ratio" in params and "aspect_ratio" in inputs and not isinstance(inputs["aspect_ratio"], list):
            inputs["aspect_ratio"] = params["aspect_ratio"]
        if "megapixels" in params and "megapixels" in inputs and not isinstance(inputs["megapixels"], list):
            inputs["megapixels"] = float(params["megapixels"])
        if "shift_video" in params and "shift_video" in inputs and not isinstance(inputs["shift_video"], list):
            inputs["shift_video"] = float(params["shift_video"])
        if "shift_audio" in params and "shift_audio" in inputs and not isinstance(inputs["shift_audio"], list):
            inputs["shift_audio"] = float(params["shift_audio"])
        if "output_prefix" in params and "filename_prefix" in inputs:
            inputs["filename_prefix"] = str(params["output_prefix"])
        if params.get("base_model") and class_type == "UNETLoader":
            model = str(params["base_model"])
            if model.endswith(".safetensors"):
                inputs["unet_name"] = model

    lora_name = str(params.get("lora_name") or "")
    if lora_name:
        _chain_lora(workflow, lora_name, float(params["lora_strength"]) if "lora_strength" in params else None)


def apply_explicit_overrides(workflow: dict[str, Any], overrides: Any) -> None:
    if not isinstance(overrides, list):
        return
    for item in overrides:
        if not isinstance(item, dict):
            continue
        input_name = item.get("input") or item.get("input_name")
        if not input_name:
            continue
        if item.get("node_id") is not None:
            node = workflow.get(str(item["node_id"]))
            if isinstance(node, dict):
                node.setdefault("inputs", {})[input_name] = item.get("value")
            continue
        for node in workflow.values():
            if not isinstance(node, dict):
                continue
            if item.get("class_type") and node.get("class_type") != item["class_type"]:
                continue
            if item.get("title") and node.get("_meta", {}).get("title") != item["title"]:
                continue
            if item.get("only_existing") and input_name not in node.get("inputs", {}):
                continue
            node.setdefault("inputs", {})[input_name] = item.get("value")


def _title(node: dict[str, Any]) -> str:
    return str(node.get("_meta", {}).get("title") or "").lower()


def _file_input_field(node: dict[str, Any], kind: str) -> str | None:
    inputs = node.get("inputs") or {}
    candidates = {
        "image": ("image", "filename", "file", "path", "image_path"),
        "video": ("video", "video_path", "file", "path", "filename"),
        "audio": ("audio", "audio_path", "file", "path", "filename"),
    }[kind]
    for name in candidates:
        if name in inputs:
            return name
    return None


def bind_media(workflow: dict[str, Any], saved: list[dict[str, Any]]) -> None:
    image_nodes = _find_nodes(
        workflow,
        lambda node: "image" in str(node.get("class_type", "")).lower()
        and ("load" in str(node.get("class_type", "")).lower() or _file_input_field(node, "image")),
    )
    video_nodes = _find_nodes(
        workflow,
        lambda node: "video" in str(node.get("class_type", "")).lower()
        and ("load" in str(node.get("class_type", "")).lower() or _file_input_field(node, "video")),
    )
    audio_nodes = _find_nodes(
        workflow,
        lambda node: "audio" in str(node.get("class_type", "")).lower()
        and ("load" in str(node.get("class_type", "")).lower() or _file_input_field(node, "audio")),
    )

    role_priority = {
        "first_frame": ("first", "start"),
        "last_frame": ("last", "end"),
        "reference_image": ("reference", "ref"),
        "mask": ("mask",),
        "source_video": ("source", "video"),
        "reference_video": ("reference", "ref"),
        "source_audio": ("source", "audio", "voice"),
        "reference_audio": ("reference", "ref", "voice"),
    }
    used: set[str] = set()

    def choose(nodes: list[tuple[str, dict[str, Any]]], role: str) -> tuple[str, dict[str, Any]] | None:
        hints = role_priority.get(role, ())
        for pair in nodes:
            if pair[0] in used:
                continue
            if any(hint in _title(pair[1]) for hint in hints):
                return pair
        return next((pair for pair in nodes if pair[0] not in used), None)

    for item in saved:
        role = item["role"]
        mime = item.get("mime_type", "")
        if role in {"first_frame", "last_frame", "reference_image", "mask"} or mime.startswith("image/"):
            kind, nodes = "image", image_nodes
        elif role in {"source_video", "reference_video"} or mime.startswith("video/"):
            kind, nodes = "video", video_nodes
        elif role in {"source_audio", "reference_audio"} or mime.startswith("audio/"):
            kind, nodes = "audio", audio_nodes
        else:
            # Generic file: attempt any loader with a file/path input.
            candidates = _find_nodes(
                workflow,
                lambda node: any(name in (node.get("inputs") or {}) for name in ("file", "path", "filename")),
            )
            pair = next((pair for pair in candidates if pair[0] not in used), None)
            if pair:
                field = next(name for name in ("file", "path", "filename") if name in pair[1]["inputs"])
                pair[1]["inputs"][field] = item["relative"]
                used.add(pair[0])
            continue

        pair = choose(nodes, role)
        if not pair:
            continue
        node_id, node = pair
        field = _file_input_field(node, kind)
        if field:
            # Path fields often accept absolute paths; combo/file fields normally
            # expect an input-directory relative name.
            value = item["absolute"] if "path" in field else item["relative"]
            node.setdefault("inputs", {})[field] = value
            used.add(node_id)


def _collect_legacy_images(job_input: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index, image in enumerate(job_input.get("images") or []):
        if not isinstance(image, dict) or not image.get("image"):
            continue
        result.append(
            {
                "role": "first_frame" if index == 0 else "reference_image",
                "name": image.get("name") or f"input_{index}.png",
                "mime_type": "image/png",
                "data": image["image"],
            }
        )
    return result


# Promote video/audio/file history entries to the stock handler's `images`
# channel. `/view` returns arbitrary output files, so the stock encoder can
# base64/S3-return MP4, WAV, etc. without rewriting its execution loop.
_original_get_history = base.get_history


def _promoting_get_history(prompt_id: str) -> dict[str, Any]:
    history = _original_get_history(prompt_id)
    prompt = history.get(prompt_id, {}) if isinstance(history, dict) else {}
    outputs = prompt.get("outputs", {}) if isinstance(prompt, dict) else {}
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        promoted = list(node_output.get("images") or [])
        seen = {
            (item.get("filename"), item.get("subfolder", ""), item.get("type"))
            for item in promoted
            if isinstance(item, dict)
        }
        for key, value in list(node_output.items()):
            if key == "images" or key not in MEDIA_OUTPUT_KEYS:
                continue
            values = value if isinstance(value, list) else [value]
            for item in values:
                if not isinstance(item, dict) or not item.get("filename"):
                    continue
                normalized = {
                    "filename": item["filename"],
                    "subfolder": item.get("subfolder", ""),
                    "type": item.get("type", "output"),
                }
                signature = (normalized["filename"], normalized["subfolder"], normalized["type"])
                if signature not in seen:
                    promoted.append(normalized)
                    seen.add(signature)
        if promoted:
            node_output["images"] = promoted
    return history


base.get_history = _promoting_get_history


def handler(job: dict[str, Any]) -> dict[str, Any]:
    incoming = job.get("input")
    if not isinstance(incoming, dict):
        return {"error": "Input must be a JSON object"}
    try:
        workflow = convert_workflow(incoming.get("workflow"))
        files = list(incoming.get("files") or [])
        files.extend(_collect_legacy_images(incoming))
        saved = save_input_files(str(job.get("id") or "job"), files)
        apply_parameters(workflow, incoming.get("parameters") or {})
        bind_media(workflow, saved)
        apply_explicit_overrides(workflow, incoming.get("explicit_overrides"))

        delegated = dict(job)
        delegated["input"] = {
            "workflow": workflow,
            "images": None,
            "comfy_org_api_key": incoming.get("comfy_org_api_key"),
        }
        result = base.handler(delegated)
        if isinstance(result, dict) and result.get("images"):
            result.setdefault("files", result["images"])
        if isinstance(result, dict):
            result.setdefault("workflow_format", "api" if _is_api_workflow(_unwrap_workflow(incoming.get("workflow"))) else "ui-converted")
            if saved:
                result.setdefault("input_files", [{"role": x["role"], "name": x["name"]} for x in saved])
        return result
    except Exception as exc:
        return {
            "error": str(exc),
            "error_type": type(exc).__name__,
            "hint": (
                "For conversion failures, import an API-format workflow once in the browser app. "
                "For missing loader bindings, add an explicit node override or rename the loader title."
            ),
        }


if __name__ == "__main__":
    print("worker-comfyui - Starting enhanced H3 handler...")
    runpod.serverless.start({"handler": handler})


