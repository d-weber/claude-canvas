// A minimal stand-in for the `vscode` module, enough to drive extension.js
// headlessly: commands, configuration, a fake webview panel that records
// posted messages, and Uri.file / asWebviewUri.
'use strict';

const path = require('path');

const commands = new Map();
const config = new Map();
const posted = [];
let panelCount = 0;

class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.scheme = 'file'; }
  static file(p) { return new Uri(p); }
  toString() { return `vscode-webview://canvas/${this.fsPath.replace(/^\//, '')}`; }
}

class Panel {
  constructor() {
    this.visible = true;
    this.disposed = false;
    this.webview = {
      html: '',
      cspSource: 'vscode-webview://csp',
      postMessage: msg => { posted.push(JSON.parse(JSON.stringify(msg))); return Promise.resolve(true); },
      asWebviewUri: uri => uri,
      onDidReceiveMessage: fn => { this._onMessage = fn; return { dispose() {} }; },
    };
  }
  reveal() { this.revealed = (this.revealed || 0) + 1; }
  onDidDispose(fn) { this._onDispose = fn; return { dispose() {} }; }
  onDidChangeViewState() { return { dispose() {} }; }
  dispose() { this.disposed = true; if (this._onDispose) this._onDispose(); }
}

const stub = {
  Uri,
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
    execute: (id, ...args) => commands.get(id)(...args),
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (config.has(k) ? config.get(k) : d) }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: async uri => ({ uri }),
  },
  window: {
    createOutputChannel: () => ({ appendLine: line => stub._log.push(line), dispose() {} }),
    createStatusBarItem: () => ({ show() {}, dispose() {}, text: '', tooltip: '', command: '' }),
    createWebviewPanel: () => { panelCount++; stub._panel = new Panel(); return stub._panel; },
    showTextDocument: async () => {},
    showInformationMessage: async m => { stub._info.push(m); },
    showErrorMessage: async m => { stub._errors.push(m); },
    showQuickPick: async items => items[0],
    showOpenDialog: async () => undefined,
  },
  env: { openExternal: async () => true },
  _log: [],
  _info: [],
  _errors: [],
  _posted: posted,
  _config: config,
  _panel: undefined,
  _panelCount: () => panelCount,
  _commands: commands,
};

module.exports = stub;
