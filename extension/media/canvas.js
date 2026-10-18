// The canvas page: receives cards from the extension and renders them.
// Markdown via markdown-it, math via KaTeX auto-render (+ ```math fences),
// diagrams via Mermaid (```mermaid fences), code via highlight.js, HTML pages
// in a sandboxed iframe, images as <img>. No network is needed for any of it.

(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const feed = document.getElementById('feed');
  const pill = document.getElementById('pill');
  const count = document.getElementById('bar-count');
  const isDark = !document.body.classList.contains('vscode-light');

  const md = window.markdownit({ html: true, linkify: true, typographer: false, breaks: false });
  // Keep `$...$` safe from markdown-it's emphasis/escape handling: math is
  // rendered after the HTML is built, by KaTeX's auto-render, on the text nodes.

  let mermaidReady = false;
  function ensureMermaid() {
    if (mermaidReady) return true;
    const m = window.mermaid || (window.__esbuild_esm_mermaid && window.__esbuild_esm_mermaid.default);
    if (!m) return false;
    window.mermaid = m;
    m.initialize({ startOnLoad: false, theme: isDark ? 'dark' : 'default', securityLevel: 'strict', fontFamily: 'inherit' });
    mermaidReady = true;
    return true;
  }

  const KATEX_OPTS = {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '\\(', right: '\\)', display: false },
      { left: '$', right: '$', display: false },
    ],
    throwOnError: false,
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'svg'],
    ignoredClasses: ['mermaid', 'katex-display'],
  };

  // ------------------------------------------------------------ rendering

  function renderMarkdown(el, source) {
    el.className = 'card-body md';
    let html;
    try {
      html = md.render(source);
    } catch (err) {
      el.innerHTML = `<div class="md-error">markdown-it: ${escapeHtml(String(err))}</div>`;
      return;
    }
    el.innerHTML = html;

    // ```math fences -> display math; ```mermaid fences -> diagrams; others -> hljs
    const mermaidNodes = [];
    for (const code of Array.from(el.querySelectorAll('pre > code'))) {
      const lang = (Array.from(code.classList).find(c => c.startsWith('language-')) || '').slice('language-'.length).toLowerCase();
      const pre = code.parentElement;
      if (lang === 'math' || lang === 'latex' || lang === 'tex') {
        const box = document.createElement('div');
        box.className = 'katex-display-block';
        try {
          window.katex.render(code.textContent, box, { displayMode: true, throwOnError: false });
        } catch (err) {
          box.innerHTML = `<div class="md-error">${escapeHtml(String(err))}</div>`;
        }
        pre.replaceWith(box);
      } else if (lang === 'mermaid') {
        const box = document.createElement('div');
        box.className = 'mermaid';
        box.textContent = code.textContent;
        pre.replaceWith(box);
        mermaidNodes.push(box);
      } else if (window.hljs) {
        try {
          if (lang && window.hljs.getLanguage(lang)) window.hljs.highlightElement(code);
          else if (!lang) window.hljs.highlightElement(code);
        } catch { /* leave plain */ }
      }
    }

    if (window.renderMathInElement) {
      try { window.renderMathInElement(el, KATEX_OPTS); } catch (err) { log(`katex: ${err}`); }
    }

    if (mermaidNodes.length && ensureMermaid()) {
      window.mermaid.run({ nodes: mermaidNodes }).catch(err => {
        for (const n of mermaidNodes) {
          if (!n.querySelector('svg')) n.innerHTML = `<div class="md-error">mermaid: ${escapeHtml(String(err && err.message || err))}</div>`;
        }
      });
    }
  }

  function renderHtml(el, card) {
    el.className = 'card-body';
    const wrap = document.createElement('div');
    wrap.className = 'frame-wrap';
    wrap.style.height = `${card.height || 480}px`;
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads');
    frame.setAttribute('loading', 'lazy');
    frame.src = card.frameUri;
    frame.title = card.title;
    wrap.appendChild(frame);
    el.appendChild(wrap);
  }

  function renderImage(el, card) {
    el.className = 'card-body';
    const img = document.createElement('img');
    img.className = 'single';
    img.src = card.srcUri;
    img.alt = card.title;
    img.addEventListener('click', () => img.classList.toggle('wide'));
    el.appendChild(img);
  }

  function buildCard(card, fresh) {
    const art = document.createElement('article');
    art.className = 'card' + (fresh ? ' fresh' : '');
    art.dataset.id = card.id;
    if (card.slot) art.dataset.slot = card.slot;

    const head = document.createElement('div');
    head.className = 'card-head';
    head.innerHTML = `
      <span class="card-title" title="${escapeAttr(card.id)}">${escapeHtml(card.title)}</span>
      ${card.slot ? `<span class="card-badge slot" title="replaced in place on the next push to this slot">${escapeHtml(card.slot)}</span>` : ''}
      <span class="card-badge ${escapeAttr(card.source || '')}" title="source">${escapeHtml(badge(card))}</span>
      <span class="card-time">${timeOf(card.ts)}</span>
      <button data-act="source" title="Open the card's source file">src</button>
      <button data-act="fold" title="Collapse / expand">–</button>
      <button data-act="remove" title="Move this card to history/">×</button>`;
    art.appendChild(head);

    const body = document.createElement('div');
    if (card.kind === 'markdown') renderMarkdown(body, card.body || '');
    else if (card.kind === 'html') renderHtml(body, card);
    else if (card.kind === 'image') renderImage(body, card);
    else { body.className = 'card-body'; body.textContent = `unknown card kind ${card.kind}`; }
    art.appendChild(body);

    head.addEventListener('click', ev => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'fold') { art.classList.toggle('collapsed'); btn.textContent = art.classList.contains('collapsed') ? '+' : '–'; }
      else if (act === 'remove') vscode.postMessage({ type: 'remove', id: card.id });
      else if (act === 'source') vscode.postMessage({ type: 'openSource', id: card.id });
    });
    head.addEventListener('dblclick', () => art.classList.toggle('collapsed'));
    if (fresh) setTimeout(() => art.classList.remove('fresh'), 2500);
    return art;
  }

  function badge(card) {
    if (card.source === 'turn') return 'answer';
    if (card.source === 'tool') return card.kind;
    if (card.source === 'file') return 'file';
    return card.kind;
  }

  function timeOf(ts) {
    const d = new Date(ts || Date.now());
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function escapeAttr(s) { return escapeHtml(s); }
  function log(text) { vscode.postMessage({ type: 'log', text }); }

  // ------------------------------------------------------------- the feed

  function nearBottom() {
    return window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
  }

  function scrollToBottom() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    pill.hidden = true;
  }

  function insertCard(card, fresh) {
    const existing = feed.querySelector(`[data-id="${cssEscape(card.id)}"]`);
    const node = buildCard(card, fresh);
    if (existing) {
      existing.replaceWith(node);
    } else {
      // keep the feed ordered by id (push time)
      const after = Array.from(feed.children).find(ch => ch.dataset.id > card.id);
      if (after) feed.insertBefore(node, after); else feed.appendChild(node);
    }
    refreshCount();
    return node;
  }

  function removeCard(id) {
    const node = feed.querySelector(`[data-id="${cssEscape(id)}"]`);
    if (node) node.remove();
    refreshCount();
  }

  function refreshCount() {
    const n = feed.children.length;
    count.textContent = n ? `${n} card${n === 1 ? '' : 's'}` : '';
    document.body.classList.toggle('has-cards', n > 0);
  }

  function cssEscape(s) {
    return window.CSS && window.CSS.escape ? window.CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
  }

  window.addEventListener('message', ev => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'reset': {
        feed.innerHTML = '';
        for (const card of msg.cards || []) insertCard(card, false);
        requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
        break;
      }
      case 'card': {
        const stick = nearBottom();
        insertCard(msg.card, !!msg.fresh);
        if (stick) requestAnimationFrame(scrollToBottom);
        else if (msg.fresh) pill.hidden = false;
        break;
      }
      case 'remove':
        removeCard(msg.id);
        break;
      default:
        break;
    }
  });

  window.addEventListener('scroll', () => { if (nearBottom()) pill.hidden = true; }, { passive: true });
  pill.addEventListener('click', scrollToBottom);
  document.getElementById('btn-bottom').addEventListener('click', scrollToBottom);
  document.getElementById('btn-folder').addEventListener('click', () => vscode.postMessage({ type: 'openFolder' }));
  document.getElementById('btn-clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));

  // Links inside markdown open in the browser (the webview host handles http(s)).
  feed.addEventListener('click', ev => {
    const a = ev.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) ev.preventDefault();
  });

  refreshCount();
  ensureMermaid();
  vscode.postMessage({ type: 'log', text: 'canvas page ready' });
})();
