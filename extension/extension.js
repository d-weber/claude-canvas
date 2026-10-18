// Claude Canvas: a webview panel fed by a drop folder.
//
// Anything written into <canvas dir>/feed/ becomes a card: a `.json` envelope
// (the Claude Code plugin's `canvas_push` writes these), or a bare `.md`,
// `.html`, `.svg`, `.png`, ... file. The feed folder mirrors the canvas: a
// replaced or cleared card's file moves to history/. Referenced local files
// are copied into assets/ so the webview may serve them. While the panel is
// open the extension touches <canvas dir>/alive every 5 s; the plugin reads
// that heartbeat to know whether anyone is looking.

'use strict';

const vscode = require('vscode');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const HEARTBEAT_MS = 5000;
const POLL_MS = 3000;
const SETTLE_MS = 120;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.avif']);
const MARKDOWN_EXT = new Set(['.md', '.markdown']);
const HTML_EXT = new Set(['.html', '.htm']);
const ASSET_TOKEN = /canvas-asset:([A-Za-z0-9._-]+)/g;

/** @type {vscode.WebviewPanel | undefined} */
let panel;
/** @type {Array<Card>} */
let cards = [];
/** @type {Set<string>} */
let seen = new Set();
/** @type {fs.FSWatcher | undefined} */
let watcher;
let pollTimer;
let heartbeatTimer;
let statusItem;
let output;
let dirs;
let extensionContext;
const pending = new Map();

/**
 * @typedef {Object} Card
 * @property {string} id        the feed file name (unique, sorts by push time)
 * @property {number} ts        epoch ms
 * @property {'markdown'|'html'|'image'} kind
 * @property {string} title
 * @property {string} [slot]
 * @property {string} [source]  'tool' | 'turn' | 'command' | 'file'
 * @property {string} [body]    markdown source, asset tokens for local images
 * @property {string} [frame]   asset name of an HTML page (kind html)
 * @property {string} [src]     asset name or data: URL (kind image)
 * @property {number} [height]
 */

// ---------------------------------------------------------------- lifecycle

function activate(context) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Claude Canvas');
  context.subscriptions.push(output);

  dirs = computeDirs();
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCanvas.open', () => openPanel(true)),
    vscode.commands.registerCommand('claudeCanvas.clear', () => clearAll()),
    vscode.commands.registerCommand('claudeCanvas.openFolder', () =>
      vscode.env.openExternal(vscode.Uri.file(dirs.root))),
    vscode.commands.registerCommand('claudeCanvas.setupClaudePlugin', () => setupClaudePlugin()),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeCanvas.directory')) restartWatch();
    }),
  );

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  statusItem.command = 'claudeCanvas.open';
  statusItem.tooltip = 'Claude Canvas: open the panel';
  context.subscriptions.push(statusItem);
  updateStatus();
  statusItem.show();

  startWatch().catch(err => log(`start failed: ${err && err.stack || err}`));
}

function deactivate() {
  stopWatch();
  stopHeartbeat();
}

function log(line) {
  if (output) output.appendLine(`${new Date().toISOString()} ${line}`);
}

function config() {
  const c = vscode.workspace.getConfiguration('claudeCanvas');
  return {
    directory: c.get('directory', '~/.claude/canvas'),
    autoOpen: c.get('autoOpen', true),
    maxCards: c.get('maxCards', 200),
    frameHeight: c.get('defaultFrameHeight', 480),
  };
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function computeDirs() {
  const root = path.resolve(expandHome(config().directory));
  return {
    root,
    feed: path.join(root, 'feed'),
    assets: path.join(root, 'assets'),
    history: path.join(root, 'history'),
    inbox: path.join(root, 'inbox'),
    alive: path.join(root, 'alive'),
  };
}

async function ensureDirs() {
  for (const d of [dirs.root, dirs.feed, dirs.assets, dirs.history, dirs.inbox]) {
    await fsp.mkdir(d, { recursive: true });
  }
}

// ------------------------------------------------------------------ watching

async function startWatch() {
  await ensureDirs();
  log(`watching ${dirs.feed}`);
  await scanFeed(true);
  try {
    watcher = fs.watch(dirs.feed, (_event, filename) => {
      if (filename) scheduleIngest(path.join(dirs.feed, filename.toString()), false);
      else scanFeed(false).catch(err => log(`scan failed: ${err}`));
    });
    watcher.on('error', err => log(`watch error: ${err}`));
  } catch (err) {
    log(`fs.watch unavailable, polling only: ${err}`);
  }
  pollTimer = setInterval(() => scanFeed(false).catch(err => log(`poll failed: ${err}`)), POLL_MS);
}

function stopWatch() {
  if (watcher) { watcher.close(); watcher = undefined; }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
}

async function restartWatch() {
  stopWatch();
  dirs = computeDirs();
  cards = [];
  seen = new Set();
  await startWatch();
  if (panel) postReset();
}

/** Lists the feed, ingests new files, drops cards whose file is gone. */
async function scanFeed(initial) {
  let names;
  try {
    names = await fsp.readdir(dirs.feed);
  } catch (err) {
    if (err.code === 'ENOENT') { await ensureDirs(); return; }
    throw err;
  }
  const present = new Set(names);
  for (const card of [...cards]) {
    if (!present.has(card.id)) {
      cards = cards.filter(c => c !== card);
      seen.delete(card.id);
      if (panel) panel.webview.postMessage({ type: 'remove', id: card.id });
    }
  }
  names.sort();
  for (const name of names) {
    if (!seen.has(name)) await ingest(path.join(dirs.feed, name), initial);
  }
  updateStatus();
}

function scheduleIngest(file, initial) {
  const name = path.basename(file);
  if (pending.has(name)) clearTimeout(pending.get(name));
  pending.set(name, setTimeout(() => {
    pending.delete(name);
    ingest(file, initial).catch(err => log(`ingest ${name} failed: ${err && err.stack || err}`));
  }, SETTLE_MS));
}

/** Resolves once the file's size has stopped changing (a writer may still be at it). */
async function settle(file) {
  let last = -1;
  for (let i = 0; i < 20; i++) {
    let size;
    try { size = (await fsp.stat(file)).size; } catch { return false; }
    if (size === last) return true;
    last = size;
    await sleep(SETTLE_MS);
  }
  return true;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tsFromName(name) {
  const m = /^(\d{13})/.exec(name);
  return m ? Number(m[1]) : undefined;
}

async function ingest(file, initial) {
  const name = path.basename(file);
  if (seen.has(name) || name.startsWith('.')) return;
  const ext = path.extname(name).toLowerCase();
  const isCard = ext === '.json' || MARKDOWN_EXT.has(ext) || HTML_EXT.has(ext) || IMAGE_EXT.has(ext);
  if (!isCard) return;
  if (!(await settle(file))) return;
  if (seen.has(name)) return;
  seen.add(name);

  let stat;
  try { stat = await fsp.stat(file); } catch { seen.delete(name); return; }
  if (!stat.isFile()) return;

  let env;
  if (ext === '.json') {
    env = await readEnvelope(file);
    if (!env) { log(`${name}: not a readable envelope, ignored`); return; }
  } else if (MARKDOWN_EXT.has(ext)) {
    env = { kind: 'markdown', title: name, path: file, source: 'file' };
  } else if (HTML_EXT.has(ext)) {
    env = { kind: 'html', title: name, path: file, source: 'file' };
  } else {
    env = { kind: 'image', title: name, path: file, source: 'file' };
  }
  env.id = name;
  env.ts = tsFromName(name) || Math.round(stat.mtimeMs);
  await handleEnvelope(env, file, initial);
}

async function readEnvelope(file) {
  for (let i = 0; i < 6; i++) {
    try {
      const text = await fsp.readFile(file, 'utf8');
      const env = JSON.parse(text);
      if (env && typeof env === 'object') return env;
      return undefined;
    } catch (err) {
      if (err.code === 'ENOENT') return undefined;
      await sleep(150);
    }
  }
  return undefined;
}

// ------------------------------------------------------------------ handling

async function handleEnvelope(env, file, initial) {
  const kind = String(env.kind || '').toLowerCase();

  if (kind === 'open') {
    await fsp.unlink(file).catch(() => {});
    seen.delete(env.id);
    if (!initial) openPanel(true);
    return;
  }
  if (kind === 'clear') {
    await clearAll();
    return;
  }

  let card;
  try {
    card = await buildCard(env, kind);
  } catch (err) {
    log(`${env.id}: ${err && err.message || err}`);
    card = {
      id: env.id, ts: env.ts, kind: 'markdown', title: env.title || env.id, source: env.source,
      body: `> **Claude Canvas could not render this card.** ${escapeMd(String(err && err.message || err))}`,
    };
  }

  if (card.slot) {
    const old = cards.find(c => c.slot === card.slot && c.id !== card.id);
    if (old) {
      await retire(old);
      if (panel) panel.webview.postMessage({ type: 'remove', id: old.id });
    }
  }
  cards.push(card);
  cards.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  const { maxCards, autoOpen } = config();
  while (cards.length > maxCards) {
    const oldest = cards.shift();
    await retire(oldest);
    if (panel) panel.webview.postMessage({ type: 'remove', id: oldest.id });
  }

  if (panel) {
    panel.webview.postMessage({ type: 'card', card: serialize(card), fresh: !initial });
  } else if (autoOpen && !initial) {
    openPanel(false);
  }
  updateStatus();
}

function escapeMd(s) { return s.replace(/[<>]/g, ''); }

async function buildCard(env, kind) {
  const { frameHeight } = config();
  const card = {
    id: env.id,
    ts: env.ts,
    kind,
    title: typeof env.title === 'string' && env.title.trim() ? env.title.trim() : defaultTitle(env),
    slot: typeof env.slot === 'string' && env.slot.trim() ? env.slot.trim() : undefined,
    source: typeof env.source === 'string' ? env.source : undefined,
  };
  const base = typeof env.cwd === 'string' ? env.cwd : dirs.root;

  if (kind === 'markdown') {
    let body = typeof env.body === 'string' ? env.body : undefined;
    if (body === undefined && typeof env.path === 'string') {
      body = await fsp.readFile(resolvePath(env.path, base), 'utf8');
    }
    if (body === undefined) throw new Error('a markdown card needs body or path');
    card.body = await localizeImages(body, base, env.id);
    return card;
  }

  if (kind === 'html') {
    card.height = Number.isFinite(env.height) && env.height >= 80 ? Math.round(env.height) : frameHeight;
    if (typeof env.body === 'string') {
      const assetName = `${stem(env.id)}.html`;
      await fsp.writeFile(path.join(dirs.assets, assetName), env.body, 'utf8');
      card.frame = assetName;
    } else if (typeof env.path === 'string') {
      card.frame = await copyAsset(resolvePath(env.path, base), env.id);
    } else {
      throw new Error('an html card needs body or path');
    }
    return card;
  }

  if (kind === 'image' || kind === 'svg') {
    card.kind = 'image';
    if (typeof env.body === 'string' && env.body.startsWith('data:')) {
      card.src = env.body;
    } else if (typeof env.body === 'string' && kind === 'svg') {
      const assetName = `${stem(env.id)}.svg`;
      await fsp.writeFile(path.join(dirs.assets, assetName), env.body, 'utf8');
      card.src = `canvas-asset:${assetName}`;
    } else if (typeof env.path === 'string') {
      card.src = `canvas-asset:${await copyAsset(resolvePath(env.path, base), env.id)}`;
    } else {
      throw new Error('an image card needs path or a data: body');
    }
    return card;
  }

  throw new Error(`unknown kind "${kind}" (markdown, html, image, svg, clear, open)`);
}

function defaultTitle(env) {
  if (typeof env.path === 'string') return path.basename(env.path);
  return env.id.replace(/^\d{13}-/, '').replace(/\.json$/, '');
}

function stem(id) { return id.replace(/\.[^.]+$/, ''); }

function resolvePath(p, base) {
  const expanded = expandHome(p);
  return path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded);
}

/** Copies a referenced file into assets/ (so the webview may serve it) and returns its asset name. */
async function copyAsset(src, cardId) {
  const assetName = `${stem(cardId)}-${path.basename(src)}`.replace(/[^A-Za-z0-9._-]/g, '_');
  const dst = path.join(dirs.assets, assetName);
  if (path.resolve(src) !== path.resolve(dst)) await fsp.copyFile(src, dst);
  return assetName;
}

/** Rewrites local image references in markdown to asset tokens, copying the files in. */
async function localizeImages(markdown, base, cardId) {
  const refs = [];
  const mdImg = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
  const htmlImg = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  for (const re of [mdImg, htmlImg]) {
    let m;
    while ((m = re.exec(markdown)) !== null) refs.push(m[1]);
  }
  let out = markdown;
  for (const ref of new Set(refs)) {
    if (/^(https?:|data:|canvas-asset:|vscode-webview:|#)/i.test(ref)) continue;
    const file = resolvePath(ref, base);
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) continue;
      const assetName = await copyAsset(file, cardId);
      out = out.split(ref).join(`canvas-asset:${assetName}`);
    } catch {
      // not a local file we can read: leave the reference as written
    }
  }
  return out;
}

/** Moves a card's feed file (and its assets) to history/. */
async function retire(card) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(dirs.history, stamp);
  await fsp.mkdir(path.join(dst, 'feed'), { recursive: true });
  await moveFile(path.join(dirs.feed, card.id), path.join(dst, 'feed', card.id));
  for (const asset of cardAssets(card)) {
    await fsp.mkdir(path.join(dst, 'assets'), { recursive: true });
    await moveFile(path.join(dirs.assets, asset), path.join(dst, 'assets', asset));
  }
  cards = cards.filter(c => c !== card);
  seen.delete(card.id);
}

function cardAssets(card) {
  const names = [];
  if (card.frame) names.push(card.frame);
  if (card.src && card.src.startsWith('canvas-asset:')) names.push(card.src.slice('canvas-asset:'.length));
  if (card.body) for (const m of card.body.matchAll(ASSET_TOKEN)) names.push(m[1]);
  return names;
}

async function moveFile(src, dst) {
  try {
    await fsp.rename(src, dst);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    await fsp.copyFile(src, dst);
    await fsp.unlink(src);
  }
}

async function clearAll() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(dirs.history, stamp);
  for (const sub of ['feed', 'assets']) {
    const from = dirs[sub];
    let names = [];
    try { names = await fsp.readdir(from); } catch { continue; }
    if (names.length === 0) continue;
    await fsp.mkdir(path.join(dst, sub), { recursive: true });
    for (const n of names) await moveFile(path.join(from, n), path.join(dst, sub, n));
  }
  cards = [];
  seen = new Set();
  if (panel) postReset();
  updateStatus();
  log(`cleared to ${dst}`);
}

function updateStatus() {
  if (!statusItem) return;
  statusItem.text = `$(layout-panel) Canvas ${cards.length}`;
}

// --------------------------------------------------------------------- panel

function openPanel(reveal) {
  if (panel) {
    if (reveal) panel.reveal(undefined, true);
    return;
  }
  panel = vscode.window.createWebviewPanel(
    'claudeCanvas',
    'Claude Canvas',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: !reveal },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(extensionContext.extensionPath, 'media')),
        vscode.Uri.file(dirs.root),
      ],
    },
  );
  panel.iconPath = {
    light: vscode.Uri.file(path.join(extensionContext.extensionPath, 'media', 'icon.svg')),
    dark: vscode.Uri.file(path.join(extensionContext.extensionPath, 'media', 'icon.svg')),
  };
  panel.webview.html = renderShell(panel.webview);
  panel.webview.onDidReceiveMessage(msg => onWebviewMessage(msg).catch(err => log(`webview message failed: ${err}`)));
  panel.onDidDispose(() => {
    panel = undefined;
    stopHeartbeat();
  });
  panel.onDidChangeViewState(() => writeHeartbeat().catch(() => {}));
  postReset();
  startHeartbeat();
}

function postReset() {
  if (!panel) return;
  panel.webview.postMessage({
    type: 'reset',
    cards: cards.map(serialize),
    folder: dirs.root,
  });
}

function serialize(card) {
  const out = { ...card };
  if (out.body) out.body = out.body.replace(ASSET_TOKEN, (_m, name) => assetUri(name));
  if (out.frame) out.frameUri = assetUri(out.frame);
  if (out.src) out.srcUri = out.src.startsWith('canvas-asset:') ? assetUri(out.src.slice('canvas-asset:'.length)) : out.src;
  return out;
}

function assetUri(name) {
  return panel.webview.asWebviewUri(vscode.Uri.file(path.join(dirs.assets, name))).toString();
}

async function onWebviewMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'clear':
      await clearAll();
      break;
    case 'remove': {
      const card = cards.find(c => c.id === msg.id);
      if (card) {
        await retire(card);
        if (panel) panel.webview.postMessage({ type: 'remove', id: card.id });
        updateStatus();
      }
      break;
    }
    case 'openSource': {
      const card = cards.find(c => c.id === msg.id);
      if (!card) return;
      const file = card.frame ? path.join(dirs.assets, card.frame) : path.join(dirs.feed, card.id);
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Active });
      break;
    }
    case 'openFolder':
      await vscode.env.openExternal(vscode.Uri.file(dirs.root));
      break;
    case 'inbox': {
      // The return channel: anything the page sends lands as a file in inbox/,
      // where the plugin's canvas_read tool (to come) picks it up.
      const name = `${Date.now()}-${String(msg.name || 'event').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)}.json`;
      await fsp.writeFile(path.join(dirs.inbox, name), JSON.stringify({ ts: Date.now(), card: msg.id, data: msg.data }), 'utf8');
      break;
    }
    case 'log':
      log(`webview: ${msg.text}`);
      break;
    default:
      break;
  }
}

function renderShell(webview) {
  const media = p => webview.asWebviewUri(vscode.Uri.file(path.join(extensionContext.extensionPath, 'media', p))).toString();
  const nonce = [...Array(24)].map(() => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('');
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `frame-src ${webview.cspSource} https:`,
    `connect-src ${webview.cspSource} https:`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Canvas</title>
<link rel="stylesheet" href="${media('vendor/katex/katex.min.css')}">
<link rel="stylesheet" href="${media('vendor/hljs-github-dark.min.css')}">
<link rel="stylesheet" href="${media('canvas.css')}">
</head>
<body>
<header id="bar">
  <span id="bar-title">Claude Canvas</span>
  <span id="bar-count"></span>
  <span class="spacer"></span>
  <button id="btn-bottom" title="Scroll to the newest card">Newest</button>
  <button id="btn-folder" title="Reveal the canvas folder">Folder</button>
  <button id="btn-clear" title="Move every card to history/">Clear</button>
</header>
<main id="feed"></main>
<div id="empty">Nothing on the canvas yet.<br><small>Cards appear here when Claude pushes them (canvas_push), and every final answer is mirrored while this panel is open.</small></div>
<button id="pill" hidden>New cards below</button>
<script nonce="${nonce}" src="${media('vendor/markdown-it.min.js')}"></script>
<script nonce="${nonce}" src="${media('vendor/katex/katex.min.js')}"></script>
<script nonce="${nonce}" src="${media('vendor/katex/contrib/auto-render.min.js')}"></script>
<script nonce="${nonce}" src="${media('vendor/highlight.min.js')}"></script>
<script nonce="${nonce}" src="${media('vendor/mermaid.min.js')}"></script>
<script nonce="${nonce}" src="${media('canvas.js')}"></script>
</body>
</html>`;
}

// ----------------------------------------------------------------- heartbeat

function startHeartbeat() {
  stopHeartbeat();
  writeHeartbeat().catch(() => {});
  heartbeatTimer = setInterval(() => writeHeartbeat().catch(err => log(`heartbeat failed: ${err}`)), HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = undefined; }
  fsp.unlink(dirs.alive).catch(() => {});
}

async function writeHeartbeat() {
  if (!panel) return;
  const body = JSON.stringify({ ts: Date.now(), pid: process.pid, visible: panel.visible, cards: cards.length });
  await fsp.writeFile(dirs.alive, body, 'utf8');
}

// -------------------------------------------------------- Claude Code plugin

/** Adds the bundled plugin folder to CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json. */
async function setupClaudePlugin() {
  const candidates = [
    path.join(extensionContext.extensionPath, 'plugin'),
    path.join(extensionContext.extensionPath, '..', 'plugin'),
  ].map(p => path.resolve(p)).filter(p => fs.existsSync(path.join(p, '.claude-plugin', 'plugin.json')));
  const items = candidates.map(p => ({ label: 'Use this copy of the plugin', description: p, dir: p }));
  items.push({ label: 'Choose a plugin folder…', description: 'a checkout of claude-canvas/plugin', dir: undefined });
  const pick = await vscode.window.showQuickPick(items, { title: 'Claude Canvas: which plugin folder should Claude Code load?' });
  if (!pick) return;
  let dir = pick.dir;
  if (!dir) {
    const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: 'Plugin folder' });
    if (!chosen || chosen.length === 0) return;
    dir = chosen[0].fsPath;
  }

  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  let settings = {};
  let raw = '';
  try {
    raw = await fsp.readFile(settingsPath, 'utf8');
    settings = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      vscode.window.showErrorMessage(`Claude Canvas: cannot parse ${settingsPath} (${err.message}). Add ${dir} to env.CLAUDE_CODE_PLUGIN_DIRS by hand.`);
      return;
    }
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) settings = {};
  settings.env = settings.env && typeof settings.env === 'object' ? settings.env : {};
  const current = typeof settings.env.CLAUDE_CODE_PLUGIN_DIRS === 'string' ? settings.env.CLAUDE_CODE_PLUGIN_DIRS : '';
  const list = current.split(path.delimiter).filter(Boolean);
  if (list.includes(dir)) {
    vscode.window.showInformationMessage(`Claude Canvas: ${dir} is already in CLAUDE_CODE_PLUGIN_DIRS.`);
    return;
  }
  list.push(dir);
  settings.env.CLAUDE_CODE_PLUGIN_DIRS = list.join(path.delimiter);

  if (raw) {
    const backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fsp.writeFile(backup, raw, 'utf8');
  }
  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  vscode.window.showInformationMessage(`Claude Canvas: plugin registered in ${settingsPath}. New Claude Code sessions get the canvas_push tool and the /canvas command.`);
}

module.exports = { activate, deactivate };
