# Icon captioner (experimental)

Local OmniParser v2 icon captioner (fine-tuned Florence-2, MIT) that jevb's device backend
calls as a fallback. When Jev finds no confident match on a native (app) screen with
unlabeled controls (a bare `Button` or `Image`), jevb takes one screenshot, gets
`icon: <caption>` labels for those controls, and asks Jev once more. It is off unless this
service is running (`JEVB_CAPTION_URL`, default `http://127.0.0.1:7799`).

```bash
uv venv -p 3.12 .venv && uv pip install torch transformers==4.45.2 timm einops pillow huggingface_hub
.venv/bin/python server.py      # downloads ~1GB of weights on first run; uses Apple GPU (MPS)
```

Results so far (2026-09-28), on Treechat's unlabeled controls:
- Common icons work: "search" picked a magnifier captioned "Search" (0.83; none without).
- Steps that describe how a control looks can work: "tap the tree logo at the top left"
  (0.95 against none) when the logo was captioned "A plant or tree branch".
- Captions vary with crop size and theme. The same logo, captioned "A tree or plant growth
  indicator" on an iPhone, dropped Jev to 0.04. A misleading caption does worse than none.
- A caption describes what an icon looks like, not what it does, so "open the sidebar menu"
  still fails on a logo-shaped menu button. The fix for that is an accessible label in the
  app (`aria-label`).
