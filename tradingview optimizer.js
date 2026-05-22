// ==UserScript==
// @name         TradingView Optimizer
// @namespace    https://github.com/rainocean
// @author       rainocean
// @version      1.2.2
// @description  TradingView 优化：隐藏付费弹窗 Toast 提示，提供 Watchlist 批量添加、Pine Log 复制、Symbol 快捷键，以及 Pine Editor/Pine Log 快捷切换。
// @license      MIT
// @match        *://*.tradingview.com/*
// @match        *://tradingview.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TIMING = { inputDelay: 1200, clickDelay: 700, between: 1200, maxWait: 15000 };
  const TOAST_TEXT = '付费功能';
  const TOAST_MS = 2000;
  const CLEAN_INTERVAL = 2000;
  const OBSERVED_ATTRS = ['class', 'style'];
  const log = (...a) => console.log('[TV-OPT]', ...a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const CLICK_PAY_SELECTORS = [
    '.tv-floating-toolbar__widget--go-pro',
    '.tv-header__area--right .tv-header__link--pro',
    '[data-overflow-tooltip-text*="upgrade" i]',
    '[data-overflow-tooltip-text*="premium" i]',
    '[data-overflow-tooltip-text*="pro" i]',
    '[title*="upgrade" i]',
    '[title*="go pro" i]',
    '[title*="premium" i]',
    'a[href*="upgrade" i]',
    'a[href*="premium" i]'
  ];

  const DIALOG_SELECTORS = [
    '[data-dialog-name="gopro"]',
    '.tv-dialog--pro-plan',
    '.tv-dialog--upgrade',
    '[data-name="upgrade-dialog"]',
    '[data-name="pro-features-dialog"]',
    '[class*="gopro-"]'
  ];

  const BACKDROP_SELECTORS = [
    '.tv-dialog__modal-wrap',
    '.tv-dialog-manager__modal-container',
    '[class*="modal"]',
    '[class*="backdrop"]'
  ];

  const UPGRADE_TEXT_RE = /(upgrade|go\s*pro|premium|试用|升级|高级|尊享|会员)/i;
  let toastBox = null;
  let paywallInitialized = false;
  let clickFence = 0;
  const handledDialogs = new WeakSet();

  function appendStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  function injectPaywallStyles() {
    appendStyle(`
      #tv-opt-toast-box {
        position: fixed;
        inset-inline-end: 16px;
        inset-block-end: 16px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        gap: 8px;
        pointer-events: none;
      }
      .tv-opt-toast {
        background: rgba(0, 0, 0, 0.82);
        color: #fff;
        padding: 6px 10px;
        font-size: 11px;
        line-height: 1.4;
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        max-inline-size: 44ch;
        opacity: 0;
        transition: opacity 120ms ease;
        pointer-events: none;
        user-select: none;
      }
      [data-dialog-name="gopro"],
      .tv-dialog--pro-plan,
      .tv-dialog--upgrade,
      [data-name="upgrade-dialog"],
      [data-name="pro-features-dialog"] {
        display: none !important;
      }
      body {
        overflow: auto !important;
      }
    `);
  }

  function ensureToastBox() {
    if (toastBox) return toastBox;
    toastBox = document.createElement('div');
    toastBox.id = 'tv-opt-toast-box';
    (document.documentElement || document.body).appendChild(toastBox);
    return toastBox;
  }

  function showToast(text = TOAST_TEXT) {
    const box = ensureToastBox();
    const t = document.createElement('div');
    t.className = 'tv-opt-toast';
    t.textContent = text;
    box.appendChild(t);
    requestAnimationFrame(() => { t.style.opacity = '1'; });
    setTimeout(() => {
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 180);
    }, TOAST_MS);
  }

  function safeRemove(node) {
    try { node?.remove?.(); } catch (_) {}
  }

  function findDialogRoot(node) {
    if (!node || node.nodeType !== 1) return null;
    if (node.matches?.(DIALOG_SELECTORS.join(', '))) return node;
    for (const sel of DIALOG_SELECTORS) {
      const hit = node.closest?.(sel);
      if (hit) return hit;
    }
    return null;
  }

  function removeDialogPack(node) {
    const root = findDialogRoot(node);
    if (!root) return false;

    let container = null;
    for (const sel of BACKDROP_SELECTORS) {
      const hit = root.closest?.(sel);
      if (hit) { container = hit; break; }
    }
    if (container?.parentElement) {
      container.parentElement.querySelectorAll(BACKDROP_SELECTORS.join(', ')).forEach(safeRemove);
    }
    safeRemove(root);

    document.querySelectorAll('div[style*="position: fixed"]').forEach(el => {
      const z = Number(el.style.zIndex || 0);
      if (z >= 120 && UPGRADE_TEXT_RE.test(el.textContent || '')) safeRemove(el);
    });
    return true;
  }

  function isOwnUI(el) {
    return Boolean(el?.closest?.('#tv-opt-wlc, #tv-opt-toast-box, #tv-opt-pine-log-copy-btn'));
  }

  function isExplicitPayTarget(el) {
    if (isOwnUI(el)) return false;
    for (let i = 0, n = el; i < 6 && n; i++, n = n.parentElement) {
      if (isOwnUI(n)) return false;
      if (n.matches?.(CLICK_PAY_SELECTORS.join(', '))) return true;
      const label = (
        n.getAttribute?.('aria-label') ||
        n.getAttribute?.('title') ||
        n.getAttribute?.('data-overflow-tooltip-text') ||
        n.textContent || ''
      ).trim();
      if (label && UPGRADE_TEXT_RE.test(label)) return true;
      if (n.tagName === 'A' && /upgrade|premium/i.test(n.getAttribute('href') || '')) return true;
    }
    return false;
  }

  function removeExistingPaywall(silent = false) {
    let hit = false;
    for (const sel of DIALOG_SELECTORS) {
      document.querySelectorAll(sel).forEach(node => {
        if (handledDialogs.has(node)) return;
        handledDialogs.add(node);
        if (removeDialogPack(node)) hit = true;
      });
    }
    if (hit && !silent) showToast();
    return hit;
  }

  function handlePaywallMutations(mutations) {
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(node => {
          if (node.nodeType !== 1) return;
          if (!node.matches?.(DIALOG_SELECTORS.join(', ')) && !node.querySelector?.(DIALOG_SELECTORS.join(', '))) return;
          if (handledDialogs.has(node)) return;
          handledDialogs.add(node);
          if (removeDialogPack(node)) showToast();
        });
      } else if (m.type === 'attributes') {
        const target = m.target;
        if (target.nodeType !== 1 || handledDialogs.has(target)) continue;
        if (!target.matches?.(DIALOG_SELECTORS.join(', ')) && !UPGRADE_TEXT_RE.test(target.textContent || '')) continue;
        handledDialogs.add(target);
        if (removeDialogPack(target)) showToast();
      }
    }
  }

  function isEditableTarget(el) {
    return Boolean(el?.closest?.('input, textarea, select, [contenteditable="true"], [contenteditable=""]'));
  }

  function findSymbolSearchButton() {
    return document.querySelector('#header-toolbar-symbol-search') ||
      document.querySelector('button[aria-label*="symbol search" i]') ||
      document.querySelector('button[data-tooltip*="symbol search" i]') ||
      document.querySelector('button[id*="symbol-search" i]');
  }

  function findCompareSymbolsButton() {
    return document.querySelector('#header-toolbar-compare') ||
      document.querySelector('button[aria-label="Compare symbols" i]') ||
      document.querySelector('button[data-tooltip="Compare symbols" i]') ||
      document.querySelector('button[id*="compare" i][aria-haspopup="dialog"]');
  }

  function findOpenPineLogPanel() {
    return [...document.querySelectorAll('[data-test-id-widget-type="pine_logs"], .widgetbar-widget-pine_logs')]
      .find(isVisible);
  }

  function findPineLogButton() {
    const direct = [
      '[data-qa-id="open-pine-logs"]',
      'button[aria-label*="Pine Log" i]',
      'button[aria-label*="Pine Logs" i]',
      'button[data-tooltip*="Pine Log" i]',
      'button[title*="Pine Log" i]',
      '[role="tab"][aria-label*="Pine Log" i]',
      '[role="tab"][title*="Pine Log" i]'
    ].map(sel => document.querySelector(sel)).find(isVisible);
    if (direct) return direct;

    return [...document.querySelectorAll('button, [role="button"], [role="tab"], [role="menuitem"]')]
      .find(el => isVisible(el) && /^pine logs?$/i.test(getText(el).replace(/Click to learn more/i, '').trim()));
  }

  function findPineEditorButton() {
    return [...document.querySelectorAll('[data-name="pine-dialog-button"], button[aria-label="Pine" i], button[data-tooltip="Pine" i]')]
      .find(isVisible);
  }

  function findPineScriptMoreOptionsButton() {
    return [...document.querySelectorAll('[data-qa-id="script-more-options"]')]
      .find(isVisible);
  }

  function getPineEditorRoots() {
    const moreButton = findPineScriptMoreOptionsButton();
    return [
      moreButton?.closest('[class*="widget" i]'),
      moreButton?.closest('[class*="dialog" i]'),
      moreButton?.closest('[class*="container" i]'),
      moreButton?.closest('[class*="pane" i]'),
      document
    ].filter(Boolean);
  }

  function findPineEditorCloseButton() {
    const moreButton = findPineScriptMoreOptionsButton();
    for (const root of getPineEditorRoots()) {
      const closeButton = [...root.querySelectorAll('button[aria-label="Close" i], button[title="Close" i]')]
        .filter(isVisible)
        .find(btn => btn !== moreButton);
      if (closeButton) return closeButton;
    }
    return null;
  }

  function findPineLogCloseButton() {
    const panel = findOpenPineLogPanel();
    if (!panel) return null;
    const root = panel.closest('.widgetbar-page') || panel;
    return [...root.querySelectorAll('button[aria-label="Close" i], button[title="Close" i], [data-name*="close" i]')]
      .find(isVisible);
  }

  function togglePineEditor() {
    const closeButton = findPineEditorCloseButton();
    if (closeButton) {
      safeClick(closeButton);
      return true;
    }

    const pineEditorButton = findPineEditorButton();
    if (!pineEditorButton) {
      showToast('未找到 Pine Editor 入口');
      return false;
    }
    safeClick(pineEditorButton);
    return true;
  }

  async function openPineLogPanel() {
    if (findOpenPineLogPanel()) return true;

    let pineLogButton = findPineLogButton();
    if (!pineLogButton) {
      const pineEditorButton = findPineEditorButton();
      if (pineEditorButton) {
        safeClick(pineEditorButton);
        await sleep(250);
      }

      const moreButton = await waitFor(findPineScriptMoreOptionsButton, 2000, 100);
      if (moreButton) {
        safeClick(moreButton);
        await sleep(150);
      }

      pineLogButton = await waitFor(findPineLogButton, 2000, 100);
    }

    if (!pineLogButton) {
      showToast('未找到 Pine Log 入口');
      return false;
    }
    safeClick(pineLogButton);
    await waitFor(findOpenPineLogPanel, 2000, 100);
    return true;
  }

  async function togglePineLogPanel() {
    const closeButton = findPineLogCloseButton();
    if (closeButton) {
      safeClick(closeButton);
      return true;
    }
    return openPineLogPanel();
  }

  function triggerNativeToolbarButton(findButton, fallbackMessage) {
    const button = findButton();
    if (!button) {
      showToast(fallbackMessage);
      return false;
    }
    safeClick(button);
    return true;
  }

  function initToolbarShortcuts() {
    if (!/\/chart\//.test(location.pathname)) return;
    window.addEventListener('keydown', e => {
      if (e.metaKey || e.shiftKey || e.repeat) return;
      const key = e.key.toLowerCase();
      const editable = isEditableTarget(e.target);
      const altOnly = e.altKey && !e.ctrlKey;
      const ctrlAlt = e.ctrlKey && e.altKey;
      if (altOnly && key === 's' && !editable) {
        e.preventDefault();
        e.stopPropagation();
        triggerNativeToolbarButton(findSymbolSearchButton, '未找到 Symbol Search 入口');
      } else if (altOnly && key === 'c' && !editable) {
        e.preventDefault();
        e.stopPropagation();
        triggerNativeToolbarButton(findCompareSymbolsButton, '未找到 Compare Symbols 入口');
      } else if (ctrlAlt && key === 'l') {
        e.preventDefault();
        e.stopPropagation();
        togglePineLogPanel().catch(err => {
          console.error('[TV-OPT Pine Log]', err);
          showToast('切换 Pine Log 失败');
        });
      } else if (ctrlAlt && key === 'e') {
        e.preventDefault();
        e.stopPropagation();
        togglePineEditor();
      }
    }, true);
    log('Toolbar shortcuts 已加载: Alt+S Symbol Search, Alt+C Compare, Ctrl+Alt+L Pine Log, Ctrl+Alt+E Pine Editor');
  }

  function initPaywallToast() {
    if (paywallInitialized) return;
    paywallInitialized = true;
    injectPaywallStyles();
    removeExistingPaywall();

    const root = document.body || document.documentElement;
    const observer = new MutationObserver(handlePaywallMutations);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: OBSERVED_ATTRS });

    window.addEventListener('click', e => {
      if (isOwnUI(e.target)) return;
      clickFence++;
      if (isExplicitPayTarget(e.target)) showToast();
      const fenceAtClick = clickFence;
      [0, 150, 300, 600, 900, 1200].forEach(delay => {
        setTimeout(() => {
          if (fenceAtClick === clickFence) removeExistingPaywall(true);
        }, delay);
      });
    }, true);

    window.addEventListener('keydown', () => {
      setTimeout(removeExistingPaywall, 0);
      setTimeout(removeExistingPaywall, 180);
    }, true);

    setInterval(removeExistingPaywall, CLEAN_INTERVAL);
  }

  function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch]));
  }

  function extractFromDOM() {
    const result = { sections: [], flatSymbols: [] };
    const listWrap =
      document.querySelector('[class*="contentWrap-"] [class*="wrapper-"] > [class*="wrap-"]') ||
      document.querySelector('[class*="wrapper-"] > [class*="wrap-"]');
    if (!listWrap) return result;

    let cur = null;
    for (const child of listWrap.children) {
      const cls = child.className || '';
      if (cls.includes('locator-') || !cls.includes('listItem-')) continue;
      if (cls.includes('noBorder-')) {
        const title = child.querySelector('span[class*="title-"][class*="toggleable-"]');
        if (title) {
          const name = title.textContent.replace(/[⁤]/g, '').trim();
          if (name) { cur = { name, symbols: [] }; result.sections.push(cur); }
        }
        continue;
      }
      const link = child.querySelector('a[href*="/symbols/"]');
      if (!link) continue;
      const m = link.getAttribute('href').match(/\/symbols\/([A-Z]+)-([A-Z0-9]+)\/?/);
      if (!m) continue;
      const sym = `${m[1]}:${m[2]}`;
      result.flatSymbols.push(sym);
      if (cur) cur.symbols.push(sym);
    }
    return result;
  }

  function guessASharePrefix(code) {
    return /^[569]/.test(code) ? 'SSE:' : 'SZSE:';
  }

  function normalizeManualSymbol(raw) {
    let s = raw.trim().toUpperCase();
    if (!s) return '';
    s = s.replace(/\s+/g, '').replace(/，/g, ',').replace(/；/g, ';');

    if (/^(SSE|SH|XSHG):\d{6}$/.test(s)) return 'SSE:' + s.split(':')[1];
    if (/^(SZSE|SZ|XSHE):\d{6}$/.test(s)) return 'SZSE:' + s.split(':')[1];
    if (/^\d{6}$/.test(s)) return guessASharePrefix(s) + s;

    const m = s.match(/^(\d{6})\.(SH|SZ)$/);
    if (m) return (m[2] === 'SH' ? 'SSE:' : 'SZSE:') + m[1];

    return s;
  }

  function parseManualSymbols(text) {
    return text.split(/[\n,; ]+/).map(normalizeManualSymbol).filter(Boolean);
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  }

  function getText(el) {
    return (el?.innerText || el?.textContent || '').trim();
  }

  function safeClick(el) {
    if (!el) return;
    try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
    try { el.click(); return; } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  function setNativeValue(input, value) {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value');
    if (desc?.set) desc.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  async function waitFor(fn, timeout = TIMING.maxWait, interval = 250) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = fn();
      if (result) return result;
      await sleep(interval);
    }
    return null;
  }

  function findAddSymbolButton() {
    for (const sel of [
      'button[data-name="add-symbol-button"][aria-label="Add symbol"]',
      'button[data-name="add-symbol-button"][data-tooltip="Add symbol"]',
      'button[data-name="add-symbol-button"]'
    ]) {
      const el = [...document.querySelectorAll(sel)].find(isVisible);
      if (el) return el;
    }
    return null;
  }

  function getCandidateDialogRoots() {
    return [...new Set([
      ...document.querySelectorAll('[role="dialog"]'),
      ...document.querySelectorAll('[class*="dialog"]'),
      ...document.querySelectorAll('[class*="popup"]'),
      ...document.querySelectorAll('[class*="modal"]')
    ].filter(isVisible))];
  }

  function findSearchInput(root) {
    for (const sel of [
      'input[placeholder*="Search" i]',
      'input[aria-label*="Search" i]',
      'input[placeholder*="symbol" i]',
      'input[aria-label*="symbol" i]',
      'input[type="text"]',
      'input:not([type])'
    ]) {
      const el = [...root.querySelectorAll(sel)].find(isVisible);
      if (el) return el;
    }
    return null;
  }

  function findOpenedAddDialog() {
    for (const root of getCandidateDialogRoots()) {
      const text = getText(root).toLowerCase();
      if (text.includes('compare') || text.includes('comparison') || text.includes('对比') || text.includes('比较')) continue;
      const input = findSearchInput(root);
      if (!input) continue;
      const addIcons = [
        ...root.querySelectorAll('span[role="img"][class*="addAction-"]'),
        ...root.querySelectorAll('[class*="actionsCell-"] span[role="img"]')
      ].filter(isVisible);
      if (addIcons.length > 0) return { root, input };
    }
    return null;
  }

  async function openAddDialog() {
    const panelBtn = [...document.querySelectorAll(
      'button[aria-label="Watchlist, details and news"], button[data-tooltip="Watchlist, details and news"]'
    )].find(isVisible);
    if (panelBtn && panelBtn.getAttribute('aria-pressed') !== 'true') {
      safeClick(panelBtn);
      await sleep(TIMING.clickDelay);
    }

    const addBtn = await waitFor(findAddSymbolButton);
    if (!addBtn) throw new Error('找不到 Add symbol 按钮');
    safeClick(addBtn);
    await sleep(TIMING.clickDelay);

    const dialog = await waitFor(findOpenedAddDialog);
    if (!dialog) throw new Error('Add symbol 弹窗没出现');
    return dialog;
  }

  function findResultAddButton(root, symbol) {
    const upper = symbol.toUpperCase();
    const code = upper.includes(':') ? upper.split(':')[1] : upper;
    const addBtns = [
      ...root.querySelectorAll('span[role="img"][class*="addAction-"]'),
      ...root.querySelectorAll('[class*="actionsCell-"] span[role="img"]')
    ].filter(isVisible);

    for (const btn of addBtns) {
      const row = btn.closest('[role="row"]') || btn.closest('[class*="wrap-"]') ||
        btn.closest('[class*="itemRow-"]') || btn.parentElement?.parentElement?.parentElement;
      if (!row) continue;
      const rowText = getText(row).toUpperCase();
      if (rowText.includes(upper) || rowText.includes(code)) return btn;
    }
    return addBtns.length === 1 ? addBtns[0] : null;
  }

  async function closeDialog(root) {
    if (!root) return;
    const close = [...root.querySelectorAll('button, [role="button"]')].find(el => {
      if (!isVisible(el)) return false;
      const text = [el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-tooltip'), getText(el)]
        .join(' ')
        .toLowerCase();
      return text.includes('close') || text.includes('关闭');
    });
    if (close) { safeClick(close); await sleep(300); return; }
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape', code: 'Escape' }));
    await sleep(300);
  }

  async function clearInput(input) {
    input.focus();
    setNativeValue(input, '');
    await sleep(100);
    for (const [key, code, ctrl] of [['a', 'KeyA', true], ['Backspace', 'Backspace', false]]) {
      input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key, code, ctrlKey: !!ctrl }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key, code, ctrlKey: !!ctrl }));
    }
    setNativeValue(input, '');
    await sleep(100);
  }

  async function addOneSymbol(symbol) {
    log('添加:', symbol);
    const { root, input } = await openAddDialog();
    await clearInput(input);
    input.focus();
    setNativeValue(input, symbol);
    await sleep(TIMING.inputDelay);
    const addBtn = await waitFor(() => findResultAddButton(root, symbol), 5000, 250);
    if (!addBtn) { await closeDialog(root); throw new Error(`搜索结果没找到 ${symbol}`); }
    safeClick(addBtn);
    await sleep(TIMING.clickDelay);
    await closeDialog(root);
    log('添加完成:', symbol);
  }

  function injectWatchlistStyles() {
    appendStyle(`
      #tv-opt-wlc {
        position: fixed;
        inset-block-start: 35%;
        inset-inline-end: 8px;
        transform: translateY(-50%);
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 13px;
      }
      #tv-opt-wlc-fab {
        inline-size: 36px;
        block-size: 36px;
        padding: 0;
        border-radius: 6.75px;
        background: #131722 url('https://i.postimg.cc/XvW9Q04k/tvopt-icon.png') center / cover no-repeat;
        border: 1px solid #363a45;
        cursor: pointer;
        box-shadow: 0 4px 14px rgba(19, 23, 34, .45);
        transition: transform .15s;
      }
      #tv-opt-wlc-fab:hover { transform: scale(1.08); }
      #tv-opt-wlc-panel {
        display: none;
        position: absolute;
        inset-block-start: 0;
        inset-inline-end: 48px;
        inline-size: min(380px, calc(100vw - 72px));
        max-block-size: calc(100vh - 24px);
        background: #1e222d;
        border: 1px solid #363a45;
        border-radius: 10px;
        box-shadow: 0 8px 30px rgba(0, 0, 0, .55);
        color: #d1d4dc;
        overflow-y: auto;
        scrollbar-width: thin;
        scrollbar-color: #434651 transparent;
      }
      #tv-opt-wlc-panel::-webkit-scrollbar { inline-size: 6px; }
      #tv-opt-wlc-panel::-webkit-scrollbar-track { background: transparent; }
      #tv-opt-wlc-panel::-webkit-scrollbar-thumb {
        background: #434651;
        border-radius: 999px;
      }
      #tv-opt-wlc-panel::-webkit-scrollbar-thumb:hover { background: #5a5f70; }
      #tv-opt-wlc-panel.open { display: block; }
      .tv-opt-wlc-header {
        padding: 12px 16px;
        background: #131722;
        border-block-end: 1px solid #363a45;
        font-weight: 600;
        font-size: 14px;
        color: #fff;
        display: flex;
        justify-content: space-between;
      }
      .tv-opt-wlc-shortcuts {
        padding: 8px 10px;
        border: 1px solid #363a45;
        border-radius: 6px;
        background: #131722;
        color: #b2b5be;
        font-size: 12px;
        line-height: 1.6;
      }
      .tv-opt-kbd {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-inline-size: 16px;
        margin-inline: 2px;
        padding: 1px 5px;
        border: 1px solid #434651;
        border-radius: 4px;
        background: #2a2e39;
        color: #fff;
        font-family: 'SF Mono', Monaco, Consolas, monospace;
        font-size: 11px;
      }
      .tv-opt-wlc-manual { padding: 12px 16px 0; }
      #tv-opt-wlc-input {
        inline-size: 100%;
        block-size: 132px;
        box-sizing: border-box;
        resize: vertical;
        background: #131722;
        color: #d1d4dc;
        border: 1px solid #363a45;
        border-radius: 6px;
        padding: 8px;
        font-size: 12px;
        line-height: 1.45;
        font-family: 'SF Mono', Monaco, Consolas, monospace;
        scrollbar-width: thin;
        scrollbar-color: #434651 transparent;
      }
      #tv-opt-wlc-input::-webkit-scrollbar { inline-size: 6px; }
      #tv-opt-wlc-input::-webkit-scrollbar-track { background: transparent; }
      #tv-opt-wlc-input::-webkit-scrollbar-thumb {
        background: #434651;
        border-radius: 999px;
      }
      #tv-opt-wlc-input::-webkit-scrollbar-thumb:hover { background: #5a5f70; }
      .tv-opt-wlc-body {
        padding: 12px 16px;
        max-block-size: 280px;
        overflow-y: auto;
      }
      .tv-opt-wlc-tag {
        display: inline-block;
        background: #363a45;
        color: #b2b5be;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        margin: 6px 0 3px;
      }
      .tv-opt-wlc-symbols {
        font-family: 'SF Mono', Monaco, Consolas, monospace;
        font-size: 11px;
        line-height: 1.7;
        word-break: break-all;
        margin-block-end: 4px;
      }
      .tv-opt-wlc-item {
        display: inline-block;
        margin: 2px 4px 2px 0;
        padding: 2px 6px;
        border-radius: 3px;
        background: #2a2e39;
        transition: all .15s;
      }
      .tv-opt-wlc-done { background: #1b3a26; color: #26a69a; text-decoration: line-through; opacity: .6; }
      .tv-opt-wlc-active { background: #2962ff; color: #fff; font-weight: 600; }
      .tv-opt-wlc-error { background: #3a1b1b; color: #ef5350; }
      .tv-opt-wlc-footer {
        padding: 12px 16px;
        border-block-start: 1px solid #363a45;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .tv-opt-wlc-row { display: flex; gap: 6px; }
      .tv-opt-btn {
        flex: 1;
        padding: 9px;
        border: none;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: background .15s;
      }
      .tv-opt-btn-primary { background: #2962ff; color: #fff; }
      .tv-opt-btn-primary:hover { background: #1e88e5; }
      .tv-opt-btn-primary:disabled { background: #555; cursor: wait; }
      .tv-opt-btn-secondary { background: #363a45; color: #d1d4dc; }
      .tv-opt-btn-secondary:hover { background: #434651; }
      .tv-opt-btn-success { background: #26a69a; color: #fff; }
      .tv-opt-btn-success:hover { background: #2bb5a8; }
      .tv-opt-status { font-size: 12px; min-block-size: 18px; line-height: 1.5; }
      .tv-opt-status-ok { color: #26a69a; }
      .tv-opt-status-er { color: #ef5350; }
      .tv-opt-status-i { color: #b2b5be; }
    `);
  }

  let extracted = null;
  let manualText = '';
  let addIdx = 0;
  let addRunning = false;
  let addCancelled = false;
  let addErrors = new Set();

  function buildWatchlistUI() {
    document.getElementById('tv-opt-wlc')?.remove();
    const root = document.createElement('div');
    root.id = 'tv-opt-wlc';
    root.innerHTML = '<div id="tv-opt-wlc-panel"></div><button id="tv-opt-wlc-fab" type="button" aria-label="TradingView Optimizer"></button>';
    document.body.appendChild(root);

    root.querySelector('#tv-opt-wlc-fab').onclick = () => {
      const panel = root.querySelector('#tv-opt-wlc-panel');
      if (panel.classList.toggle('open')) drawWatchlistPanel(panel);
      else panel.style.insetBlockStart = '0px';
    };
    log('Watchlist UI 已创建');
  }

  function renderSymbolItems(symbols) {
    return symbols.map((sym, i) => {
      const cls = addErrors.has(i) ? 'tv-opt-wlc-error' : i < addIdx ? 'tv-opt-wlc-done' : i === addIdx ? 'tv-opt-wlc-active' : '';
      return `<span class="tv-opt-wlc-item ${cls}">${escapeHTML(sym)}</span>`;
    }).join('');
  }

  function fitWatchlistPanel(panel) {
    panel.style.insetBlockStart = '0px';
    requestAnimationFrame(() => {
      const rect = panel.getBoundingClientRect();
      const margin = 12;
      const overflow = rect.bottom + margin - window.innerHeight;
      panel.style.insetBlockStart = overflow > 0 ? `${-overflow}px` : '0px';
    });
  }

  function drawWatchlistPanel(panel = document.querySelector('#tv-opt-wlc-panel')) {
    if (!panel) return;

    const hasData = extracted && extracted.flatSymbols.length > 0;
    const symbols = hasData ? extracted.flatSymbols : [];
    const total = symbols.length;
    const done = addIdx >= total && hasData;

    let listHTML = '';
    if (!hasData) {
      listHTML = '<div class="tv-opt-status-i" style="text-align:center;padding:20px 0">点击“提取页面”读取当前 watchlist，<br>或粘贴 A 股代码后点“匹配前缀”。</div>';
    } else if (extracted.sections.some(s => s.symbols.length)) {
      for (const section of extracted.sections) {
        if (!section.symbols.length) continue;
        listHTML += `<div class="tv-opt-wlc-tag">${escapeHTML(section.name)}</div><div class="tv-opt-wlc-symbols">`;
        listHTML += section.symbols.map(sym => {
          const globalIndex = symbols.indexOf(sym);
          const cls = addErrors.has(globalIndex) ? 'tv-opt-wlc-error' : globalIndex < addIdx ? 'tv-opt-wlc-done' : globalIndex === addIdx ? 'tv-opt-wlc-active' : '';
          return `<span class="tv-opt-wlc-item ${cls}">${escapeHTML(sym)}</span>`;
        }).join('');
        listHTML += '</div>';
      }
    } else {
      listHTML = `<div class="tv-opt-wlc-symbols">${renderSymbolItems(symbols)}</div>`;
    }

    panel.innerHTML = `
      <div class="tv-opt-wlc-header">
        <span>TradingView Optimizer</span>
        <span style="font-weight:400;color:#b2b5be;font-size:12px">${hasData ? addIdx + '/' + total : ''}</span>
      </div>
      <div class="tv-opt-wlc-manual">
        <textarea id="tv-opt-wlc-input" placeholder="手动贴 A 股代码，一行一个或逗号分隔，例如：&#10;000001&#10;300308&#10;300750">${escapeHTML(manualText)}</textarea>
      </div>
      <div class="tv-opt-wlc-body">${listHTML}</div>
      <div class="tv-opt-wlc-footer">
        <div class="tv-opt-wlc-row">
          <button class="tv-opt-btn tv-opt-btn-primary" id="tv-opt-extract" type="button">提取页面</button>
          <button class="tv-opt-btn tv-opt-btn-secondary" id="tv-opt-preview" type="button">匹配前缀</button>
          <button class="tv-opt-btn tv-opt-btn-success" id="tv-opt-add" type="button" ${!hasData ? 'disabled' : ''}>${addRunning ? '暂停' : done ? '完成' : '开始添加'}</button>
        </div>
        <div class="tv-opt-wlc-row">
          <button class="tv-opt-btn tv-opt-btn-secondary" id="tv-opt-skip" type="button" ${!hasData || done ? 'disabled' : ''}>跳过</button>
          <button class="tv-opt-btn tv-opt-btn-secondary" id="tv-opt-copy-one" type="button" ${!hasData || done ? 'disabled' : ''}>复制当前</button>
          <button class="tv-opt-btn tv-opt-btn-secondary" id="tv-opt-copy-all" type="button" ${!hasData ? 'disabled' : ''}>复制全部</button>
        </div>
        <div class="tv-opt-wlc-shortcuts">
          快捷键：<br>
            <span class="tv-opt-kbd">Alt</span> + <span class="tv-opt-kbd">S</span> 打开 Symbol Search；<br>
            <span class="tv-opt-kbd">Alt</span> + <span class="tv-opt-kbd">C</span> 打开 Compare Symbols；<br>
            <span class="tv-opt-kbd">Ctrl</span> + <span class="tv-opt-kbd">Alt</span> + <span class="tv-opt-kbd">E</span> 打开/关闭 Pine Editor；<br>
            <span class="tv-opt-kbd">Ctrl</span> + <span class="tv-opt-kbd">Alt</span> + <span class="tv-opt-kbd">L</span> 打开/关闭 Pine Log。
        </div>
        <div class="tv-opt-status tv-opt-status-i" id="tv-opt-status">v1.2.0</div>
      </div>`;

    fitWatchlistPanel(panel);

    const status = (msg, type = 'ok') => {
      const el = panel.querySelector('#tv-opt-status');
      if (el) { el.textContent = msg; el.className = 'tv-opt-status tv-opt-status-' + type; }
    };

    const manualInput = panel.querySelector('#tv-opt-wlc-input');
    manualInput.oninput = () => { manualText = manualInput.value; };

    panel.querySelector('#tv-opt-extract').onclick = () => {
      manualText = manualInput.value;
      extracted = extractFromDOM();
      addIdx = 0;
      addErrors = new Set();
      const count = extracted.flatSymbols.length;
      if (count) status(`提取到 ${count} 个 symbol，${extracted.sections.length} 个分组`, 'ok');
      else status('未找到 symbols，页面可能没加载完', 'er');
      drawWatchlistPanel(panel);
    };

    panel.querySelector('#tv-opt-preview').onclick = () => {
      manualText = manualInput.value;
      const parsed = parseManualSymbols(manualText);
      extracted = parsed.length ? { sections: [{ name: '手动输入', symbols: parsed }], flatSymbols: parsed } : null;
      addIdx = 0;
      addErrors = new Set();
      if (parsed.length) status(`已匹配前缀 ${parsed.length} 个，确认后点“开始添加”`, 'ok');
      else status('没有识别到代码', 'er');
      drawWatchlistPanel(panel);
    };

    panel.querySelector('#tv-opt-add').onclick = async () => {
      if (!hasData) return;
      if (addRunning) { addCancelled = true; return; }
      if (done) return;
      manualText = manualInput.value;

      addRunning = true;
      addCancelled = false;
      drawWatchlistPanel(panel);

      while (addIdx < total && !addCancelled) {
        const sym = symbols[addIdx];
        status(`(${addIdx + 1}/${total}) 添加 ${sym}...`, 'i');
        drawWatchlistPanel(panel);
        try {
          await addOneSymbol(sym);
          addIdx++;
          status(`${sym} 已添加`, 'ok');
        } catch (e) {
          addErrors.add(addIdx);
          addIdx++;
          status(`${sym}: ${e.message}`, 'er');
          log('添加失败:', sym, e);
        }
        await sleep(TIMING.between);
      }

      addRunning = false;
      if (addIdx >= total) {
        const failed = addErrors.size;
        status(failed ? `完成: ${total - failed} 成功, ${failed} 失败` : `全部 ${total} 个添加完成`, failed ? 'er' : 'ok');
      }
      drawWatchlistPanel(panel);
    };

    panel.querySelector('#tv-opt-skip').onclick = () => {
      if (addIdx < total) { addIdx++; drawWatchlistPanel(panel); }
    };
    panel.querySelector('#tv-opt-copy-one').onclick = () => {
      if (addIdx < total) { navigator.clipboard.writeText(symbols[addIdx]); status(`已复制 ${symbols[addIdx]}`); }
    };
    panel.querySelector('#tv-opt-copy-all').onclick = () => {
      navigator.clipboard.writeText(symbols.join(', '));
      status(`已复制全部 ${total} 个`);
    };
  }

  function initWatchlistOpt() {
    if (!/\/(watchlists|chart)\//.test(location.pathname)) return;
    injectWatchlistStyles();
    buildWatchlistUI();
  }

  const PINE_COPY_BTN_ID = 'tv-opt-pine-log-copy-btn';
  const PINE_COPY_ICON = '<svg viewBox="0 0 24 24"><path d="M16 1H4C2.9 1 2 1.9 2 3v14h2V3h12V1zm3 4H8C6.9 5 6 5.9 6 7v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
  const PINE_CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

  function injectPineLogStyles() {
    appendStyle(`
      #${PINE_COPY_BTN_ID} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        inline-size: 28px;
        block-size: 28px;
        border: none;
        border-radius: 4px;
        background: transparent;
        color: var(--tv-color-toolbar-button-text, #b2b5be);
        cursor: pointer;
        user-select: none;
        transition: color .12s, background .12s;
        padding: 0;
      }
      #${PINE_COPY_BTN_ID}:hover {
        color: var(--tv-color-toolbar-button-text-hover, #d1d4dc);
        background: var(--tv-color-toolbar-button-background-hover, rgba(255, 255, 255, .06));
      }
      #${PINE_COPY_BTN_ID}:active { color: var(--tv-color-toolbar-button-text-active, #fff); }
      #${PINE_COPY_BTN_ID} svg {
        inline-size: 20px;
        block-size: 20px;
        fill: currentColor;
      }
      #${PINE_COPY_BTN_ID}.copied { color: #26a69a !important; }
      #${PINE_COPY_BTN_ID}.fail { color: #ef5350 !important; }
    `);
  }

  function createPineLogButton() {
    const btn = document.createElement('div');
    btn.id = PINE_COPY_BTN_ID;
    btn.setAttribute('data-role', 'button');
    btn.setAttribute('title', '复制 Pine Log');
    btn.className = 'apply-common-tooltip';
    btn.innerHTML = PINE_COPY_ICON;
    btn.addEventListener('click', onCopyPineLog);
    return btn;
  }

  function tryInjectPineLogButton() {
    if (document.getElementById(PINE_COPY_BTN_ID)) return;
    const searchBtn = document.querySelector('[data-name="button-open-search-input"]');
    if (!searchBtn?.parentNode) return;
    searchBtn.parentNode.insertBefore(createPineLogButton(), searchBtn);
  }

  function findPineLogScrollableAncestor() {
    const virtualScroll = document.querySelector('div[class*="virtualScroll"]');
    if (!virtualScroll) return null;
    let el = virtualScroll.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 5) return el;
      el = el.parentElement;
    }
    return null;
  }

  function readVisiblePineLogMessages() {
    const msgs = [];
    document.querySelectorAll('div[data-index]').forEach(row => {
      const span = row.querySelector('span[class*="msg-"]');
      if (!span) return;
      const index = parseInt(row.getAttribute('data-index'), 10);
      const text = span.textContent.trim();
      if (Number.isFinite(index) && text) msgs.push({ index, text });
    });
    return msgs;
  }

  async function waitForPineLogRender(prevMaxIndex, timeout = 500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(30);
      const msgs = readVisiblePineLogMessages();
      const curMax = msgs.reduce((max, row) => Math.max(max, row.index), -1);
      if (curMax > prevMaxIndex) return;
    }
  }

  async function collectAllPineLogs() {
    const scrollEl = findPineLogScrollableAncestor();
    if (!scrollEl) {
      const msgs = readVisiblePineLogMessages();
      return msgs.length ? msgs.sort((a, b) => a.index - b.index).map(m => m.text).join('\n') : null;
    }

    const collected = new Map();
    const originalTop = scrollEl.scrollTop;
    scrollEl.scrollTop = 0;
    await sleep(200);
    readVisiblePineLogMessages().forEach(m => collected.set(m.index, m.text));

    const step = Math.max(Math.floor(scrollEl.clientHeight * 0.4), 20);
    let noNewCount = 0;

    for (let i = 0; i < 2000; i++) {
      const prevSize = collected.size;
      const prevMaxIndex = [...collected.keys()].reduce((max, index) => Math.max(max, index), -1);

      scrollEl.scrollTop += step;
      await waitForPineLogRender(prevMaxIndex, 400);
      readVisiblePineLogMessages().forEach(m => collected.set(m.index, m.text));

      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (scrollEl.scrollTop >= maxScroll - 2) {
        await sleep(150);
        readVisiblePineLogMessages().forEach(m => collected.set(m.index, m.text));
        break;
      }

      if (collected.size === prevSize) {
        noNewCount++;
        if (noNewCount > 8) break;
      } else {
        noNewCount = 0;
      }
    }

    const indices = [...collected.keys()].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 0; i < indices.length - 1; i++) {
      if (indices[i + 1] - indices[i] > 1) gaps.push({ from: indices[i], to: indices[i + 1] });
    }

    if (gaps.length > 0) {
      log('Pine Log 检测到缺口，补扫:', gaps);
      const firstRow = document.querySelector('div[data-index]');
      const rowHeight = firstRow ? firstRow.getBoundingClientRect().height : 56;
      for (const gap of gaps) {
        scrollEl.scrollTop = gap.from * rowHeight;
        await sleep(200);
        readVisiblePineLogMessages().forEach(m => collected.set(m.index, m.text));
      }
    }

    scrollEl.scrollTop = originalTop;
    return collected.size
      ? [...collected.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]).join('\n')
      : null;
  }

  function resetPineLogButton(btn) {
    if (!btn) return;
    btn.classList.remove('copied', 'fail');
    btn.innerHTML = PINE_COPY_ICON;
    btn.title = '复制 Pine Log';
  }

  async function onCopyPineLog(event) {
    event?.stopPropagation?.();
    const btn = document.getElementById(PINE_COPY_BTN_ID);
    if (!btn || btn.classList.contains('copied')) return;

    btn.classList.add('copied');
    btn.innerHTML = PINE_CHECK_ICON;
    btn.title = '收集中...';

    try {
      const text = await collectAllPineLogs();
      if (!text) {
        btn.classList.remove('copied');
        btn.classList.add('fail');
        btn.title = '未找到 Log 内容';
        setTimeout(() => resetPineLogButton(btn), 2000);
        return;
      }

      await navigator.clipboard.writeText(text);
      btn.title = `已复制 ${text.split('\n').length} 行`;
    } catch (e) {
      console.error('[TV-OPT Pine Log]', e);
      btn.classList.remove('copied');
      btn.classList.add('fail');
      btn.title = '复制失败: ' + e.message;
    }

    setTimeout(() => resetPineLogButton(btn), 2500);
  }

  function initPineLogCopier() {
    if (!/\/chart\//.test(location.pathname)) return;
    injectPineLogStyles();
    let debounce = null;
    const observer = new MutationObserver(() => {
      if (document.getElementById(PINE_COPY_BTN_ID)) return;
      clearTimeout(debounce);
      debounce = setTimeout(tryInjectPineLogButton, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    [2000, 4000, 7000, 12000].forEach(ms => setTimeout(tryInjectPineLogButton, ms));
    log('Pine Log Copier 已加载');
  }

  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  onReady(initPaywallToast);
  window.addEventListener('load', () => {
    setTimeout(initToolbarShortcuts, 1000);
    setTimeout(initWatchlistOpt, 2000);
    setTimeout(initPineLogCopier, 2000);
  }, { once: true });
})();
