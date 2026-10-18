# Claude Canvas

A rendered canvas beside your terminal, fed by Claude Code.

Keep the Claude Code CLI in the integrated terminal; this panel renders what the terminal cannot:
Markdown with KaTeX math, Mermaid diagrams, highlighted code, tables, images, SVG charts and whole
HTML pages. With the bundled Claude Code plugin registered (**Claude Canvas: Register the Claude Code
plugin**), the model gets a `canvas_push` tool and decides, per answer, when a card is worth it:
formulas, charts, figures, diagrams, reports and live views; plus a `/canvas` command.

Commands: **Claude Canvas: Open**, **Clear**, **Reveal the canvas folder**, **Register the Claude Code
plugin**. The drop folder is `~/.claude/canvas/` (setting `claudeCanvas.directory`): any `.md`,
`.html`, `.svg`, `.png` or JSON envelope written into its `feed/` becomes a card.

Source, docs and the Claude Code plugin's marketplace: https://github.com/d-weber/claude-canvas
