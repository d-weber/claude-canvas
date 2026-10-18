// `claude plugin test plugin` runs this against the engine with the plugin loaded.
// The test environment has no file system, so the canvas counts as closed here:
// these tests cover the model-facing contract (tool validation, the command,
// the prompt section staying out while nobody is looking).

import { expect, mock, test } from 'claude-code/testing'

test('canvas_push refuses a kind it does not know', async ($, on) => {
  mock.env(on, { HOME: '/nowhere' })
  const res = await $.tool.call({ tool: 'mcp__canvas__canvas_push', kind: 'pdf', body: 'x' })
  const refused = res.deny !== undefined || res.isError === true
  expect(refused).toBe(true)
  expect(String(res.deny ?? res.text)).toContain('kind must be one of')
})

test('canvas_push refuses a card with neither body nor path', async ($, on) => {
  mock.env(on, { HOME: '/nowhere' })
  const res = await $.tool.call({ tool: 'mcp__canvas__canvas_push', kind: 'markdown' })
  const refused = res.deny !== undefined || res.isError === true
  expect(refused).toBe(true)
  expect(String(res.deny ?? res.text)).toContain('body or path')
})

test('/canvas status says the canvas is not open and names the folder', async ($, on) => {
  mock.env(on, { HOME: '/nowhere' })
  const res = await $.command.run({ command: 'canvas', args: 'status' })
  expect(res.text).toContain('not open')
  expect(res.text).toContain('/nowhere/.claude/canvas')
})

test('CLAUDE_CANVAS_DIR overrides the folder', async ($, on) => {
  mock.env(on, { HOME: '/nowhere', CLAUDE_CANVAS_DIR: '/srv/canvas/' })
  const res = await $.command.run({ command: 'canvas', args: 'status' })
  expect(res.text).toContain('/srv/canvas')
  expect(res.text).not.toContain('/nowhere')
})

test('the system prompt carries no canvas section while the panel is closed', async ($, on) => {
  mock.env(on, { HOME: '/nowhere' })
  // The kit has no composer of its own: this hook stands for the engine's.
  on('prompt.compose', () => ({ sections: [{ id: 'system', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  const res = await $.prompt.compose({
    model: 'claude-haiku-5-5', promptModel: 'claude-haiku-5-5', surfaces: [], tools: [], outputStyle: null, traits: [],
  })
  expect(res.sections.some(s => s.id === 'canvas:policy')).toBe(false)
})
