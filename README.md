# Minimax Studio

Serverless MiniMax H3 ComfyUI worker and a real video-generation web studio.

- Dockerfile, extra_model_paths.yaml and handler_enhanced.py: RunPod worker image.
- studio/: portable Next.js UI. Run npm install and npm run dev there, then enter your endpoint and API key in Connect RunPod.
- The studio includes20 H3 generation/edit/reference tools, correct API workflow requests, your model/LoRA inventory, uploads, job management and playable outputs.

Read studio/README.md for setup and verification. Rebuild the worker after updating the enhanced handler to preserve imported workflows when overrides are absent.

