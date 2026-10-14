# MiniMax Studio

A real RunPod + ComfyUI web UI for open-weight MiniMax H3. Includes twenty feature workflows, media upload/URLs, model and LoRA selection, job polling/cancel/retry, JSON inspection/import, and output playback/download.

## Start

Requires Node 22.13+ and npm, pnpm, or another compatible package manager.

    npm install
    npm run dev

Open http://localhost:3000, enter your RunPod endpoint ID or https://api.runpod.ai/v2/ URL and API key, then test the connection. Keys stay in tab memory. Endpoint, models and job metadata can be stored locally without keys.

## Worker

Build the Dockerfile at repository root and mount the model inventory under /runpod-volume/models. Use the updated root handler_enhanced.py: omitted parameters preserve authored workflow settings; declared overrides apply only when provided. Generated catalog requests include explicit matching parameters and work with the prior handler too. Large media should use public/signed HTTPS URLs because the RunPod request body is limited to 10 MB.

## Verify

    npm test
    npm run typecheck
    python tests/media_binding.test.py
    npm run build

The Node tests generate work/tests/requests.json for the Python binding checks. The Python test imports ../handler_enhanced.py with GPU/deployment modules stubbed. No models or GPU are needed for schema/graph/transport tests.

The app has passed production builds with both standard Next.js and the hosted Vinext runtime. Live GPU quality and worker model/node availability depend on your endpoint.

See each tool's Workflow details for source-backed node references, model pairing, duration/media limits and compatibility notes. H3 Max hosted services are excluded. Base H3 fal generation has text, image/keyframes and multimodal-reference routes; edit/motion/style/voice use native reference conditioning.

## Sampling profiles

pDMD is built in for FL2VA: Euler/simple4 steps, shifts12/3, strength1, no CFG and standard attention for INT8. The user-provided mini-fast I2V recipe is an adaptation; REF2VA is excluded. FL2V4-step768p uses Euler/simple and shifts6/3. REF2V4-step uses Euler/simple and shifts12/3. FL2V8-step follows the mini-fast res_multistep/simple recipe. All presets and feature notes link to original requests and upstream sources.

