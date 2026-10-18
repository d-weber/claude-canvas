# Claude Canvas

A rendered canvas beside your terminal in VS Code, fed by Claude Code.

You keep the Claude Code CLI in the integrated terminal, with its usage, settings and subagent
views. The canvas is a webview panel next to it that renders what a terminal cannot: Markdown
with **KaTeX math**, **Mermaid** diagrams, highlighted code, tables, images, SVG charts and whole
**HTML pages** (Plotly, D3, …). The model gets a `canvas_push` tool and decides, per answer, when a
card is worth it: a formula-heavy explanation, a chart, a figure, a diagram, a report, a live view.
Plain prose stays in the terminal (an option mirrors every answer, off by default).

```
┌──────────────────────────────┬──────────────────────────────┐
│ $ claude                     │ Claude Canvas                │
│ > plot the latency histogram │ ┌─ Latency histogram ──────┐ │
│ ⏺ canvas_push(kind=image…)   │ │  ▂▅█▇▅▃▂▁                │ │
│ ⏺ Pushed "Latency histogram" │ │                          │ │
│   to the canvas.             │ └──────────────────────────┘ │
│                              │ ┌─ Derivation ─────────────┐ │
│ ctx 41% · 2 agents · $0.31   │ │ p99 = F⁻¹(0.99) (typeset)│ │
│                              │ │                          │ │
└──────────────────────────────┴──────────────────────────────┘
```

Two halves, one repo:

| Folder | What | Runs in |
|---|---|---|
| `extension/` | The VS Code extension: the webview panel, the drop-folder watcher, the heartbeat | VS Code |
| `plugin/` | The Claude Code plugin: `canvas_push` / `canvas_clear` tools, `/canvas` command, system-prompt section, optional answer mirror, `canvas-guide` skill | every Claude Code session (terminal or panel mode) |

## How it works

The transport is a folder, `~/.claude/canvas/` by default:

```
~/.claude/canvas/
  feed/      one file per card, in push order: <epoch_ms>-<slug>.json envelopes,
             or bare .md / .html / .svg / .png … files dropped by anything
  assets/    copies of referenced local files (so the webview may serve them)
  history/   where cleared and replaced cards go (nothing is deleted)
  inbox/     the return channel (page → agent), reserved
  alive      heartbeat the extension rewrites every 5 s while the panel exists
```

The extension watches `feed/`. A new file becomes a card; a `slot` replaces the card with the same
slot in place; `{"kind":"clear"}` moves everything to `history/`; `{"kind":"open"}` reveals the
panel. The plugin writes the same envelopes through `$.fs.write`, reads `alive` to know whether
anyone is looking, and only then tells the model about the canvas (and, with `mirrorAnswers` on,
copies every final answer there).

An envelope:

```json
{ "v": 1, "kind": "markdown", "title": "Latency", "slot": "latency",
  "body": "## p99\n\n$$p_{99}=F^{-1}(0.99)$$\n\n![](/tmp/latency.svg)", "source": "tool" }
```

`kind` is `markdown`, `html` (body = a full document, shown in a sandboxed iframe; `height` in px),
`image` (`path` to a file, or a `data:` body), `svg` (body = SVG source), `clear` or `open`.
Local image paths in markdown are copied into `assets/` and rewritten.

Anything can push: `cp report.md ~/.claude/canvas/feed/$(date +%s%3N)-report.md` is a card.

## Install

Two steps on any machine with VS Code and Claude Code: the extension, then the plugin.

**1. The VS Code extension.** Download `claude-canvas-<version>.vsix` from the
[latest release](https://github.com/d-weber/claude-canvas/releases/latest) and install it:

```bash
code --install-extension ~/Downloads/claude-canvas-0.1.0.vsix
```

or build it from a checkout (no npm needed: the libraries are vendored, the extension is plain
JavaScript and the `.vsix` is zipped by a Python script):

```bash
python3 extension/tools/package_vsix.py                 # -> dist/claude-canvas-0.1.0.vsix
code --install-extension dist/claude-canvas-0.1.0.vsix
```

**2. The Claude Code plugin.** At the prompt of a Claude Code terminal session:

```
/plugin install canvas --marketplace d-weber/claude-canvas
```

(`y` to add the marketplace, then the user scope.) From a shell: `claude plugin install canvas
--marketplace d-weber/claude-canvas`. The same marketplace also lists
[`frame`](https://github.com/d-weber/claude-frame), a colored border around prompts and answers in
the transcript: `/plugin install frame --marketplace d-weber/claude-canvas`.

Alternatives to the marketplace: **Claude Canvas: Register the Claude Code plugin** in VS Code adds
the copy bundled in the extension to `env.CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`
(backup kept), and a developer points that variable at this checkout's `plugin/` folder for hot
reload. Use one of the three, not several, or the plugin loads twice.

Open the panel with **Claude Canvas: Open**, the `Canvas` status-bar item, or `/canvas` in Claude
Code. It also opens by itself when a card arrives (`claudeCanvas.autoOpen`).

## Develop

```bash
ELECTRON_RUN_AS_NODE=1 code extension/tests/test_extension.js   # headless extension test (VS Code's node)
claude plugin validate plugin                                   # the plugin's manifest + hooks module
extension/tools/vendor.sh                                       # re-fetch the pinned libraries
```

Vendored: KaTeX 0.16.11, markdown-it 14.1.0, Mermaid 11.4.1, highlight.js 11.10.0 (licenses in
`extension/media/vendor/`).

## Settings

Plugin option (`/config` row "Mirror every answer", or `pluginConfigs.canvas.options` in
`~/.claude/settings.json`): `mirrorAnswers`, default `false`, copies every final answer to the canvas
while the panel is open.

Extension settings:

| Setting | Default | |
|---|---|---|
| `claudeCanvas.directory` | `~/.claude/canvas` | the drop folder (the plugin follows `CLAUDE_CANVAS_DIR`) |
| `claudeCanvas.autoOpen` | `true` | open the panel when a card arrives while it is closed |
| `claudeCanvas.maxCards` | `200` | older cards move to `history/` |
| `claudeCanvas.defaultFrameHeight` | `480` | HTML card frame height when the push gives none |

## Roadmap

- Return channel: buttons and inputs in a card write to `inbox/`; a `canvas_read` tool reads them.
- The VS Code extension's own chat panel attaches no mod surface today; when it does, the plugin
  can draw there as well.
