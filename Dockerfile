FROM runpod/worker-comfyui:5.8.4-base

USER root
WORKDIR /comfyui

ENV COMFY_LOG_LEVEL=INFO \
    PYTHONUNBUFFERED=1 \
    CC=/usr/bin/gcc \
    CXX=/usr/bin/g++ \
    HF_XET_HIGH_PERFORMANCE=1 \
    HF_HUB_DISABLE_TELEMETRY=1

# -----------------------------------------------------------------------------
# System packages used by ComfyUI, video/audio workflows, Triton and extensions.
# -----------------------------------------------------------------------------
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential \
        ninja-build \
        python3.12-dev \
        git \
        curl \
        wget \
        ffmpeg \
        libgl1 \
        libglib2.0-0 \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN gcc --version && \
    g++ --version && \
    ffmpeg -version && \
    ffprobe -version && \
    test -f /usr/include/python3.12/Python.h && \
    echo "System dependencies OK"

# -----------------------------------------------------------------------------
# Keep the ComfyUI version used by your tested H3 workflows.
# -----------------------------------------------------------------------------
RUN git fetch --depth 1 origin tag v0.38.2 && \
    git checkout --detach v0.38.2

# -----------------------------------------------------------------------------
# PyTorch CUDA 13 stack.
# -----------------------------------------------------------------------------
RUN uv pip install --python /opt/venv/bin/python \
    "torch==2.11.0+cu130" \
    "torchvision==0.26.0+cu130" \
    "torchaudio==2.11.0+cu130" \
    --index-url https://download.pytorch.org/whl/cu130

# -----------------------------------------------------------------------------
# ComfyUI core requirements.
# -----------------------------------------------------------------------------
RUN uv pip install --python /opt/venv/bin/python \
    -r /comfyui/requirements.txt

# -----------------------------------------------------------------------------
# Utilities used by the enhanced handler and H3 workflows.
# -----------------------------------------------------------------------------
RUN uv pip install --python /opt/venv/bin/python \
    "huggingface_hub[hf_xet]" \
    imageio-ffmpeg \
    requests

# -----------------------------------------------------------------------------
# MiniMax H3 custom nodes used by the workflow catalog and browser Studio.
# -----------------------------------------------------------------------------
RUN mkdir -p /comfyui/custom_nodes

# General H3 utilities and attention patching.
RUN git clone --depth 1 \
    https://github.com/kijai/ComfyUI-KJNodes.git \
    /comfyui/custom_nodes/ComfyUI-KJNodes

# Video loading, combining and output helpers.
RUN git clone --depth 1 \
    https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git \
    /comfyui/custom_nodes/ComfyUI-VideoHelperSuite

# Long-form H3 extension, references and clip assembly.
RUN git clone --depth 1 \
    https://github.com/tritant/ComfyUI_MiniMax_H3_Extender.git \
    /comfyui/custom_nodes/ComfyUI_MiniMax_H3_Extender

# AV extension, AV bridge, motion transfer and keyframe workflows.
RUN git clone --depth 1 \
    https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef.git \
    /comfyui/custom_nodes/ComfyUI-H3-Motion-Context-MultiRef

# Timelines, temporal reshots, shot assembly and H3 refinement tools.
RUN git clone --depth 1 \
    https://github.com/filliptm/ComfyUI-FL-MiniMaxH3.git \
    /comfyui/custom_nodes/ComfyUI-FL-MiniMaxH3

# Utility nodes required by some FL/timeline/API workflows.
RUN git clone --depth 1 \
    https://github.com/filliptm/ComfyUI_Fill-Nodes.git \
    /comfyui/custom_nodes/ComfyUI_Fill-Nodes

# Multi-segment H3 Director workflows.
RUN git clone --depth 1 \
    https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director.git \
    /comfyui/custom_nodes/ComfyUI_MiniMaxH3_Director

# H3 generative video expansion and reframing.
RUN git clone --depth 1 \
    https://github.com/TwoAbove/ComfyUI-H3VideoOutpaint.git \
    /comfyui/custom_nodes/ComfyUI-H3VideoOutpaint

# H3 one-frame generation, editing and reference workflows.
RUN git clone --depth 1 \
    https://github.com/ethanfel/ComfyUI-MiniMax-H3-Edit.git \
    /comfyui/custom_nodes/ComfyUI-MiniMax-H3-Edit

# Reproducible release of the H3 still-image Studio.
RUN git clone --branch v0.1.0-alpha.20 --depth 1 \
    https://github.com/thaakeno/ComfyUI-MiniMax-H3-Studio.git \
    /comfyui/custom_nodes/ComfyUI-MiniMax-H3-Studio

# H3 lighting-reference controller. It works with H3 Edit.
RUN git clone --depth 1 \
    https://github.com/NyckM/H3-Relight-Minimax-ComfyUI.git \
    /comfyui/custom_nodes/H3-Relight-Minimax-ComfyUI

# H3 audio reference, avatar, talking and singing workflows.
RUN git clone --depth 1 \
    https://github.com/T8mars/comfyui-minimax-h3-audio-T8.git \
    /comfyui/custom_nodes/minimax-h3-audio-T8

# H3 neural latent upscaler.
RUN git clone --depth 1 \
    https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git \
    /comfyui/custom_nodes/Comfyui_Minimax_h3_latent_Upscaler

# H3 Contact Sheet and Motion Lab workflows.
RUN git clone --depth 1 \
    https://github.com/matlowai/ComfyUI-MAINodes.git \
    /comfyui/custom_nodes/ComfyUI-MAINodes

# -----------------------------------------------------------------------------
# Install requirements exposed by each node pack.
# -----------------------------------------------------------------------------
RUN set -eux; \
    for NODE_DIR in /comfyui/custom_nodes/*; do \
        if [ -f "${NODE_DIR}/requirements.txt" ]; then \
            echo "Installing requirements for ${NODE_DIR}"; \
            uv pip install --python /opt/venv/bin/python \
                -r "${NODE_DIR}/requirements.txt"; \
        fi; \
    done

# -----------------------------------------------------------------------------
# SageAttention used by your tested H3 worker configuration.
# -----------------------------------------------------------------------------
RUN uv pip install --python /opt/venv/bin/python \
    sageattention

# -----------------------------------------------------------------------------
# Ensure a custom-node requirement did not replace the CUDA/PyTorch stack.
# -----------------------------------------------------------------------------
RUN /opt/venv/bin/python - <<'PY'
import torch
import torchvision
import torchaudio

print("PyTorch:", torch.__version__)
print("Torchvision:", torchvision.__version__)
print("Torchaudio:", torchaudio.__version__)
print("PyTorch CUDA:", torch.version.cuda)

assert torch.__version__.startswith("2.11.0")
assert torch.version.cuda == "13.0"
PY

# -----------------------------------------------------------------------------
# RunPod Network Volume model paths.
# -----------------------------------------------------------------------------
COPY extra_model_paths.yaml /comfyui/extra_model_paths.yaml

# Some latent-upscaler versions scan ComfyUI's primary model folder directly.
# Point that folder at the same Network Volume directory.
RUN rm -rf /comfyui/models/latent_upscale_models && \
    ln -s /runpod-volume/models/latent_upscale_models \
        /comfyui/models/latent_upscale_models

# -----------------------------------------------------------------------------
# Enhanced H3 RunPod handler used by the downloadable browser Studio.
#
# The base image already owns /handler.py. Preserve it as /handler_base.py.
# The enhanced wrapper then delegates execution to the official handler while
# adding:
#
# - image, video and audio uploads;
# - base64 and URL inputs;
# - ComfyUI UI-workflow to API conversion;
# - common parameter injection;
# - MP4, audio and generic file outputs.
# -----------------------------------------------------------------------------
RUN test -f /handler.py && \
    cp /handler.py /handler_base.py

COPY handler_enhanced.py /handler.py

ENV H3_MAX_INPUT_MB=500 \
    COMFY_INPUT_DIR=/comfyui/input

RUN /opt/venv/bin/python -m py_compile \
    /handler.py \
    /handler_base.py

# -----------------------------------------------------------------------------
# Build-time validation.
#
# A GPU is normally unavailable during Docker build, so CUDA availability is
# printed but is not asserted.
# -----------------------------------------------------------------------------
RUN /opt/venv/bin/python - <<'PY'
import os
import shutil
import torch
import sageattention
import triton

print("")
print("============ BUILD VERIFICATION ============")
print("PyTorch:", torch.__version__)
print("PyTorch CUDA:", torch.version.cuda)
print("CUDA visible during build:", torch.cuda.is_available())
print("Triton:", triton.__version__)
print("SageAttention: imported successfully")
print("CC:", os.environ.get("CC"))
print("CXX:", os.environ.get("CXX"))
print("gcc:", shutil.which("gcc"))
print("g++:", shutil.which("g++"))
print("ffmpeg:", shutil.which("ffmpeg"))
print("ffprobe:", shutil.which("ffprobe"))

assert torch.version.cuda == "13.0"
assert shutil.which("gcc")
assert shutil.which("g++")
assert shutil.which("ffmpeg")
assert shutil.which("ffprobe")
assert os.path.exists("/usr/include/python3.12/Python.h")
assert os.path.isfile("/handler.py")
assert os.path.isfile("/handler_base.py")
assert os.path.isfile("/comfyui/extra_model_paths.yaml")

required_nodes = [
    "ComfyUI-KJNodes",
    "ComfyUI-VideoHelperSuite",
    "ComfyUI_MiniMax_H3_Extender",
    "ComfyUI-H3-Motion-Context-MultiRef",
    "ComfyUI-FL-MiniMaxH3",
    "ComfyUI_Fill-Nodes",
    "ComfyUI_MiniMaxH3_Director",
    "ComfyUI-H3VideoOutpaint",
    "ComfyUI-MiniMax-H3-Edit",
    "ComfyUI-MiniMax-H3-Studio",
    "H3-Relight-Minimax-ComfyUI",
    "minimax-h3-audio-T8",
    "Comfyui_Minimax_h3_latent_Upscaler",
    "ComfyUI-MAINodes",
]

for node in required_nodes:
    path = f"/comfyui/custom_nodes/{node}"
    assert os.path.isdir(path), f"Missing custom node: {node}"
    print("OK:", node)

print("")
print("All H3 serverless dependencies installed.")
print("============================================")
PY

WORKDIR /

# Do not set ENTRYPOINT or CMD.
# The base image keeps its original RunPod startup command, which launches
# /handler.py. That path now contains the enhanced wrapper.
