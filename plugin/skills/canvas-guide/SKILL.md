---
name: canvas-guide
description: Show rendered content to the user in the Claude Canvas panel in VS Code with the canvas_push tool. Load before drawing a chart or figure, writing a formula-heavy explanation, showing an image or diagram, or producing a long table or report, and whenever the user asks to put something "on the canvas".
---

# Claude Canvas

The canvas is a webview panel beside the terminal in VS Code. Cards appear in push order; the newest
is at the bottom. Nothing goes there by itself: you decide, per answer, whether it deserves a card.
Push when rendering adds something the terminal cannot show (typeset math, a plot, a diagram, an
image, a wide table); plain prose, short answers and status updates stay in the terminal. (The
`mirrorAnswers` option in `/config` copies every answer there as well; it is off by default.)

## What renders

| Content | How to push it |
|---|---|
| Formulas | Markdown with KaTeX: `$$ … $$` on its own lines, `$ … $` inline, or a ```` ```math ```` fence |
| Diagrams | A ```` ```mermaid ```` fence inside markdown |
| Tables, code, headings | Plain GitHub-flavoured markdown; code fences are highlighted |
| Static chart | An inline `<svg>` inside markdown (html passthrough is on), or `kind: svg` with the SVG source as body |
| Interactive chart | `kind: html` with a self-contained page as body (Plotly, D3, Chart.js from a CDN are fine, the frame may load https scripts); set `height` |
| Image file | `kind: image` with `path` (absolute), or a markdown `![…](/abs/path.png)`; files are copied into the canvas folder |
| Live view | Any kind with a `slot`; the next push to that slot replaces the card in place |

## Recipes

A chart from Python, host-side, pushed as a file:

```python
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(8, 3)); ax.plot(t, y); fig.savefig("/tmp/plot.svg", bbox_inches="tight")
```

then `canvas_push(kind="image", title="Latency over time", path="/tmp/plot.svg")`. Prefer SVG over
PNG for plots: it stays sharp at any panel width and follows no DPI.

A formula explanation: write the full version as markdown with LaTeX and push it with
`kind="markdown"`; the terminal answer then carries the conclusion and the card's name.

A dashboard that updates as you work: `canvas_push(kind="markdown", slot="progress", title="Batch
progress", body=table)` on every milestone; the card updates in place.

## Rules of thumb

- One idea per card. A card with a title the user can find again beats a wall of content.
- After a push, keep the terminal answer short and name the card; do not repeat its content.
- The tool result says `canvasOpen: false` when nobody is looking; the card then waits in the feed.
  Say so in one line rather than pushing more.
- Never push secrets or credentials; the canvas folder (`~/.claude/canvas/`) is plain files on disk.
- `canvas_clear` or `/canvas clear` moves every card to `history/`; nothing is deleted.
