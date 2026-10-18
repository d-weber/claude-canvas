#!/usr/bin/env node
// Headless test of extension.js over a temporary canvas folder.
//
//   ELECTRON_RUN_AS_NODE=1 code extension/tests/test_extension.js      (VS Code's node)
//   node extension/tests/test_extension.js                              (any node >= 18)
//
// It loads extension.js with the vscode stub, writes envelopes and bare files
// into feed/, and checks the cards the webview would receive, slots, clear,
// the heartbeat and the plugin registration into a fake settings.json.
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const Module = require('module');

const stub = require('./vscode-stub.js');
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return path.join(__dirname, 'vscode-stub.js');
  return realResolve.call(this, request, ...rest);
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

let tmp, canvas, ext, home;

async function setup() {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-canvas-test-'));
  home = path.join(tmp, 'home');
  await fsp.mkdir(path.join(home, '.claude'), { recursive: true });
  canvas = path.join(tmp, 'canvas');
  stub._config.set('directory', canvas);
  stub._config.set('autoOpen', true);
  stub._config.set('maxCards', 5);
  process.env.HOME = home;
  ext = require('../extension.js');
  ext.activate({ subscriptions: [], extensionPath: path.resolve(__dirname, '..') });
  await sleep(300);
}

async function waitFor(pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await sleep(50);
  }
  return false;
}

function cardsPosted() {
  return stub._posted.filter(m => m.type === 'card').map(m => m.card);
}

test('folders are created and no panel opens on an empty feed', async () => {
  for (const d of ['feed', 'assets', 'history', 'inbox']) assert.ok(fs.existsSync(path.join(canvas, d)), d);
  assert.strictEqual(stub._panelCount(), 0);
});

test('a markdown envelope opens the panel and arrives as a card with math intact', async () => {
  const body = 'The energy is $$E = mc^2$$ and inline $x_i$.';
  await fsp.writeFile(path.join(canvas, 'feed', `${Date.now()}-energy.json`), JSON.stringify({ v: 1, kind: 'markdown', title: 'Energy', body, source: 'tool' }));
  assert.ok(await waitFor(() => stub._panelCount() === 1), 'panel opened');
  assert.ok(await waitFor(() => stub._posted.some(m => m.type === 'reset' && m.cards.length === 1)), 'reset carried the card');
  const card = stub._posted.find(m => m.type === 'reset' && m.cards.length === 1).cards[0];
  assert.strictEqual(card.kind, 'markdown');
  assert.strictEqual(card.title, 'Energy');
  assert.strictEqual(card.body, body);
  assert.ok(stub._panel.webview.html.includes('katex.min.js'), 'shell loads KaTeX');
  assert.ok(stub._panel.webview.html.includes("default-src 'none'"), 'shell has a CSP');
});

test('a bare .md file with a local image is localized into assets/', async () => {
  const img = path.join(tmp, 'plot.svg');
  await fsp.writeFile(img, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const name = `${Date.now()}-report.md`;
  await fsp.writeFile(path.join(canvas, 'feed', name), `# Report\n\n![plot](${img})\n`);
  assert.ok(await waitFor(() => cardsPosted().some(c => c.id === name)), 'card posted');
  const card = cardsPosted().find(c => c.id === name);
  assert.ok(card.body.includes('vscode-webview://canvas/'), 'image rewritten to a webview URI');
  assert.ok(!card.body.includes(img), 'original path gone');
  const assets = await fsp.readdir(path.join(canvas, 'assets'));
  assert.ok(assets.some(a => a.endsWith('-plot.svg')), `asset copied: ${assets}`);
});

test('an html envelope is written to assets/ and framed with the given height', async () => {
  const name = `${Date.now()}-chart.json`;
  await fsp.writeFile(path.join(canvas, 'feed', name), JSON.stringify({ v: 1, kind: 'html', title: 'Chart', body: '<!doctype html><p>hi</p>', height: 300 }));
  assert.ok(await waitFor(() => cardsPosted().some(c => c.id === name)), 'card posted');
  const card = cardsPosted().find(c => c.id === name);
  assert.strictEqual(card.kind, 'html');
  assert.strictEqual(card.height, 300);
  assert.ok(card.frameUri.endsWith('.html'), card.frameUri);
  const assetFile = path.join(canvas, 'assets', card.frame);
  assert.strictEqual(await fsp.readFile(assetFile, 'utf8'), '<!doctype html><p>hi</p>');
});

test('an image envelope by path copies the file; a .png dropped bare is a card too', async () => {
  const png = path.join(tmp, 'pic.png');
  await fsp.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const name = `${Date.now()}-pic.json`;
  await fsp.writeFile(path.join(canvas, 'feed', name), JSON.stringify({ v: 1, kind: 'image', path: png }));
  assert.ok(await waitFor(() => cardsPosted().some(c => c.id === name)), 'card posted');
  const card = cardsPosted().find(c => c.id === name);
  assert.strictEqual(card.kind, 'image');
  assert.strictEqual(card.title, 'pic.png');
  assert.ok(card.srcUri.includes('-pic.png'), card.srcUri);

  const bare = `${Date.now()}-bare.png`;
  await fsp.copyFile(png, path.join(canvas, 'feed', bare));
  assert.ok(await waitFor(() => cardsPosted().some(c => c.id === bare)), 'bare png posted');
});

test('a slot replaces the previous card in place and retires its file', async () => {
  const first = `${Date.now()}-progress.json`;
  await fsp.writeFile(path.join(canvas, 'feed', first), JSON.stringify({ v: 1, kind: 'markdown', slot: 'progress', body: '10 %' }));
  assert.ok(await waitFor(() => cardsPosted().some(c => c.id === first)));
  await sleep(5);
  const second = `${Date.now()}-progress.json`;
  await fsp.writeFile(path.join(canvas, 'feed', second), JSON.stringify({ v: 1, kind: 'markdown', slot: 'progress', body: '20 %' }));
  assert.ok(await waitFor(() => cardsPosted().some(c => c.id === second)));
  assert.ok(stub._posted.some(m => m.type === 'remove' && m.id === first), 'old card removed');
  assert.ok(!fs.existsSync(path.join(canvas, 'feed', first)), 'old feed file moved out');
  const hist = await fsp.readdir(path.join(canvas, 'history'));
  assert.ok(hist.length >= 1, 'history has an entry');
});

test('maxCards trims the oldest cards to history', async () => {
  const names = await fsp.readdir(path.join(canvas, 'feed'));
  assert.ok(names.length <= 5, `feed holds ${names.length} files`);
});

test('an "open" control file reveals the panel and is deleted', async () => {
  const name = `${Date.now()}-open.json`;
  await fsp.writeFile(path.join(canvas, 'feed', name), JSON.stringify({ v: 1, kind: 'open' }));
  assert.ok(await waitFor(() => !fs.existsSync(path.join(canvas, 'feed', name))), 'control file removed');
  assert.ok((stub._panel.revealed || 0) >= 1, 'panel revealed');
});

test('a broken envelope is reported as an error card, not dropped silently', async () => {
  const name = `${Date.now()}-broken.json`;
  await fsp.writeFile(path.join(canvas, 'feed', name), JSON.stringify({ v: 1, kind: 'html' }));
  assert.ok(await waitFor(() => cardsPosted().some(c => c.id === name)));
  const card = cardsPosted().find(c => c.id === name);
  assert.ok(card.body.includes('could not render'), card.body);
});

test('the heartbeat file is fresh while the panel lives and gone after dispose', async () => {
  const alive = path.join(canvas, 'alive');
  assert.ok(await waitFor(() => fs.existsSync(alive)), 'alive written');
  const body = JSON.parse(await fsp.readFile(alive, 'utf8'));
  assert.ok(Date.now() - body.ts < 10000);
  assert.strictEqual(body.visible, true);
  stub._panel.dispose();
  assert.ok(await waitFor(() => !fs.existsSync(alive)), 'alive removed on dispose');
});

test('clear moves feed and assets to history and resets the view', async () => {
  stub._posted.length = 0;
  await stub.commands.execute('claudeCanvas.open');
  await stub.commands.execute('claudeCanvas.clear');
  assert.strictEqual((await fsp.readdir(path.join(canvas, 'feed'))).length, 0);
  assert.strictEqual((await fsp.readdir(path.join(canvas, 'assets'))).length, 0);
  assert.ok(stub._posted.some(m => m.type === 'reset' && m.cards.length === 0), 'empty reset posted');
});

test('setupClaudePlugin appends the plugin folder to env.CLAUDE_CODE_PLUGIN_DIRS with a backup', async () => {
  const settings = path.join(home, '.claude', 'settings.json');
  await fsp.writeFile(settings, JSON.stringify({ model: 'x', env: { CLAUDE_CODE_PLUGIN_DIRS: '/elsewhere' } }, null, 2));
  await stub.commands.execute('claudeCanvas.setupClaudePlugin');
  const after = JSON.parse(await fsp.readFile(settings, 'utf8'));
  const dirs = after.env.CLAUDE_CODE_PLUGIN_DIRS.split(path.delimiter);
  assert.strictEqual(dirs[0], '/elsewhere');
  assert.ok(dirs[1].endsWith('/plugin'), dirs[1]);
  assert.ok(fs.existsSync(path.join(dirs[1], '.claude-plugin', 'plugin.json')), 'points at a real plugin');
  assert.strictEqual(after.model, 'x', 'other settings kept');
  const backups = (await fsp.readdir(path.join(home, '.claude'))).filter(n => n.startsWith('settings.json.bak-'));
  assert.strictEqual(backups.length, 1);
  await stub.commands.execute('claudeCanvas.setupClaudePlugin');
  assert.ok(stub._info.some(m => m.includes('already')), 'second run is a no-op');
});

(async () => {
  let failed = 0;
  await setup();
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL ${t.name}\n     ${err && err.stack || err}`);
    }
  }
  ext.deactivate();
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
