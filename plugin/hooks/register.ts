// Claude Canvas: the Claude Code half.
//
// Registers the `canvas_push` / `canvas_clear` tools and the `/canvas` command,
// and tells the model about the canvas in the system prompt, only while the
// VS Code panel is open. The model decides what deserves a card: an answer that
// is better rendered (math, a figure, a diagram, an image, a long table). With
// the `mirrorAnswers` option on, every final answer is copied there as well.
//
// Transport: files in <canvas dir>/feed/ (one JSON envelope per card). The
// VS Code extension watches that folder and writes <canvas dir>/alive every
// 5 s while its panel exists; a fresh `alive` is how this module knows anyone
// is looking.

import type { Register } from 'claude-code'

const PLUGIN = 'canvas'
const ALIVE_MS = 20_000
const MAX_BODY = 4_000_000
const KINDS = ['markdown', 'html', 'image', 'svg'] as const

type Kind = (typeof KINDS)[number]
type Envelope = {
  v: 1
  kind: Kind | 'clear' | 'open'
  title?: string
  slot?: string
  body?: string
  path?: string
  height?: number
  source: 'tool' | 'turn' | 'command'
  cwd?: string
  session?: string
}

const PUSH_DESCRIPTION = [
  'Push a card to the Claude Canvas panel in VS Code, a rendered surface beside the terminal.',
  'Use it for anything the terminal cannot show: a chart or figure (inline SVG in markdown, or a',
  'self-contained HTML page for Plotly/D3), a diagram (```mermaid), a formula-heavy explanation',
  '(KaTeX: $$ … $$ display, $ … $ inline, ```math fences), an image file, a long table or report.',
  'Decide per answer: push when rendering adds something (typeset math, a plot, a diagram, an image,',
  'a wide table); do not push plain prose, short answers, code review remarks or status updates.',
  'kind=markdown: body is markdown (local images by absolute path are copied in). kind=html: body',
  'is a full HTML document shown in an iframe (or path to an .html file). kind=image: path to a',
  '.png/.jpg/.svg/... (or body a data: URL). kind=svg: body is SVG source. Give the same `slot` to',
  'successive pushes of one view to replace it in place instead of appending. The result says whether',
  'the panel is open; a card pushed while it is closed waits in the feed and shows when it opens.',
].join(' ')

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: [...KINDS], description: 'markdown | html | image | svg' },
    title: { type: 'string', description: 'Card title (short).' },
    body: {
      type: 'string',
      description: 'Markdown source (kind markdown), a full HTML document (kind html), SVG source (kind svg), or a data: URL (kind image). Give body or path.',
    },
    path: {
      type: 'string',
      description: 'Absolute path of a file to show instead of body: .md, .html, .svg, .png, .jpg, .gif, .webp. The file is copied into the canvas folder.',
    },
    slot: { type: 'string', description: 'A name; a later push with the same slot replaces this card in place (live views, iterations).' },
    height: { type: 'number', description: 'Frame height in px for kind html (default 480).' },
  },
  required: ['kind'],
} as const

const POLICY = `# Claude Canvas (open)
A rendered canvas panel is open beside the terminal in VS Code. It renders Markdown with KaTeX math ($$…$$ display, $…$ inline, \`\`\`math fences), Mermaid diagrams (\`\`\`mermaid), highlighted code, tables, images and standalone HTML pages. Nothing goes there by itself: you decide, per answer, whether it deserves a card.
- Push with canvas_push when rendering adds something the terminal cannot show: a formula-heavy explanation (write it as markdown with LaTeX), a chart (inline SVG in markdown, or a self-contained HTML page for Plotly/D3), a figure or image file (absolute path), a diagram (mermaid), a wide table or a report, or a view you update over time (same \`slot\` each push replaces it in place).
- Do not push plain prose, short answers, status updates, code-review remarks or anything that reads fine in the terminal.
- When you push the explanation itself, the card is the full version: keep the terminal answer to the conclusion plus the card's name ("the derivation is on the canvas as *Derivation*").
- Local images in markdown: reference them by absolute path, they are copied in.`

async function canvasRoot($: { env: { get: (name: string) => Promise<string | undefined> } }): Promise<string> {
  const override = await $.env.get('CLAUDE_CANVAS_DIR')
  if (override) return override.replace(/\/+$/, '')
  const home = (await $.env.get('HOME')) ?? '/tmp'
  return `${home}/.claude/canvas`
}

async function isAlive($: any): Promise<boolean> {
  try {
    const file = `${await canvasRoot($)}/alive`
    if (!(await $.fs.exists(file))) return false
    const st = await $.fs.stat(file)
    return Date.now() - st.mtimeMs < ALIVE_MS
  } catch {
    return false
  }
}

function slug(text: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return s || 'card'
}

async function push($: any, env: Envelope): Promise<string> {
  const name = `${Date.now()}-${slug(env.title ?? env.kind)}.json`
  await $.fs.write(`${await canvasRoot($)}/feed/${name}`, JSON.stringify(env))
  return name
}

/** A plugin tool's result is a string (or an array of content blocks); an object is refused. */
function toolText(text: string) {
  return { result: text }
}

function titleFrom(answer: string): string {
  const firstLine = answer.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? 'Answer'
  const plain = firstLine.replace(/^#+\s*/, '').replace(/[*_`>]/g, '').trim()
  return plain.length > 72 ? `${plain.slice(0, 69)}…` : plain || 'Answer'
}

export const register: Register = (on, options) => {
  const mirrorAnswers = options.mirrorAnswers === true

  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'canvas_push', description: PUSH_DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    await $.tool.register({
      name: 'canvas_clear',
      description: 'Clear the Claude Canvas panel: every card moves to the canvas history folder.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.command.register({
      name: 'canvas',
      description: 'Claude Canvas: open the VS Code panel, clear it, or show its status',
      argumentHint: 'open|clear|status',
    })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__canvas__canvas_push' }, async ($, e) => {
    const a = e as unknown as Record<string, unknown>
    const kind = typeof a.kind === 'string' ? (a.kind.toLowerCase() as Kind) : undefined
    if (!kind || !KINDS.includes(kind)) return { deny: `canvas_push: kind must be one of ${KINDS.join(', ')}` }
    const body = typeof a.body === 'string' ? a.body : undefined
    const path = typeof a.path === 'string' && a.path.trim() ? a.path.trim() : undefined
    if (body === undefined && path === undefined) return { deny: 'canvas_push: give body or path' }
    if (body !== undefined && body.length > MAX_BODY) return { deny: `canvas_push: body over ${MAX_BODY} characters; write it to a file and pass path` }
    if (kind === 'image' && body !== undefined && !body.startsWith('data:')) {
      return { deny: 'canvas_push: kind image takes path, or body as a data: URL; for SVG source use kind svg' }
    }
    const env: Envelope = {
      v: 1,
      kind,
      title: typeof a.title === 'string' && a.title.trim() ? a.title.trim() : undefined,
      slot: typeof a.slot === 'string' && a.slot.trim() ? a.slot.trim() : undefined,
      body,
      path,
      height: typeof a.height === 'number' && Number.isFinite(a.height) ? a.height : undefined,
      source: 'tool',
      cwd: await $.session.cwd(),
    }
    const card = await push($, env)
    const open = await isAlive($)
    return toolText(
      open
        ? `Pushed card ${card} (${kind}${env.slot ? `, slot ${env.slot}` : ''}); the canvas panel is open and shows it.`
        : `Pushed card ${card} (${kind}) to the feed. The canvas panel is NOT open in VS Code right now; the card shows when it opens ("Claude Canvas: Open" or /canvas open). Tell the user in one line rather than pushing more.`,
    )
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: writing the card failed` }))

  on('tool.call', { tool: 'mcp__canvas__canvas_clear' }, async $ => {
    await push($, { v: 1, kind: 'clear', source: 'tool' })
    return toolText('Canvas cleared: every card moved to the canvas history folder.')
  }).catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: writing the clear request failed` }))

  // With the option on, copy the main loop's final answers while someone is looking.
  on('turn.complete', async ($, e, next) => {
    if (mirrorAnswers && e.agentId === undefined && e.reason === 'answer' && e.answer.trim().length > 0 && (await isAlive($))) {
      await push($, { v: 1, kind: 'markdown', title: titleFrom(e.answer), body: e.answer, source: 'turn' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Tell the model about the canvas, only while it is open.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!(await isAlive($))) return composed
    return { sections: [...composed.sections, { id: `${PLUGIN}:policy`, text: POLICY, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'canvas' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const root = await canvasRoot($)
    if (arg === 'clear') {
      await push($, { v: 1, kind: 'clear', source: 'command' })
      return { text: 'Canvas cleared (cards moved to history/).' }
    }
    if (arg === 'status') {
      const open = await isAlive($)
      return { text: `Canvas ${open ? 'is open' : 'is not open'} in VS Code. Folder: ${root}` }
    }
    const open = await isAlive($)
    await push($, { v: 1, kind: 'open', source: 'command' })
    return {
      text: open
        ? 'Canvas panel revealed.'
        : 'Open request queued: VS Code with the Claude Canvas extension picks it up within a few seconds (Command Palette: "Claude Canvas: Open" works too).',
    }
  }).catch(($, e, next) => (next.called ? next(e) : { text: `${PLUGIN}: the command failed` }))
}
