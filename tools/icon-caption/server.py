# Local icon captioner for jevb: OmniParser v2's fine-tuned Florence-2 (MIT).
# POST /caption {"images": [<base64 png>...]} -> {"captions": [...], "ms": N}
#   or {"screenshot": <base64 png>, "boxes": [[x, y, w, h], ...]} (screenshot px):
#   crops server-side, so callers need no image library. Captions are cached
#   by crop bytes.
# Loads the model once; runs on Apple GPU (MPS) when available.
#
#   uv venv -p 3.12 .venv && uv pip install torch transformers==4.45.2 timm einops pillow huggingface_hub
#   .venv/bin/python server.py   # JEVB_CAPTION_PORT (default 7799), OMNI_WEIGHTS (default ./weights)
import base64, io, json, os, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

import torch
from PIL import Image
from transformers import AutoModelForCausalLM, AutoProcessor
from transformers.dynamic_module_utils import get_imports

WEIGHTS = os.environ.get('OMNI_WEIGHTS', os.path.join(os.path.dirname(__file__), 'weights'))
PORT = int(os.environ.get('JEVB_CAPTION_PORT', 7799))
DEVICE = 'mps' if torch.backends.mps.is_available() else 'cpu'


def no_flash_attn(path):
    # Florence-2's remote code imports flash_attn, which only exists for CUDA.
    return [i for i in get_imports(path) if i != 'flash_attn']


def load():
    if not os.path.exists(os.path.join(WEIGHTS, 'icon_caption', 'model.safetensors')):
        from huggingface_hub import hf_hub_download
        for f in ['config.json', 'generation_config.json', 'model.safetensors']:
            hf_hub_download('microsoft/OmniParser-v2.0', f'icon_caption/{f}', local_dir=WEIGHTS)
    with patch('transformers.dynamic_module_utils.get_imports', no_flash_attn):
        processor = AutoProcessor.from_pretrained('microsoft/Florence-2-base', trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(os.path.join(WEIGHTS, 'icon_caption'),
                                                     torch_dtype=torch.float32, trust_remote_code=True).to(DEVICE)
    return processor, model.eval()


PROCESSOR, MODEL = load()


CACHE = {}


def caption(crops):
    # OmniParser's recipe: each crop resized to 64x64, task prompt <CAPTION>.
    crops = [c.convert('RGB').resize((64, 64)) for c in crops]
    keys = [hash(c.tobytes()) for c in crops]
    todo = [i for i, k in enumerate(keys) if k not in CACHE]
    if todo:
        for i, text in zip(todo, run([crops[i] for i in todo])):
            CACHE[keys[i]] = text
    return [CACHE[k] for k in keys]


def run(crops):
    inputs = PROCESSOR(images=crops, text=['<CAPTION>'] * len(crops), return_tensors='pt', do_resize=False).to(DEVICE)
    with torch.inference_mode():
        ids = MODEL.generate(input_ids=inputs['input_ids'], pixel_values=inputs['pixel_values'],
                             max_new_tokens=20, num_beams=1, do_sample=False)
    return [t.strip() for t in PROCESSOR.batch_decode(ids, skip_special_tokens=True)]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        t = time.time()
        try:
            if 'screenshot' in body:
                shot = Image.open(io.BytesIO(base64.b64decode(body['screenshot'])))
                crops = [shot.crop((x, y, x + w, y + h)) for x, y, w, h in body.get('boxes', [])]
            else:
                crops = [Image.open(io.BytesIO(base64.b64decode(b))) for b in body.get('images', [])]
            out = {'captions': caption(crops), 'ms': round((time.time() - t) * 1000)}
            code = 200
        except Exception as e:  # report, don't crash the server
            out, code = {'error': str(e)}, 500
        data = json.dumps(out).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # health check
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'ok')

    def log_message(self, *a):
        pass


if __name__ == '__main__':
    print(f'icon captioner on 127.0.0.1:{PORT} ({DEVICE})', flush=True)
    HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
