FROM runpod/worker-comfyui:5.8.4-base

USER root
WORKDIR /comfyui

ENV COMFY_LOG_LEVEL=INFO
ENV PYTHONUNBUFFERED=1

ENV CC=/usr/bin/gcc
ENV CXX=/usr/bin/g++

# Faster Hugging Face / Xet downloads when using download_models.sh
ENV HF_XET_HIGH_PERFORMANCE=1
ENV HF_HUB_DISABLE_TELEMETRY=1

# ---------------------------------------------------------
# System dependencies
# ---------------------------------------------------------
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
        && \
    rm -rf /var/lib/apt/lists/*

# Verify compiler + Python headers
RUN gcc --version && \
    g++ --version && \
    ffmpeg -version && \
    ffprobe -version && \
    test -f /usr/include/python3.12/Python.h && \
    echo "System dependencies OK"

# ---------------------------------------------------------
# Pin ComfyUI
# ---------------------------------------------------------
RUN git fetch --depth 1 origin tag v0.38.2 && \
    git checkout --detach v0.38.2

# ---------------------------------------------------------
# PyTorch CUDA 13
# ---------------------------------------------------------
RUN uv pip install --python /opt/venv/bin/python \
    "torch==2.11.0+cu130" \
    "torchvision==0.26.0+cu130" \
    "torchaudio==2.11.0+cu130" \
    --index-url https://download.pytorch.org/whl/cu130

# ---------------------------------------------------------
# ComfyUI requirements
# ---------------------------------------------------------
RUN uv pip install --python /opt/venv/bin/python \
    -r /comfyui/requirements.txt

# Useful runtime/download packages
RUN uv pip install --python /opt/venv/bin/python \
    "huggingface_hub[hf_xet]" \
    imageio-ffmpeg

# ---------------------------------------------------------
# Custom nodes
# ---------------------------------------------------------
RUN mkdir -p /comfyui/custom_nodes

# ---------------------------------------------------------
# KJNodes
# General H3 / attention / utility nodes
# ---------------------------------------------------------
RUN git clone --depth 1 \
    https://github.com/kijai/ComfyUI-KJNodes.git \
    /comfyui/custom_nodes/ComfyUI-KJNodes

# ---------------------------------------------------------
# Video Helper Suite
# Needed by several video extension / bridge workflows
# ---------------------------------------------------------
RUN git clone --depth 1 \
    https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite.git \
    /comfyui/custom_nodes/ComfyUI-VideoHelperSuite

# ---------------------------------------------------------
# H3 Motion Context / MultiRef
#
# Provides:
# - Extend Video
# - AV Extension
# - AV Bridge
# - custom keyframes
# - V2V motion transfer
# - connected music-video sequences
# ---------------------------------------------------------
RUN git clone --depth 1 \
    https://github.com/seitanism/ComfyUI-H3-Motion-Context-MultiRef.git \
    /comfyui/custom_nodes/ComfyUI-H3-Motion-Context-MultiRef

# ---------------------------------------------------------
# FL MiniMax H3
#
# Provides:
# - timelines
# - temporal reshots
# - shot assembly
# - upscale/refine workflows
# ---------------------------------------------------------
RUN git clone --depth 1 \
    https://github.com/filliptm/ComfyUI-FL-MiniMaxH3.git \
    /comfyui/custom_nodes/ComfyUI-FL-MiniMaxH3

# ---------------------------------------------------------
# H3 Director
#
# Provides:
# - T2V director
# - FL2V director
# - R2V director
# - V2V director
# - RV2V director
# - multi-segment timeline
# ---------------------------------------------------------
RUN git clone --depth 1 \
    https://github.com/AIMixer/ComfyUI_MiniMaxH3_Director.git \
    /comfyui/custom_nodes/ComfyUI_MiniMaxH3_Director

# ---------------------------------------------------------
# H3 Video Outpaint
#
# Provides generative video expansion / reframing
# ---------------------------------------------------------
RUN git clone --depth 1 \
    https://github.com/TwoAbove/ComfyUI-H3VideoOutpaint.git \
    /comfyui/custom_nodes/ComfyUI-H3VideoOutpaint

# ---------------------------------------------------------
# H3 Edit
#
# Provides:
# - still-image generation
# - image editing
# - semantic/native references
# - character sheets
# - scene coverage
# ---------------------------------------------------------
RUN git clone --depth 1 \
    https://github.com/ethanfel/ComfyUI-MiniMax-H3-Edit.git \
    /comfyui/custom_nodes/ComfyUI-MiniMax-H3-Edit

# ---------------------------------------------------------
# H3 Studio
#
# Pinned release instead of development HEAD because
# the project is currently alpha.
# ---------------------------------------------------------
RUN git clone \
    --branch v0.1.0-alpha.20 \
    --depth 1 \
    https://github.com/thaakeno/ComfyUI-MiniMax-H3-Studio.git \
    /comfyui/custom_nodes/ComfyUI-MiniMax-H3-Studio

# ---------------------------------------------------------
# H3 Relight
#
# Relight controller feeding H3 Edit.
# ---------------------------------------------------------
RUN git clone --depth 1 \
    https://github.com/NyckM/H3-Relight-Minimax-ComfyUI.git \
    /comfyui/custom_nodes/H3-Relight-Minimax-ComfyUI

# ---------------------------------------------------------
# H3 Audio / Avatar / Voice workflows
#
# Provides:
# - audio references
# - avatar workflows
# - talking / singing
# - audio lock
# - long AV workflows
# ---------------------------------------------------------
RUN git clone --depth 1 \
    https://github.com/T8mars/comfyui-minimax-h3-audio-T8.git \
    /comfyui/custom_nodes/minimax-h3-audio-T8

# ---------------------------------------------------------
# H3 Latent Upscaler
# ---------------------------------------------------------
RUN git clone --depth 1 \
    https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler.git \
    /comfyui/custom_nodes/Comfyui_Minimax_h3_latent_Upscaler

# ---------------------------------------------------------
# MAINodes
# Used by some Motion Context / high-res examples
# ---------------------------------------------------------
RUN git clone --depth 1 \
    https://github.com/matlowai/ComfyUI-MAINodes.git \
    /comfyui/custom_nodes/ComfyUI-MAINodes

# ---------------------------------------------------------
# Install requirements for every custom node that has them
# ---------------------------------------------------------
RUN set -eux; \
    for NODE_DIR in /comfyui/custom_nodes/*; do \
        if [ -f "${NODE_DIR}/requirements.txt" ]; then \
            echo "Installing requirements for ${NODE_DIR}"; \
            uv pip install \
                --python /opt/venv/bin/python \
                -r "${NODE_DIR}/requirements.txt"; \
        fi; \
    done

# ---------------------------------------------------------
# SageAttention
# ---------------------------------------------------------
RUN uv pip install --python /opt/venv/bin/python \
    sageattention

# ---------------------------------------------------------
# Protect our PyTorch CUDA 13 versions
#
# Some community requirements may contain loose torch
# requirements. Verify rather than silently running a
# different torch build.
# ---------------------------------------------------------
RUN /opt/venv/bin/python - <<'PY'
import torch
import torchvision
import torchaudio

print("PyTorch:", torch.__version__)
print("Torchvision:", torchvision.__version__)
print("Torchaudio:", torchaudio.__version__)
print("CUDA:", torch.version.cuda)

assert torch.__version__.startswith("2.11.0")
assert torch.version.cuda == "13.0"
PY

# ---------------------------------------------------------
# Network-volume model paths
# ---------------------------------------------------------
COPY extra_model_paths.yaml /comfyui/extra_model_paths.yaml

# ---------------------------------------------------------
# Latent Upscaler compatibility
#
# The latent-upscaler project has historically preferred
# ComfyUI's primary latent_upscale_models directory.
#
# Point that directly at the RunPod network volume.
# The target can be absent during Docker build; it exists
# once /runpod-volume is mounted.
# ---------------------------------------------------------
RUN rm -rf /comfyui/models/latent_upscale_models && \
    ln -s /runpod-volume/models/latent_upscale_models \
        /comfyui/models/latent_upscale_models

# ---------------------------------------------------------
# Include model downloader in image.
#
# DO NOT run this during docker build.
# Models belong on the network volume.
# ---------------------------------------------------------
COPY download_models.sh /download_models.sh
RUN chmod +x /download_models.sh

# ---------------------------------------------------------
# Final verification
# ---------------------------------------------------------
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

required_nodes = [
    "ComfyUI-KJNodes",
    "ComfyUI-VideoHelperSuite",
    "ComfyUI-H3-Motion-Context-MultiRef",
    "ComfyUI-FL-MiniMaxH3",
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
