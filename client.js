/**
 * dsh-file-panel — client half (bootstrap).
 * Full UI lands in the next iteration; this revision proves the module loads,
 * wraps the workspace-path opener, and exposes a debug face for verification.
 */
window.__ModuleLoader__.load({
  id: 'dsh-file-panel',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const React = require('react');

    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      console.warn('[dsh-file-panel] primitives unavailable:', error?.message ?? error);
    }


    const STYLE_ID = 'dsh-file-panel-style';
    const DOCK_HOST_ID = 'dsh-file-panel-dock-host';
    const SEAT_PRIORITY = -1000;
    const POLL_INTERVAL_MS = 2000;
    const MAX_TABS = 12;
    const MARKDOWN_LABELS = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' };
    const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico', '.pdf'];

    // ------------------------------------------------------------------
    // store — one state per session, one owner for the seat
    // ------------------------------------------------------------------

    const runtime = { version: 0, visible: false, owner: null, mode: 'column', dockWidth: 420 };
    const sessionStates = new Map();
    const listeners = new Set();

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function getVersion() {
      return runtime.version;
    }

    function notify() {
      runtime.version += 1;
      syncDockLayout();
      syncToggleButton();
      reportDiag('repaint');
      reportTitle();
      for (const listener of listeners) {
        try {
          listener();
        } catch (error) {
          console.warn('[dsh-file-panel] listener failed:', error);
        }
      }
    }

    /** The build this client is. Shown in the footer so it is never a guess
     *  which version a window is running. */
    const CLIENT_BUILD = '0.4.3';

    let tabSeq = 0;

    // The host reports its path separator in /health; until it answers we assume
    // POSIX, which every filesystem API the panel talks to also accepts.
    let pathSeparator = '/';

    /** A `/`-joined path respelled with the host's own separator. */
    function nativePath(value) {
      if (typeof value !== 'string' || pathSeparator === '/') return value;
      return value.split('/').join(pathSeparator);
    }

    /** Prefix test that respects the case-insensitive drive letters of Windows. */
    function hasPrefix(value, prefix) {
      if (typeof value !== 'string' || typeof prefix !== 'string' || prefix.length === 0) return false;
      if (pathSeparator !== '\\') return value.startsWith(prefix);
      return value.toLowerCase().startsWith(prefix.toLowerCase());
    }

    /**
     * Pure string normalisation of a path: collapses `.`, `..` and repeated
     * separators without touching the filesystem. Chat links arrive as
     * `<cwd>/./src/app.js`, `<cwd>/../<cwd>/src/app.js` or a bare basename; two
     * spellings of one file must never become two tabs.
     */
    function lexicalNormalize(path) {
      if (typeof path !== 'string' || path.length === 0) return path;
      const drives = /^[a-zA-Z]:[/\\]/.test(path);
      const absolute = path.startsWith('/') || drives;
      const parts = path.split(/[/\\]+/);
      const out = [];
      for (const part of parts) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
          if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
          else if (absolute !== true) out.push('..');
          continue;
        }
        out.push(part);
      }
      const joined = out.join(drives ? '\\' : '/');
      if (drives) return joined;
      return absolute ? `/${joined}` : joined;
    }

    /** Every spelling a tab answers to, for identity comparisons. */
    function spellingsOf(key, path) {
      const set = new Set();
      for (const value of [key, path]) {
        if (typeof value !== 'string' || value.length === 0) continue;
        set.add(value);
        set.add(lexicalNormalize(value));
      }
      return set;
    }

    function sameFilePath(left, right) {
      if (right === null || right === undefined) return false;
      const a = spellingsOf(left.key, left.path);
      const b = spellingsOf(right.key, right.path);
      for (const value of b) {
        if (a.has(value)) return true;
      }
      return false;
    }

    function findTabById(state, id) {
      if (id === null || id === undefined) return null;
      return state.tabs.find((tab) => tab.id === id) ?? null;
    }

    function newTabState(path, relativePath, name) {
      tabSeq += 1;
      return {
        // `id` is the tab's stable handle: async work resolves against it, never
        // against a path string that a later resolution can respell under it.
        id: `tab-${tabSeq}`,
        loadSeq: 0,
        // Tab identity: the canonical spelling when the host reports one, so a
        // path reached through a search hit and through the tree shares a tab.
        key: path,
        path,
        relativePath,
        name,
        file: null,
        lines: [],
        error: null,
        loading: false,
        view: 'code',
        diff: null,
        diffError: null,
        loadingDiff: false,
        diffMode: 'inline',
        diffModeUserSet: false,
        editor: null,
        stale: false,
        savedAt: null,
        selected: { start: null, end: null },
        pendingRevert: null,
        reverted: {},
        // Link resolution: the path a chat link named, what it resolved to, and
        // the pick list when the name alone is ambiguous.
        requestedPath: null,
        // File details stay out of the way until asked for: a compact ⓘ button
        // sits where the strip would be, and the choice is per tab.
        showMeta: false
      };
    }

    function newSessionState(sessionId) {
      return {
        id: sessionId,
        cwd: null,
        tab: 'preview',
        tabs: [],
        active: 0,
        // A link that is still being resolved: the panel shows exactly which
        // path was clicked while the host works out what it points at.
        pending: null,
        // The last path that was refused because it is not on disk. Nothing is
        // opened for it; the notice explains what was rejected and where.
        notice: null,
        events: [],
        tree: {},
        expanded: {},
        loadingTree: {},
        changes: null,
        loadingChanges: false,
        palette: { open: false, kind: 'files', query: '', results: [], loading: false, index: 0 },
        review: {},
        notes: [],
        find: { open: false, query: '', hits: [], index: 0 }
      };
    }

    function sessionState(sessionId) {
      let state = sessionStates.get(sessionId);
      if (state === undefined) {
        state = newSessionState(sessionId);
        sessionStates.set(sessionId, state);
      }
      return state;
    }

    /** Mutate one session's state and repaint every open panel. Returns whatever
     *  the callback returns, so a caller can learn the id of the tab it created. */
    function mutate(sessionId, apply_) {
      if (sessionId === null || sessionId === undefined) return undefined;
      const result = apply_(sessionState(sessionId));
      notify();
      return result;
    }

    /** Everything the panel can see about the window it is running in. */
    function diagSnapshot(reason) {
      const root = document.querySelector('.dfp-root');
      const frame = document.querySelector('[data-shell-overlay]')?.parentElement ?? null;
      const center = document.querySelector('[class*="centerCol"]');
      const details = document.querySelector('[class*="detailsCol"]');
      const box = (el) => {
        if (el === null) return null;
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) };
      };
      return {
        reason,
        build: CLIENT_BUILD,
        at: new Date().toISOString(),
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio },
        columns: frame === null ? null : [...frame.children].map((child) => Math.round(child.getBoundingClientRect().width)),
        detailsColumn: box(details),
        centerColumn: box(center),
        centerPadding: center === null ? null : getComputedStyle(center).paddingRight,
        mode: runtime.mode,
        visible: runtime.visible,
        owner: runtime.owner,
        docked: document.body.getAttribute('data-dfp-docked'),
        dockWidth: runtime.dockWidth,
        panel: box(root),
        panelDock: root === null ? null : root.getAttribute('data-dock'),
        tabs: runtime.owner === null ? null : (sessionStates.get(runtime.owner)?.tabs?.length ?? 0),
        toggle: document.getElementById('dfp-toggle') === null ? null : document.getElementById('dfp-toggle').textContent
      };
    }

    /**
     * A second, restart-free channel: the window title. Reading a window title
     * needs no devtools and no host route, so the panel can always say what it
     * is doing — which build, which mode, how wide, how much it inset the chat.
     */
    function reportTitle() {
      if (typeof document === 'undefined') return;
      const base = document.title.replace(/ \[dfp:[^\]]*\]$/, '');
      if (runtime.visible !== true) {
        if (document.title !== base) document.title = base;
        return;
      }
      const root = document.querySelector('.dfp-root');
      const center = document.querySelector('[class*="centerCol"]');
      const details = document.querySelector('[class*="detailsCol"]');
      const strip = [
        CLIENT_BUILD,
        runtime.mode,
        `w${root === null ? 0 : Math.round(root.getBoundingClientRect().width)}`,
        `x${root === null ? 0 : Math.round(root.getBoundingClientRect().x)}`,
        `pad${center === null ? '-' : getComputedStyle(center).paddingRight}`,
        `col${details === null ? '-' : Math.round(details.getBoundingClientRect().width)}`,
        `vw${window.innerWidth}`,
        document.body.getAttribute('data-dfp-docked') === null ? 'nodock' : 'docked'
      ].join(' ');
      document.title = `${base} [dfp:${strip}]`;
    }

    let lastDiagAt = 0;
    let diagTimer = null;

    /** Send a snapshot, throttled: diagnostics must never cost a frame. */
    function reportDiag(reason, force) {
      const now = Date.now();
      if (force !== true && now - lastDiagAt < 1500) return;
      lastDiagAt = now;
      if (diagTimer !== null) window.clearTimeout(diagTimer);
      diagTimer = window.setTimeout(() => {
        diagTimer = null;
        let snapshot = null;
        try {
          snapshot = diagSnapshot(reason);
        } catch {
          return;
        }
        void postHost('diag', snapshot).catch(() => {});
      }, 250);
    }

    /** Publish the docked state to the document so the layout can make room. */
    function syncDockLayout() {
      if (typeof document === 'undefined' || document.body === null) return;
      const owner = runtime.owner;
      const state = owner === null ? undefined : sessionStates.get(owner);
      const showing = runtime.visible === true
        && runtime.mode === 'overlay'
        && state !== undefined
        && (state.tabs.length > 0 || state.notice !== null || state.pending !== null || state.tab !== 'preview');
      if (showing === true) {
        const push = pushWidth();
        document.body.setAttribute('data-dfp-docked', '1');
        document.body.setAttribute('data-dfp-push', push > 0 ? '1' : '0');
        document.body.style.setProperty('--dfp-dock-width', `${clampDockWidth(runtime.dockWidth)}px`);
        document.body.style.setProperty('--dfp-push', `${push}px`);
      } else {
        document.body.removeAttribute('data-dfp-docked');
      }
    }

    function activeTab(state) {
      return state?.tabs?.[state.active] ?? null;
    }

    /**
     * Everything that ends up on screen can be traced: which path arrived, how
     * it was spelled, what it resolved to and where it landed. The ring buffer
     * is what makes a report like "sometimes nothing shows up" actionable.
     */
    function trace(state, kind, detail) {
      if (state === null || state === undefined) return;
      state.events.push({ at: Date.now(), kind, detail: detail ?? null });
      if (state.events.length > 120) state.events.splice(0, state.events.length - 120);
    }

    // ------------------------------------------------------------------
    // host API
    // ------------------------------------------------------------------

    const rawUrl = (path, cwd) => `/api/dsh-file-panel.raw?${query({ path, cwd })}`;

    function query(params) {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params ?? {})) {
        if (value === undefined || value === null || value === '') continue;
        search.set(key, String(value));
      }
      return search.toString();
    }

    async function callHost(route, params) {
      const response = await fetch(`/api/dsh-file-panel.${route}?${query(params)}`, { headers: { accept: 'application/json' } });
      const payload = await response.json().catch(() => null);
      if (payload === null) throw new Error(`${route}: malformed response (${response.status})`);
      if (payload.ok !== true) throw new Error(payload.error?.message ?? 'request failed');
      return payload.value;
    }

    async function postHost(route, body) {
      const response = await fetch(`/api/dsh-file-panel.${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      const payload = await response.json().catch(() => null);
      if (payload === null) throw new Error(`${route}: malformed response (${response.status})`);
      if (payload.ok !== true) {
        const error = new Error(payload.error?.message ?? 'request failed');
        error.code = payload.error?.code ?? 'error';
        throw error;
      }
      return payload.value;
    }

    // ------------------------------------------------------------------
    // styles
    // ------------------------------------------------------------------

    function ensureStyles() {
      if (document.getElementById(STYLE_ID) !== null) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.dataset.plugin = 'dsh-file-panel';
      style.textContent = `
.dfp-root { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary, inherit); font-size:13px; overflow:hidden; }
.dfp-header { display:flex; align-items:center; gap:6px; padding:8px 10px 6px; border-bottom:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); }
.dfp-headline { display:flex; flex-direction:column; min-width:0; flex:1; gap:2px; }
.dfp-name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dfp-sub { font-size:11px; color:var(--dsw-alias-label-secondary, rgba(128,128,128,.9)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dfp-path { display:flex; align-items:center; gap:4px; min-width:0; font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace; font-size:10.5px; color:var(--dsw-alias-label-secondary, rgba(128,128,128,.95)); cursor:copy; direction:rtl; text-align:left; }
.dfp-path:hover { color:var(--dsw-alias-label-primary, inherit); }
.dfp-path-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:ltr; }
.dfp-pending { display:flex; align-items:center; gap:8px; font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace; font-size:11px; }
.dfp-meta { border:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); border-radius:8px; padding:7px 9px; display:flex; flex-direction:column; gap:3px; font-size:11px; color:var(--dsw-alias-label-secondary, inherit); }
.dfp-meta-row { display:flex; gap:8px; align-items:baseline; }
.dfp-meta-key { flex:none; width:74px; opacity:.75; }
.dfp-meta-value { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace; }
.dfp-meta-value[data-copy="1"] { cursor:copy; }
.dfp-meta-value[data-copy="1"]:hover { color:var(--dsw-alias-label-primary, inherit); text-decoration:underline; }
.dfp-actions { display:flex; align-items:center; gap:2px; flex:none; }
.dfp-btn { appearance:none; border:none; background:transparent; color:var(--dsw-alias-label-secondary, inherit); border-radius:6px; padding:4px 7px; font:inherit; font-size:12px; cursor:pointer; line-height:16px; white-space:nowrap; }
.dfp-btn:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); color:var(--dsw-alias-label-primary, inherit); }
.dfp-btn:disabled { opacity:.45; cursor:default; }
.dfp-btn[data-primary="1"] { background:var(--dsw-alias-brand-primary,#4d6bfe); color:#fff; }
.dfp-btn[data-danger="1"]:hover { color:var(--dsw-alias-state-error-primary,#e5484d); }
.dfp-btn[data-active="1"] { background:var(--dsw-alias-bg-module-platform, rgba(128,128,128,.22)); color:var(--dsw-alias-label-primary, inherit); }
.dfp-tabs { display:flex; gap:2px; padding:6px 8px 0; border-bottom:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); overflow-x:auto; scrollbar-width:none; }
.dfp-tabs[data-kind="files"] { padding-top:2px; border-bottom:none; }
.dfp-tab { appearance:none; border:none; background:transparent; color:var(--dsw-alias-label-secondary, inherit); font:inherit; font-size:12px; padding:5px 9px; border-radius:6px 6px 0 0; cursor:pointer; white-space:nowrap; display:inline-flex; align-items:center; gap:5px; }
.dfp-tab[data-active="1"] { color:var(--dsw-alias-label-primary, inherit); background:var(--dsw-alias-bg-module-platform, rgba(128,128,128,.14)); }
.dfp-filetab { max-width:170px; }
.dfp-close { font-size:11px; opacity:.6; }
.dfp-close:hover { opacity:1; color:var(--dsw-alias-state-error-primary,#e5484d); }
.dfp-dot { width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-warn-primary,#f5a623); flex:none; }
.dfp-body { flex:1; min-height:0; overflow:auto; padding:8px 10px 12px; display:flex; flex-direction:column; gap:8px; }
.dfp-note { font-size:12px; color:var(--dsw-alias-label-secondary, inherit); background:var(--dsw-alias-bg-module-platform, rgba(128,128,128,.12)); border-radius:8px; padding:8px 10px; }
.dfp-note[data-tone="error"] { color:var(--dsw-alias-state-error-primary,#e5484d); }
.dfp-error-title { font-weight:600; margin-bottom:2px; }
.dfp-note[data-tone="warn"] { color:var(--dsw-alias-state-warn-primary,#f5a623); }
.dfp-stats { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--dsw-alias-label-secondary, inherit); flex-wrap:wrap; }
.dfp-add { color:var(--dsw-alias-state-success-primary,#30a46c); font-variant-numeric:tabular-nums; }
.dfp-del { color:var(--dsw-alias-state-error-primary,#e5484d); font-variant-numeric:tabular-nums; }
.dfp-badge { font-size:10px; padding:1px 6px; border-radius:999px; background:var(--dsw-alias-bg-module-platform, rgba(128,128,128,.2)); }
.dfp-row { display:flex; align-items:center; gap:6px; padding:3px 6px; border-radius:6px; cursor:pointer; font-size:12.5px; }
.dfp-row:hover { background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)); }
.dfp-row[data-current="1"] { background:var(--dsw-alias-bg-module-platform, rgba(128,128,128,.22)); }
.dfp-row[data-kind="directory"] { font-weight:500; }
.dfp-row-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dfp-icon { width:14px; text-align:center; color:var(--dsw-alias-label-secondary, inherit); }
.dfp-tree .dfp-row[data-depth="1"] { padding-left:18px; }
.dfp-tree .dfp-row[data-depth="2"] { padding-left:32px; }
.dfp-tree .dfp-row[data-depth="3"] { padding-left:46px; }
.dfp-tree .dfp-row[data-depth="4"] { padding-left:60px; }
.dfp-tree .dfp-row[data-depth="5"] { padding-left:74px; }
.dfp-tree .dfp-row[data-depth="6"] { padding-left:88px; }
.dfp-editor { display:flex; flex-direction:column; gap:8px; min-height:100%; }
.dfp-edit-body { display:flex; position:relative; border:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:8px; overflow:hidden; background:var(--dsw-alias-bg-base, rgba(0,0,0,.2)); min-height:320px; }
.dfp-gutter { flex:none; width:54px; overflow:hidden; padding:8px 0; background:var(--dsw-alias-bg-module-platform, rgba(128,128,128,.10)); border-right:.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.18)); font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace; font-size:12.5px; line-height:20px; text-align:right; user-select:none; }
.dfp-gutter-line { height:20px; padding-right:10px; color:var(--dsw-alias-label-caption, rgba(128,128,128,.75)); font-variant-numeric:tabular-nums; }
.dfp-gutter-line[data-active="1"] { color:var(--dsw-alias-label-primary, inherit); }
.dfp-edit-scroll { position:relative; flex:1; min-width:0; display:flex; }
.dfp-edit-band { position:absolute; left:0; right:0; height:20px; background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); pointer-events:none; }
.dfp-code-input { position:relative; flex:1; min-width:0; background:transparent; color:var(--dsw-alias-label-primary, inherit); border:none; outline:none; resize:none; padding:8px 10px; font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace; font-size:12.5px; line-height:20px; tab-size:2; white-space:pre; overflow:auto; }
.dfp-textarea { flex:1; min-height:320px; width:100%; resize:vertical; background:var(--dsw-alias-bg-base, rgba(0,0,0,.2)); color:var(--dsw-alias-label-primary, inherit); border:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:8px; padding:10px; font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace; font-size:12.5px; line-height:1.5; tab-size:2; }
.dfp-empty { display:flex; flex-direction:column; gap:6px; align-items:center; justify-content:center; text-align:center; color:var(--dsw-alias-label-secondary, inherit); padding:28px 12px; font-size:12.5px; }
.dfp-spin { display:inline-block; width:11px; height:11px; border:1.5px solid currentColor; border-right-color:transparent; border-radius:50%; animation:dfp-spin .7s linear infinite; }
@keyframes dfp-spin { to { transform:rotate(360deg); } }
.dfp-footer { padding:6px 12px; border-top:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); font-size:11px; color:var(--dsw-alias-label-secondary, inherit); display:flex; gap:10px; flex-wrap:wrap; align-items:center; }
.dfp-live { display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--dsw-alias-state-success-primary,#30a46c); }
.dfp-surface { position:relative; min-height:100%; }
.dfp-findbar { display:flex; align-items:center; gap:6px; padding:4px 6px; border:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); border-radius:8px; background:var(--dsw-alias-bg-module-platform, rgba(128,128,128,.12)); }
.dfp-input { flex:1; min-width:0; appearance:none; border:none; background:transparent; color:inherit; font:inherit; font-size:12px; outline:none; }
.dfp-hit { outline:1.5px solid var(--dsw-alias-state-warn-primary,#f5a623); outline-offset:-1px; border-radius:3px; }
.dfp-hit-active { outline-color:var(--dsw-alias-brand-primary,#4d6bfe) !important; background:rgba(77,107,254,.14); }
.dfp-sel { background:rgba(77,107,254,.18); }
.dfp-palette { display:flex; flex-direction:column; gap:6px; }
.dfp-palette-list { display:flex; flex-direction:column; gap:1px; max-height:320px; overflow:auto; }
.dfp-palette-item { display:flex; gap:8px; align-items:baseline; padding:5px 8px; border-radius:6px; cursor:pointer; font-size:12.5px; }
.dfp-palette-item[data-active="1"] { background:var(--dsw-alias-bg-module-platform, rgba(128,128,128,.24)); }
.dfp-palette-path { color:var(--dsw-alias-label-secondary, inherit); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* Diff palette — tuned to read like the IDE diff editors (dark first, light fallback). */
.dfp-root {
  --dfp-add-bg: rgba(46,160,67,.18);
  --dfp-add-bg-strong: rgba(46,160,67,.32);
  --dfp-add-word: rgba(46,160,67,.52);
  --dfp-add-bar: #3fb950;
  --dfp-del-bg: rgba(248,81,73,.18);
  --dfp-del-bg-strong: rgba(248,81,73,.32);
  --dfp-del-word: rgba(248,81,73,.52);
  --dfp-del-bar: #f85149;
  --dfp-num: rgba(128,128,128,.75);
  --dfp-num-add: #3fb950;
  --dfp-num-del: #f85149;
  --dfp-empty: repeating-linear-gradient(135deg, rgba(128,128,128,.16) 0 4px, transparent 4px 9px);
  --dfp-head-bg: rgba(110,118,129,.16);
  --dfp-hover: rgba(110,118,129,.12);
}
body[data-ds-dark-theme] .dfp-root {
  --dfp-add-bg: rgba(46,160,67,.22);
  --dfp-add-bg-strong: rgba(46,160,67,.38);
  --dfp-add-word: rgba(63,185,80,.50);
  --dfp-del-bg: rgba(248,81,73,.20);
  --dfp-del-bg-strong: rgba(248,81,73,.38);
  --dfp-del-word: rgba(248,81,73,.48);
  --dfp-empty: repeating-linear-gradient(135deg, rgba(110,118,129,.22) 0 4px, transparent 4px 9px);
  --dfp-head-bg: rgba(110,118,129,.18);
}
.dfp-diff { display:flex; flex-direction:column; gap:8px; font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,monospace; font-size:11.5px; }
.dfp-diff-group { border:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); border-radius:8px; overflow:hidden; background:var(--dsw-alias-bg-layer-1, transparent); }
.dfp-diff-head { display:flex; align-items:center; gap:6px; padding:2px 6px; font-size:10px; color:var(--dsw-alias-label-secondary, inherit); background:var(--dfp-head-bg); border-bottom:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2)); font-family:inherit; white-space:nowrap; overflow:hidden; }
.dfp-diff-head .dfp-mono { overflow:hidden; text-overflow:ellipsis; }
.dfp-diff-head .dfp-btn { padding:1px 5px; font-size:11px; line-height:14px; }
.dfp-diff-head .dfp-mono { color:var(--dsw-alias-label-tertiary, rgba(128,128,128,.9)); }
.dfp-diff-body { display:flex; flex-direction:column; }
.dfp-dline { display:grid; align-items:stretch; line-height:1.6; }
.dfp-dline[data-mode="inline"] { grid-template-columns:14px 38px 38px 1fr; }
.dfp-dline[data-mode="split"] { grid-template-columns:14px 38px 1fr; }
.dfp-num { text-align:right; padding:0 6px 0 4px; color:var(--dfp-num); user-select:none; background:rgba(128,128,128,.05); font-variant-numeric:tabular-nums; }
.dfp-sign { text-align:center; color:var(--dfp-num); user-select:none; }
.dfp-code { white-space:pre-wrap; word-break:break-word; padding-right:8px; min-width:0; }
.dfp-dline[data-kind="del"] { background:var(--dfp-del-bg); box-shadow:inset 3px 0 0 var(--dfp-del-bar); }
.dfp-dline[data-kind="del"] > .dfp-num { color:var(--dfp-num-del); background:var(--dfp-del-bg-strong); }
.dfp-dline[data-kind="add"] { background:var(--dfp-add-bg); box-shadow:inset 3px 0 0 var(--dfp-add-bar); }
.dfp-dline[data-kind="add"] > .dfp-num { color:var(--dfp-num-add); background:var(--dfp-add-bg-strong); }
.dfp-dline[data-kind="empty"] { background:var(--dfp-empty); }
.dfp-dline[data-kind="empty"] > .dfp-num { background:transparent; }
.dfp-dline[data-kind="context"]:hover, .dfp-dline[data-kind="add"]:hover, .dfp-dline[data-kind="del"]:hover { background-image:linear-gradient(var(--dfp-hover), var(--dfp-hover)); }
.dfp-dword { border-radius:2px; padding:0 1px; }
.dfp-dline[data-kind="del"] .dfp-dword { background:var(--dfp-del-word); }
.dfp-dline[data-kind="add"] .dfp-dword { background:var(--dfp-add-word); }
.dfp-dcollapse { display:flex; align-items:center; gap:8px; padding:2px 8px; font-size:10.5px; color:var(--dsw-alias-label-secondary, inherit); background:var(--dfp-head-bg); cursor:pointer; font-family:inherit; }
.dfp-dcollapse:hover { color:var(--dsw-alias-label-primary, inherit); }
.dfp-hunk-nav { display:flex; align-items:center; gap:4px; margin-left:auto; }
.dfp-diff-split { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:6px; }
.dfp-diff-split .dfp-code { font-size:11px; }
.dfp-diff-split .dfp-diff-group { min-width:0; }
.dfp-split-marker { background:var(--dfp-head-bg); }
.dfp-hunk { border:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); border-radius:8px; padding:6px 8px; display:flex; flex-direction:column; gap:4px; }
.dfp-hunk-head { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--dsw-alias-label-secondary, inherit); }
.dfp-sep { height:1px; background:var(--dsw-alias-border-l2, rgba(128,128,128,.2)); margin:2px 0; }
/* Docked variant: used when the layout resolves the details column to 0
   (its centre column demands 640px, so narrow windows have no room). */
.dfp-root[data-dock="true"] { box-sizing:border-box; position:fixed; top:0; right:0; bottom:0; z-index:40; width:var(--dfp-dock-width, 420px); background:var(--dsw-alias-bg-layer-2, #1a1b20); border-left:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); box-shadow:-10px 0 28px rgba(0,0,0,.32); padding:6px 8px 0; pointer-events:auto; }
/* Docked panel: inset the layout's centre column by the panel's width so the
   conversation is narrowed, never covered. DSH keeps the details column at 0px
   unless it has a details target of its own, so a plugin cannot use that column
   — this is the closest honest equivalent. */
body[data-dfp-docked="1"] [class*="centerCol"] { padding-right: var(--dfp-push, 0px); }
body[data-dfp-docked="1"] [class*="handle"] { display: none; }
/* The way back in: a slim tab on the right edge, the only thing the plugin
   draws while the panel is closed. */
.dfp-toggle { position:fixed; right:0; top:50%; transform:translateY(-50%); z-index:39; appearance:none; border:.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.35)); border-right:none; border-radius:8px 0 0 8px; background:var(--dsw-alias-bg-module-platform, rgba(30,30,34,.85)); color:var(--dsw-alias-label-secondary, inherit); font:inherit; font-size:11px; line-height:1; padding:10px 5px; cursor:pointer; writing-mode:vertical-rl; opacity:.45; transition:opacity .15s; }
.dfp-toggle:hover { opacity:1; color:var(--dsw-alias-label-primary, inherit); }
/* While the panel is open the tab rides its leading edge, so it closes it
   instead of hiding behind it. */
body[data-dfp-docked="1"] .dfp-toggle { right: var(--dfp-dock-width, 420px); opacity:.8; }
body[data-dfp-docked="0"] .dfp-toggle { right: 0; }
.dfp-dock-handle { position:absolute; left:-4px; top:0; bottom:0; width:8px; z-index:2; cursor:col-resize; background:transparent; touch-action:none; pointer-events:auto; border-radius:4px; }
.dfp-root[data-dock="true"] { overflow:visible; }
.dfp-dock-handle:hover { background:var(--dsw-alias-brand-primary,#4d6bfe); opacity:.4; }
`
      document.head.appendChild(style);
    }

    // ------------------------------------------------------------------
    // helpers
    // ------------------------------------------------------------------

    function basename(value) {
      if (typeof value !== 'string' || value.length === 0) return '';
      const parts = value.replace(/[/\\]+$/, '').split(/[/\\]/);
      return parts[parts.length - 1] || value;
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
    }

    function formatAge(value) {
      if (typeof value !== 'number' || value <= 0) return '';
      const delta = Date.now() - value;
      if (delta < 8_000) return 'live';
      if (delta < 60_000) return 'just now';
      if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
      if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
      return new Date(value).toLocaleString();
    }

    function linesOf(content) {
      if (typeof content !== 'string' || content.length === 0) return [];
      const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
      return trimmed.split('\n');
    }

    function viewFor(file) {
      if (file === null || file === undefined) return 'code';
      const lower = String(file.path ?? '').toLowerCase();
      if (file.binary === true) {
        return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension)) ? 'image' : 'binary';
      }
      if (lower.endsWith('.md') || lower.endsWith('.mdx')) return 'markdown';
      return 'code';
    }

    const changeCount = (state) => state?.changes?.files?.length ?? 0;

    /** Unified patch text for a hunk set (clipboard handoff). */
    function patchText(relativePath, hunks, content) {
      const rows = [`--- a/${relativePath}`, `+++ b/${relativePath}`];
      for (const hunk of hunks) {
        const newText = hunk.newText ?? '';
        const anchor = typeof content === 'string' && newText.length > 0 ? content.indexOf(newText.slice(0, 40)) : -1;
        const line = anchor === -1 || typeof content !== 'string' ? 1 : (content.slice(0, anchor).match(/\n/g) ?? []).length + 1;
        rows.push(`@@ -${line} +${line} @@`);
        if (typeof hunk.oldText === 'string') for (const text of linesOf(hunk.oldText)) rows.push(`-${text}`);
        for (const text of linesOf(newText)) rows.push(`+${text}`);
      }
      return rows.join('\n');
    }

    function copyText(text) {
      if (primitives?.writeClipboard !== undefined) return primitives.writeClipboard(text);
      return navigator.clipboard?.writeText(text).then(() => true).catch(() => false);
    }

    // ------------------------------------------------------------------
    // diff engine — aligned rows, word emphasis, collapsed context
    // ------------------------------------------------------------------

    const WORD_SPLIT = /(\s+|[^\w\s]+)/;

    function wordSegments(oldText, newText) {
      const left = String(oldText ?? '').split(WORD_SPLIT);
      const right = String(newText ?? '').split(WORD_SPLIT);
      let prefix = 0;
      while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
      let suffix = 0;
      while (
        suffix < left.length - prefix &&
        suffix < right.length - prefix &&
        left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
      ) suffix += 1;
      const mid = (words) => words.slice(prefix, words.length - suffix).join('');
      return {
        old: { before: left.slice(0, prefix).join(''), changed: mid(left), after: left.slice(left.length - suffix).join('') },
        new: { before: right.slice(0, prefix).join(''), changed: mid(right), after: right.slice(right.length - suffix).join('') }
      };
    }

    /** LCS alignment of two line arrays → ops; falls back to block replace on huge inputs. */
    function alignLines(oldLines, newLines) {
      const n = oldLines.length;
      const m = newLines.length;
      if (n === 0) return newLines.map((_, index) => ({ kind: 'add', newIndex: index }));
      if (m === 0) return oldLines.map((_, index) => ({ kind: 'del', oldIndex: index }));
      if (n * m > 40_000) {
        return [
          ...oldLines.map((_, index) => ({ kind: 'del', oldIndex: index })),
          ...newLines.map((_, index) => ({ kind: 'add', newIndex: index }))
        ];
      }
      const table = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          table[i][j] = oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
      }
      const ops = [];
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (oldLines[i] === newLines[j]) {
          ops.push({ kind: 'same', oldIndex: i, newIndex: j });
          i += 1;
          j += 1;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
          ops.push({ kind: 'del', oldIndex: i });
          i += 1;
        } else {
          ops.push({ kind: 'add', newIndex: j });
          j += 1;
        }
      }
      while (i < n) { ops.push({ kind: 'del', oldIndex: i }); i += 1; }
      while (j < m) { ops.push({ kind: 'add', newIndex: j }); j += 1; }
      return ops;
    }

    /** Where this hunk sits in the current file, so headers can print real line numbers. */
    function hunkStartLine(hunk, content) {
      if (typeof content !== 'string' || content.length === 0) return 1;
      const anchor = typeof hunk.newText === 'string' && hunk.newText.length > 0
        ? hunk.newText.slice(0, 60)
        : (typeof hunk.oldText === 'string' ? hunk.oldText.slice(0, 60) : '');
      if (anchor.length === 0) return 1;
      const at = content.indexOf(anchor);
      if (at === -1) return 1;
      return (content.slice(0, at).match(/\n/g) ?? []).length + 1;
    }

    /**
     * Rows for one hunk: aligned pairs, word emphasis on change blocks, and the
     * per-side line numbers the two diff modes print in their gutters.
     */
    function hunkRows(hunk, baseLine) {
      const oldLines = hunk.oldText === null || hunk.oldText === undefined ? [] : linesOf(hunk.oldText);
      const newLines = linesOf(hunk.newText ?? '');
      const ops = alignLines(oldLines, newLines);
      const rows = [];
      let oldNumber = baseLine;
      let newNumber = baseLine;
      let index = 0;
      while (index < ops.length) {
        const op = ops[index];
        if (op.kind === 'same') {
          rows.push({ kind: 'context', oldNumber: oldNumber++, newNumber: newNumber++, text: oldLines[op.oldIndex] });
          index += 1;
          continue;
        }
        const dels = [];
        const adds = [];
        while (index < ops.length && ops[index].kind === 'del') { dels.push(ops[index].oldIndex); index += 1; }
        while (index < ops.length && ops[index].kind === 'add') { adds.push(ops[index].newIndex); index += 1; }
        if (index < ops.length && ops[index].kind === 'same' && dels.length > 0 && adds.length > 0) {
          // a del/add pair with something in common is a change block
        }
        const pairs = Math.max(dels.length, adds.length);
        for (let offset = 0; offset < pairs; offset += 1) {
          const hasOld = offset < dels.length;
          const hasNew = offset < adds.length;
          if (hasOld && hasNew) {
            const left = oldLines[dels[offset]];
            const right = newLines[adds[offset]];
            const words = left === right ? null : wordSegments(left, right);
            rows.push({
              kind: 'change',
              oldNumber: oldNumber++,
              newNumber: newNumber++,
              oldText: left,
              newText: right,
              words
            });
          } else if (hasOld) {
            rows.push({ kind: 'del', oldNumber: oldNumber++, text: oldLines[dels[offset]] });
          } else {
            rows.push({ kind: 'add', newNumber: newNumber++, text: newLines[adds[offset]] });
          }
        }
      }
      return rows;
    }

    /** Collapse long unchanged runs inside a hunk (context keys are per hunk + run). */
    function collapseRows(rows, hunkIndex, expanded, onToggle) {
      if (expanded.has(`${hunkIndex}:all`)) return rows;
      const output = [];
      let run = [];
      const flush = () => {
        if (run.length === 0) return;
        if (run.length <= 6) {
          output.push(...run);
        } else {
          const key = `${hunkIndex}:${run[0].oldNumber ?? run[0].newNumber}`;
          if (expanded.has(key)) {
            output.push(...run);
          } else {
            output.push(...run.slice(0, 3));
            output.push({ kind: 'collapse', key, count: run.length - 6, onToggle });
            output.push(...run.slice(-3));
          }
        }
        run = [];
      };
      for (const row of rows) {
        if (row.kind === 'context') run.push(row);
        else {
          flush();
          output.push(row);
        }
      }
      flush();
      return output;
    }

    function LineRow({ mode, row, side }) {
      if (row.kind === 'collapse') {
        return React.createElement('div', { className: 'dfp-dcollapse', onClick: row.onToggle },
          React.createElement('span', null, '⋯'),
          React.createElement('span', null, `${row.count} unchanged lines — click to expand`));
      }
      const segments = row.words ?? null;
      let body = null;
      if (segments === null || row.kind === 'context') {
        body = row.text ?? row.newText ?? '';
      } else {
        const part = side === 'old' ? segments.old : segments.new;
        body = part.changed === '' ? (side === 'old' ? row.oldText : row.newText) : [
          part.before,
          React.createElement('span', { key: 'w', className: 'dfp-dword' }, part.changed),
          part.after
        ];
      }
      const kind = row.kind === 'change' ? (side === 'old' ? 'del' : 'add') : row.kind;
      const number = side === 'old' ? row.oldNumber : row.newNumber;
      const sign = kind === 'del' ? '−' : kind === 'add' ? '+' : '';
      const children = [React.createElement('span', { key: 's', className: 'dfp-sign' }, sign)];
      if (mode === 'inline') {
        children.push(React.createElement('span', { key: 'on', className: 'dfp-num' }, row.oldNumber ?? ''));
        children.push(React.createElement('span', { key: 'nn', className: 'dfp-num' }, row.newNumber ?? ''));
      } else {
        children.push(React.createElement('span', { key: 'n', className: 'dfp-num' }, number ?? ''));
      }
      children.push(React.createElement('span', { key: 'c', className: 'dfp-code' }, body));
      return React.createElement('div', {
        className: 'dfp-dline',
        'data-kind': kind,
        'data-mode': mode,
        'data-side': side
      }, children);
    }

    const viewMode = (mode) => (mode === 1 ? 'inline' : 'split');

    /** Non-context rows belonging to the opposite side render as hatched fillers. */
    function fillerRow(mode, key) {
      return React.createElement('div', { key, className: 'dfp-dline', 'data-kind': 'empty', 'data-mode': mode, 'data-side': 'filler' },
        React.createElement('span', { className: 'dfp-sign' }, ''),
        React.createElement('span', { className: 'dfp-num' }, ''),
        mode === 'inline' ? React.createElement('span', { className: 'dfp-num' }, '') : null,
        React.createElement('span', { className: 'dfp-code' }));
    }

    /** Stable identity for one recorded hunk, used to remember local reverts. */
    function hunkSignature(hunk) {
      return `${String(hunk.newText ?? '').length}:${String(hunk.oldText ?? '').length}:${String(hunk.newText ?? '').slice(0, 24)}`;
    }

    function HunkHeader({ hunk, index, stats, tab, sessionId, onJump, readOnly }) {
      const confirming = tab.pendingRevert === index;
      const reverted = tab.reverted?.[hunkSignature(hunk)] === true;
      const base = stats.base ?? 1;
      const oldCount = hunk.oldText === null || hunk.oldText === undefined ? 0 : linesOf(hunk.oldText).length;
      const newCount = linesOf(hunk.newText ?? '').length;
      return React.createElement('div', { className: 'dfp-diff-head' },
        React.createElement('span', { className: 'dfp-mono' }, `@@ -${base},${oldCount} +${base},${newCount} @@`),
        React.createElement('span', { className: 'dfp-add' }, `+${stats.added}`),
        React.createElement('span', { className: 'dfp-del' }, `−${stats.removed}`),
        typeof hunk.time === 'number' ? React.createElement('span', { className: 'dfp-mono' }, formatAge(hunk.time)) : null,
        reverted ? React.createElement('span', { className: 'dfp-badge' }, 'reverted ✓') : null,
        React.createElement('span', { className: 'dfp-hunk-nav' },
          React.createElement('button', { type: 'button', className: 'dfp-btn', title: 'Jump to this hunk', onClick: () => onJump?.(index) }, '⌖'),
          readOnly === true
            ? null
            : reverted
            ? React.createElement('span', { className: 'dfp-sub' }, 'undone on disk')
            : confirming
              ? React.createElement(React.Fragment, null,
                React.createElement('button', { type: 'button', className: 'dfp-btn', 'data-danger': '1', title: 'Confirm the revert', onClick: () => void revertHunk(sessionId, index) }, '✓ undo'),
                React.createElement('button', { type: 'button', className: 'dfp-btn', title: 'Cancel', onClick: () => mutate(sessionId, (state) => { const target = activeTab(state); if (target !== null) target.pendingRevert = null }) }, '✗'))
              : React.createElement('button', {
                type: 'button',
                className: 'dfp-btn',
                'data-danger': '1',
                title: 'Revert this hunk on disk',
                onClick: () => mutate(sessionId, (state) => { const target = activeTab(state); if (target !== null) target.pendingRevert = index })
              }, '↺')));
    }

    /**
     * The one diff renderer both modes share: hunk headers with real line ranges,
     * aligned rows, coloured gutters, change bars and collapsible context.
     */
    function DiffView({ tab, sessionId, mode, readOnly }) {
      const [expanded, setExpanded] = React.useState(() => new Set());
      const [width, setWidth] = React.useState(0);
      const hostRef = React.useRef(null);
      React.useEffect(() => {
        const host = hostRef.current;
        if (host === null) return;
        const measure = () => setWidth(host.getBoundingClientRect().width);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(host);
        return () => observer.disconnect();
      }, []);
      const hunks = tab.diff?.hunks ?? [];
      const content = tab.file?.content ?? '';
      if (hunks.length === 0) return null;
      const toggle = (key) => setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
      const groups = hunks.map((hunk, index) => {
        const base = hunkStartLine(hunk, content);
        const rows = hunkRows(hunk, base);
        const added = rows.filter((row) => row.kind === 'add' || (row.kind === 'change')).length;
        const removed = rows.filter((row) => row.kind === 'del' || (row.kind === 'change')).length;
        return { hunk, index, base, rows, stats: { added, removed, base } };
      });
      const jump = (index) => {
        const host = hostRef.current;
        if (host === null) return;
        const target = host.querySelector(`[data-hunk="${index}"]`);
        target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        target?.animate?.([{ opacity: .55 }, { opacity: 1 }], { duration: 320 });
      };
      const renderRows = (group) => {
        const rows = collapseRows(group.rows, group.index, expanded, () => toggle(`all:${group.index}`));
        if (mode === 'inline') {
          // A changed line is one row per side, the way a patch reads.
          const inlineRows = [];
          rows.forEach((row, rowIndex) => {
            if (row.kind === 'change') {
              inlineRows.push(React.createElement(LineRow, { key: `d${rowIndex}`, mode: 'inline', row, side: 'old' }));
              inlineRows.push(React.createElement(LineRow, { key: `a${rowIndex}`, mode: 'inline', row, side: 'new' }));
            } else {
              inlineRows.push(React.createElement(LineRow, { key: `s${rowIndex}`, mode: 'inline', row, side: row.kind === 'del' ? 'old' : 'new' }));
            }
          });
          return inlineRows;
        }
        const left = [];
        const right = [];
        for (const [rowIndex, row] of rows.entries()) {
          if (row.kind === 'context') {
            left.push(React.createElement(LineRow, { key: `l${rowIndex}`, mode: 'split', row, side: 'old' }));
            right.push(React.createElement(LineRow, { key: `r${rowIndex}`, mode: 'split', row, side: 'new' }));
          } else if (row.kind === 'change') {
            left.push(React.createElement(LineRow, { key: `l${rowIndex}`, mode: 'split', row, side: 'old' }));
            right.push(React.createElement(LineRow, { key: `r${rowIndex}`, mode: 'split', row, side: 'new' }));
          } else if (row.kind === 'del') {
            left.push(React.createElement(LineRow, { key: `l${rowIndex}`, mode: 'split', row, side: 'old' }));
            right.push(fillerRow('split', `rf${rowIndex}`));
          } else if (row.kind === 'add') {
            left.push(fillerRow('split', `lf${rowIndex}`));
            right.push(React.createElement(LineRow, { key: `r${rowIndex}`, mode: 'split', row, side: 'new' }));
          } else {
            const node = React.createElement('div', { key: `c${rowIndex}`, className: 'dfp-dcollapse', onClick: row.onToggle },
              React.createElement('span', null, '⋯'),
              React.createElement('span', null, `${row.count} unchanged lines`));
            left.push(node);
            right.push(React.createElement('div', { key: `cr${rowIndex}`, className: 'dfp-dcollapse dfp-split-marker' }));
          }
        }
        return React.createElement('div', { className: 'dfp-diff-split' },
          React.createElement('div', null,
            React.createElement('div', { className: 'dfp-diff-head' },
              React.createElement('span', null, 'Before'),
              React.createElement('span', { className: 'dfp-hunk-nav' }, React.createElement('span', { className: 'dfp-del' }, `−${group.stats.removed}`))),
            React.createElement('div', { className: 'dfp-diff-body' }, left)),
          React.createElement('div', null,
            React.createElement('div', { className: 'dfp-diff-head' },
              React.createElement('span', null, 'After'),
              React.createElement('span', { className: 'dfp-hunk-nav' }, React.createElement('span', { className: 'dfp-add' }, `+${group.stats.added}`))),
            React.createElement('div', { className: 'dfp-diff-body' }, right)));
      };
      return React.createElement('div', { className: 'dfp-diff', ref: hostRef },
        mode === 'split' && width > 0 && width < 430
          ? React.createElement('div', { className: 'dfp-note' }, 'Drag the panel edge wider for a roomier side-by-side view — or switch back to Inline.')
          : null,
        groups.map((group) => React.createElement('div', { key: group.index, className: 'dfp-diff-group', 'data-hunk': String(group.index) },
          React.createElement(HunkHeader, { hunk: group.hunk, index: group.index, stats: group.stats, tab, sessionId, onJump: jump, readOnly }),
          React.createElement('div', { className: 'dfp-diff-body' }, renderRows(group)))));
    }

    function ChangesSurface({ state, tab, sessionId }) {
      if (tab === null) return React.createElement('div', { className: 'dfp-empty' }, 'Open a file to see its changes.');
      if (tab.loadingDiff === true && tab.diff === null) {
        return React.createElement('div', { className: 'dfp-row' }, React.createElement('span', { className: 'dfp-spin' }), 'Scanning session…');
      }
      if (tab.diffError !== null) return React.createElement('div', { className: 'dfp-note', 'data-tone': 'error' }, tab.diffError);
      if (tab.diff === null) return React.createElement('div', { className: 'dfp-empty' }, 'No diff loaded yet.');
      if (tab.diff.hunks.length === 0) {
        return React.createElement('div', { className: 'dfp-empty' },
          React.createElement('div', null, 'No recorded change for this file.'),
          React.createElement('div', { className: 'dfp-sub' },
            tab.diff.git?.available === true ? 'git reports a clean worktree for this path.' : 'Not a git repository — session edits only.'));
      }
      const totals = primitives?.diffTotals !== undefined ? primitives.diffTotals(tab.diff.hunks) : { added: tab.diff.added, removed: tab.diff.removed };
      const source = tab.diff.source === 'git' ? 'git diff vs HEAD' : 'session edits';
      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dfp-stats' },
          React.createElement('span', { className: 'dfp-add' }, `+${totals.added}`),
          React.createElement('span', { className: 'dfp-del' }, `−${totals.removed}`),
          React.createElement('span', { className: 'dfp-badge' }, source),
          tab.diff.sessionLive === true ? React.createElement('span', { className: 'dfp-badge' }, 'live') : null,
          tab.diff.git?.branch ? React.createElement('span', { className: 'dfp-badge' }, tab.diff.git.branch) : null,
          React.createElement('span', { style: { marginLeft: 'auto', display: 'flex', gap: '4px' } },
            React.createElement('button', {
              type: 'button', className: 'dfp-btn', 'data-active': tab.diffMode === 'inline' ? '1' : undefined,
              onClick: () => mutate(sessionId, (s) => { const target = activeTab(s); if (target !== null) { target.diffMode = 'inline'; target.diffModeUserSet = true } })
            }, 'Inline'),
            React.createElement('button', {
              type: 'button', className: 'dfp-btn', 'data-active': tab.diffMode === 'split' ? '1' : undefined,
              onClick: () => mutate(sessionId, (s) => { const target = activeTab(s); if (target !== null) { target.diffMode = 'split'; target.diffModeUserSet = true } })
            }, 'Side by side'),
            React.createElement('button', {
              type: 'button', className: 'dfp-btn', title: 'Copy the unified patch',
              onClick: () => void copyText(patchText(tab.relativePath ?? tab.path, tab.diff.hunks, tab.file?.content ?? ''))
            }, 'Copy patch'),
            React.createElement('button', {
              type: 'button', className: 'dfp-btn', 'data-danger': '1', disabled: tab.file === null,
              title: 'Undo every recorded hunk in this file',
              onClick: () => void revertAllForPath(sessionId, tab.path)
            }, 'Revert file'))),
        React.createElement('div', {
          className: 'dfp-path',
          title: `${tab.path}\n\nClick to copy`,
          onClick: () => void copyText(tab.path)
        }, React.createElement('span', { className: 'dfp-path-text' }, tab.path)),
        tab.diff.sessionScanTruncated === true
          ? React.createElement('div', { className: 'dfp-note', 'data-tone': 'warn' }, 'Large session log: only the newest part was scanned.')
          : null,
        React.createElement(DiffView, { tab, sessionId, mode: tab.diffMode === 'split' ? 'split' : 'inline' }),
        React.createElement('div', { className: 'dfp-stats' },
          React.createElement('span', null, `${tab.diff.hunks.length} hunk${tab.diff.hunks.length === 1 ? '' : 's'}`),
          Object.keys(tab.reverted ?? {}).length > 0 ? React.createElement('span', { className: 'dfp-badge' }, `${Object.keys(tab.reverted).length} reverted ✓`) : null,
          tab.diff.sessionSource ? React.createElement('span', null, `source: ${tab.diff.sessionSource}`) : null));
    }

    function CodeSurface({ state, tab, sessionId }) {
      const hostRef = React.useRef(null);
      const lines = tab.lines ?? [];
      React.useEffect(() => {
        const host = hostRef.current;
        if (host === null) return;
        const rows = [...host.querySelectorAll('[class*="_line"]')];
        rows.forEach((row, index) => {
          row.classList.toggle('dfp-sel', tab.selected.start !== null && index + 1 >= tab.selected.start && index + 1 <= (tab.selected.end ?? tab.selected.start));
          row.classList.toggle('dfp-hit', state.find.hits.includes(index + 1));
          row.classList.toggle('dfp-hit-active', state.find.hits[state.find.index] === index + 1);
        });
        const target = state.find.hits[state.find.index];
        if (typeof target === 'number') {
          const row = rows[target - 1];
          if (row !== undefined) row.scrollIntoView({ block: 'center' });
        }
      }, [state.find.hits, state.find.index, tab.selected.start, tab.selected.end, tab.path, tab.file?.sha256]);
      const onClick = (event) => {
        const host = hostRef.current;
        if (host === null) return;
        const row = event.target.closest?.('[class*="_line"]');
        if (row === null || row === undefined) return;
        const index = [...host.querySelectorAll('[class*="_line"]')].indexOf(row) + 1;
        if (index <= 0) return;
        mutate(sessionId, (s) => {
          const target = activeTab(s);
          if (target === null) return;
          if (event.shiftKey && target.selected.start !== null) target.selected.end = index;
          else {
            target.selected.start = index;
            target.selected.end = index;
          }
        });
      };
      if (primitives?.ReadBlock !== undefined && lines.length > 0) {
        return React.createElement('div', { className: 'dfp-surface', ref: hostRef, onClick },
          React.createElement(primitives.ReadBlock, {
            label: tab.relativePath ?? tab.path,
            lang: tab.file?.lang ?? 'text',
            lines: lines.map((text, index) => ({ number: index + 1, text })),
            totalLines: lines.length,
            maxLines: Infinity,
            labels: {
              window: (shown, total) => `${shown} of ${total} lines`,
              copy: 'Copy', copied: 'Copied', collapseAria: 'Collapse', collapse: 'Collapse',
              expandAria: (count) => `Expand ${count} lines`, expand: (count) => `Show ${count} more lines`
            }
          }));
      }
      return React.createElement('div', { className: 'dfp-surface', ref: hostRef, onClick },
        React.createElement('pre', { className: 'dfp-textarea', style: { margin: 0, minHeight: 200 } }, tab.file?.content ?? ''));
    }

    function PreviewSurface({ state, tab, sessionId }) {
      if (tab === null) return React.createElement('div', { className: 'dfp-empty' }, 'Open a file from the chat, the tree, or quick open.');
      if (tab.loading === true && tab.file === null) return React.createElement('div', { className: 'dfp-row' }, React.createElement('span', { className: 'dfp-spin' }), 'Loading…');
      if (tab.error !== null) {
        const notFound = /no such file|ENOENT/i.test(String(tab.error));
        return React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'dfp-note', 'data-tone': 'error' },
            React.createElement('div', { className: 'dfp-error-title' }, notFound ? 'File not found' : 'Could not open this file'),
            React.createElement('div', {
              className: 'dfp-path',
              title: `${tab.path}\n\nClick to copy`,
              onClick: () => void copyText(tab.path)
            }, React.createElement('span', { className: 'dfp-path-text' }, `Looked for: ${tab.path}`)),
            tab.requestedPath !== null && tab.requestedPath !== tab.path
              ? React.createElement('div', { className: 'dfp-sub' }, `The link named “${tab.requestedPath}” — read from the workspace root, exactly as written.`)
              : React.createElement('div', { className: 'dfp-sub' }, 'The path was used exactly as written.'),
            React.createElement('div', { className: 'dfp-sub' }, 'No name search was done. If the file lives in a subdirectory or another package, search for it yourself — nothing opens until you pick.'),
            notFound ? null : React.createElement('div', { className: 'dfp-sub' }, String(tab.error))),
          React.createElement('div', { className: 'dfp-stats' },
            React.createElement('button', {
              type: 'button', className: 'dfp-btn',
              title: 'Search the workspace yourself — nothing opens until you pick',
              onClick: () => {
                openPalette(sessionId, 'files');
                void runPalette(sessionId, basename(tab.requestedPath ?? tab.path));
              }
            }, 'Search workspace'),
            React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: () => void refresh(sessionId) }, 'Retry')));
      }
      if (tab.file === null) return React.createElement('div', { className: 'dfp-empty' }, 'No file loaded.');
      const blocks = [];
      if (tab.file.truncated === true) blocks.push(React.createElement('div', { key: 'warn', className: 'dfp-note', 'data-tone': 'warn' }, `Showing the first ${formatBytes(tab.file.size)} of a larger file.`));
      blocks.push(tab.showMeta === true
        ? React.createElement(MetaStrip, { key: 'meta', state, tab, sessionId })
        : React.createElement('div', { key: 'meta', className: 'dfp-stats' },
          React.createElement('button', {
            type: 'button', className: 'dfp-btn',
            onClick: () => mutate(sessionId, (s) => {
              const target = activeTab(s);
              if (target !== null) target.showMeta = true;
            })
          }, 'ⓘ Details')));
      if (tab.view === 'image') {
        blocks.push(React.createElement('img', {
          key: 'image', src: rawUrl(tab.path, state.cwd), alt: tab.name,
          style: { maxWidth: '100%', borderRadius: '8px', border: '.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3))' }
        }));
      } else if (tab.view === 'binary') {
        blocks.push(React.createElement('div', { key: 'binary', className: 'dfp-note' }, `Binary file — ${formatBytes(tab.file.size)} not rendered.`));
      } else if (tab.view === 'markdown' && primitives?.MarkdownText !== undefined) {
        blocks.push(React.createElement('div', { key: 'markdown', className: 'dfp-surface' }, React.createElement(primitives.MarkdownText, { text: tab.file.content, labels: MARKDOWN_LABELS })));
      } else {
        blocks.push(React.createElement(CodeSurface, { key: 'code', state, tab, sessionId }));
      }
      if (tab.diff !== null && tab.diff.hunks.length > 0) {
        blocks.push(React.createElement('div', { key: 'sep', className: 'dfp-sep' }));
        blocks.push(React.createElement('div', { key: 'stats', className: 'dfp-stats' },
          React.createElement('span', null, 'changed in this session'),
          React.createElement('span', { className: 'dfp-add' }, `+${tab.diff.added}`),
          React.createElement('span', { className: 'dfp-del' }, `−${tab.diff.removed}`),
          React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: () => mutate(sessionId, (s) => { s.tab = 'changes' }) }, 'Review changes')));
      }
      if (tab.selected.start !== null) {
        const from = tab.selected.start;
        const to = tab.selected.end ?? from;
        blocks.push(React.createElement('div', { key: 'selection', className: 'dfp-stats' },
          React.createElement('span', null, `lines ${from}${to !== from ? `–${to}` : ''}`),
          React.createElement('button', {
            type: 'button', className: 'dfp-btn',
            onClick: () => void copyText(`${tab.relativePath ?? tab.path}:${from}${to !== from ? `-${to}` : ''}`)
          }, 'Copy reference'),
          React.createElement('button', {
            type: 'button', className: 'dfp-btn',
            onClick: () => mutate(sessionId, (s) => {
              const target = activeTab(s);
              if (target === null) return;
              s.notes.push({ path: target.relativePath ?? target.path, line: from, text: (target.lines ?? []).slice(from - 1, to).join('\n') });
            })
          }, 'Add note'),
          React.createElement('button', {
            type: 'button', className: 'dfp-btn',
            onClick: () => mutate(sessionId, (s) => { const target = activeTab(s); if (target !== null) { target.selected.start = null; target.selected.end = null; } })
          }, 'Clear')));
      }
      return React.createElement(React.Fragment, null, blocks);
    }

    function TreeRow({ entry, depth, sessionId }) {
      const state = sessionState(sessionId);
      const isDirectory = entry.type === 'directory';
      const expanded = state.expanded[entry.path] === true;
      const children = state.tree[entry.path];
      const relative = state.cwd !== null && entry.path.startsWith(state.cwd)
        ? entry.path.slice(state.cwd.length).replace(/^[/\\]+/, '')
        : entry.name;
      const change = state.changes?.byRelative?.[relative];
      const tab = activeTab(state);
      const current = tab !== null && tab.path === entry.path;
      const glyph = isDirectory ? (expanded ? '▾' : '▸') : (entry.name.endsWith('.md') ? '¶' : '·');
      return React.createElement(React.Fragment, null,
        React.createElement('div', {
          className: 'dfp-row',
          'data-depth': String(Math.min(depth, 6)),
          'data-kind': entry.type,
          'data-current': current ? '1' : undefined,
          title: entry.path,
          onClick: () => {
            if (isDirectory) {
              const open = !(state.expanded[entry.path] === true);
              mutate(sessionId, (s) => { s.expanded[entry.path] = open });
              if (open && state.tree[entry.path] === undefined) void loadTree(sessionId, entry.path);
            } else {
              void openFile(sessionId, entry.path);
            }
          }
        },
          React.createElement('span', { className: 'dfp-icon' }, glyph),
          React.createElement('span', { className: 'dfp-row-name' }, entry.name),
          change !== undefined
            ? React.createElement('span', { className: 'dfp-stats' },
              React.createElement('span', { className: 'dfp-add' }, `+${change.added}`),
              React.createElement('span', { className: 'dfp-del' }, `−${change.removed}`))
            : null),
        isDirectory && expanded && children !== undefined
          ? React.createElement('div', { className: 'dfp-tree' }, children.map((child) => React.createElement(TreeRow, { key: child.path, entry: child, depth: depth + 1, sessionId })))
          : null,
        isDirectory && expanded && children === undefined
          ? React.createElement('div', { className: 'dfp-row', 'data-depth': String(Math.min(depth + 1, 6)) }, React.createElement('span', { className: 'dfp-spin' }))
          : null);
    }

    /**
     * The file's papers: exactly which path is on screen, what it resolved from,
     * how big it is, and what this session did to it. Every value that is a path
     * or a hash can be copied with one click.
     */
    function MetaStrip({ state, tab, sessionId }) {
      if (tab.file === null) return null;
      const file = tab.file;
      const relative = tab.relativePath ?? tab.path;
      const change = state.changes?.byRelative?.[relative] ?? state.changes?.byRelative?.[tab.path] ?? null;
      const rows = [
        ['path', tab.path, true],
        ['relative', relative, true],
        ['size', `${formatBytes(file.size ?? 0)} · ${file.lines ?? 0} lines`, false],
        ['modified', formatAge(file.mtimeMs ?? 0), false],
        ['sha256', typeof file.sha256 === 'string' && file.sha256.length > 0 ? file.sha256.slice(0, 32) + '…' : '—', true],
        ['language', file.lang ?? 'text', false],
        ['encoding', file.binary === true ? 'binary' : 'utf-8', false],
        ['session', change !== null
          ? `+${change.added} −${change.removed} in this session`
          : (tab.diff !== null && tab.diff.hunks.length > 0 ? `${tab.diff.hunks.length} hunk(s) recorded` : 'untouched in this session'), false],
        [tab.requestedPath !== null && tab.requestedPath !== tab.path ? 'link' : null,
          tab.requestedPath !== null && tab.requestedPath !== tab.path ? `${tab.requestedPath} → the path above` : null, false]
      ].filter((entry) => entry[0] !== null);
      return React.createElement('div', { className: 'dfp-meta' },
        React.createElement('div', { className: 'dfp-stats' },
          React.createElement('span', null, 'File details'),
          React.createElement('button', {
            type: 'button', className: 'dfp-btn', style: { marginLeft: 'auto' },
            onClick: () => mutate(sessionId, (s) => {
              const target = activeTab(s);
              if (target !== null) target.showMeta = false;
            })
          }, 'Hide')),
        rows.map(([key, value, copyable]) => React.createElement('div', { key, className: 'dfp-meta-row' },
          React.createElement('span', { className: 'dfp-meta-key' }, key),
          React.createElement('span', {
            className: 'dfp-meta-value',
            'data-copy': copyable ? '1' : undefined,
            title: copyable ? `${value} — click to copy` : value,
            onClick: copyable ? () => void copyText(String(value)) : undefined
          }, String(value)))));
    }

    function FilesSurface({ state, sessionId }) {
      const root = state.cwd;
      if (root === null) return React.createElement('div', { className: 'dfp-empty' }, 'This session has no workspace root.');
      const entries = state.tree[root];
      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dfp-stats' },
          React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: () => openPalette(sessionId, 'files') }, '⌘P Quick open'),
          React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: () => openPalette(sessionId, 'content') }, '⌘⇧F Search in files'),
          React.createElement('span', { style: { marginLeft: 'auto' } }, basename(root))),
        React.createElement('div', { className: 'dfp-tree' },
          entries === undefined
            ? React.createElement('div', { className: 'dfp-row' }, React.createElement('span', { className: 'dfp-spin' }), 'Loading workspace…')
            : entries.map((entry) => React.createElement(TreeRow, { key: entry.path, entry, depth: 0, sessionId }))));
    }

    function ReviewSurface({ state, sessionId }) {
      const files = state.changes?.files ?? [];
      if (state.loadingChanges === true && files.length === 0) {
        return React.createElement('div', { className: 'dfp-row' }, React.createElement('span', { className: 'dfp-spin' }), 'Indexing changed files…');
      }
      if (files.length === 0) {
        return React.createElement('div', { className: 'dfp-empty' },
          React.createElement('div', null, 'No file changes recorded in this session.'),
          React.createElement('div', { className: 'dfp-sub' }, 'Edits the agent makes with write/edit appear here.'));
      }
      const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
      const totalRemoved = files.reduce((sum, file) => sum + file.removed, 0);
      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dfp-stats' },
          React.createElement('span', null, `${files.length} file${files.length === 1 ? '' : 's'} changed`),
          React.createElement('span', { className: 'dfp-add' }, `+${totalAdded}`),
          React.createElement('span', { className: 'dfp-del' }, `−${totalRemoved}`),
          React.createElement('button', { type: 'button', className: 'dfp-btn', style: { marginLeft: 'auto' }, onClick: () => void loadChanges(sessionId) }, 'Refresh')),
        files.map((file) => {
          const open = state.review[file.path] === true;
          return React.createElement('div', { key: file.path, className: 'dfp-hunk' },
            React.createElement('div', {
              className: 'dfp-row',
              onClick: () => mutate(sessionId, (s) => { s.review[file.path] = !open })
            },
              React.createElement('span', { className: 'dfp-icon' }, open ? '▾' : '▸'),
              React.createElement('span', { className: 'dfp-row-name', title: file.path }, file.relativePath ?? file.path),
              React.createElement('span', { className: 'dfp-add' }, `+${file.added}`),
              React.createElement('span', { className: 'dfp-del' }, `−${file.removed}`)),
            open
              ? React.createElement(React.Fragment, null,
                React.createElement('div', { className: 'dfp-stats' },
                  React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: () => void openFile(sessionId, file.path) }, 'Open'),
                  React.createElement('button', { type: 'button', className: 'dfp-btn', title: file.path, onClick: () => void copyText(file.path) }, 'Copy path'),
                  React.createElement('button', {
                    type: 'button', className: 'dfp-btn', 'data-danger': '1', title: 'Undo every recorded hunk in this file',
                    onClick: () => void revertAllForPath(sessionId, file.path)
                  }, 'Revert file'),
                  React.createElement('button', {
                    type: 'button', className: 'dfp-btn',
                    onClick: () => void copyText(patchText(file.relativePath ?? file.path, file.hunks, ''))
                  }, 'Copy patch')),
                React.createElement(DiffView, {
                  tab: { diff: { hunks: file.hunks }, file: { content: '' }, reverted: {}, pendingRevert: null },
                  sessionId,
                  mode: 'split',
                  readOnly: true
                }))
              : null);
        }),
        state.notes.length > 0
          ? React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'dfp-sep' }),
            React.createElement('div', { className: 'dfp-stats' },
              React.createElement('span', null, `${state.notes.length} review note${state.notes.length === 1 ? '' : 's'}`),
              React.createElement('button', {
                type: 'button', className: 'dfp-btn', style: { marginLeft: 'auto' },
                onClick: () => void copyText(state.notes.map((note) => `${note.path}:${note.line}\n${note.text}`).join('\n\n'))
              }, 'Copy notes'),
              React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: () => mutate(sessionId, (s) => { s.notes = [] }) }, 'Clear notes')),
            state.notes.map((note, index) => React.createElement('div', { key: index, className: 'dfp-note' },
              React.createElement('div', { className: 'dfp-sub' }, `${note.path}:${note.line}`),
              React.createElement('div', null, note.text.slice(0, 400)))))
          : null);
    }

    /**
     * An editor with the shape people expect from an IDE: a line-number gutter
     * that scrolls with the text, a highlighted current line, hard tabs of two
     * spaces, auto-indent on Enter, and a status line that reports where the
     * caret is. Text lives in the tab state; everything here is presentation.
     */
    function EditorSurface({ state, tab, sessionId }) {
      const gutterRef = React.useRef(null);
      const inputRef = React.useRef(null);
      const [caret, setCaret] = React.useState({ line: 1, column: 1 });
      const text = tab?.editor?.text ?? '';
      const lineCount = text.length === 0 ? 1 : text.split('\n').length;

      const readCaret = () => {
        const input = inputRef.current;
        if (input === null) return;
        const upto = input.value.slice(0, input.selectionStart ?? 0);
        const parts = upto.split('\n');
        setCaret({ line: parts.length, column: (parts[parts.length - 1] ?? '').length + 1 });
      };

      React.useEffect(() => {
        const input = inputRef.current;
        if (input === null || tab?.editor === null || tab === null) return;
        readCaret();
      }, [tab?.path, tab?.editor === null]);

      if (tab === null) return React.createElement('div', { className: 'dfp-empty' }, 'Open a file to edit it.');
      if (tab.file === null) return React.createElement('div', { className: 'dfp-row' }, React.createElement('span', { className: 'dfp-spin' }), 'Loading…');
      if (tab.editor === null) {
        return React.createElement('div', { className: 'dfp-empty' },
          React.createElement('button', {
            type: 'button', className: 'dfp-btn', 'data-primary': '1',
            onClick: () => mutate(sessionId, (s) => {
              const target = activeTab(s);
              if (target === null || target.file === null) return;
              target.editor = { text: target.file.content, baseText: target.file.content, baseSha: target.file.sha256, dirty: false, saving: false, error: null };
            })
          }, 'Edit this file'));
      }

      const setText = (next) => mutate(sessionId, (s) => {
        const target = activeTab(s);
        if (target?.editor == null) return;
        target.editor.text = next;
        target.editor.dirty = next !== target.editor.baseText;
        target.editor.error = null;
      });

      const onKeyDown = (event) => {
        const input = inputRef.current;
        if (input === null) return;
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          void saveEditor(sessionId);
          return;
        }
        if (event.key === 'Tab') {
          event.preventDefault();
          const value = input.value;
          const start = input.selectionStart ?? 0;
          const end = input.selectionEnd ?? 0;
          const next = `${value.slice(0, start)}  ${value.slice(end)}`;
          setText(next);
          window.requestAnimationFrame(() => {
            input.selectionStart = start + 2;
            input.selectionEnd = start + 2;
            readCaret();
          });
          return;
        }
        if (event.key === 'Enter') {
          const value = input.value;
          const start = input.selectionStart ?? 0;
          const lineStart = value.lastIndexOf('\n', start - 1) + 1;
          const indent = (/^[ \t]*/.exec(value.slice(lineStart, start)) ?? [''])[0];
          if (indent.length > 0) {
            event.preventDefault();
            const next = `${value.slice(0, start)}\n${indent}${value.slice(input.selectionEnd ?? start)}`;
            setText(next);
            const position = start + 1 + indent.length;
            window.requestAnimationFrame(() => {
              input.selectionStart = position;
              input.selectionEnd = position;
              readCaret();
            });
          }
        }
      };

      const syncScroll = () => {
        const input = inputRef.current;
        const gutter = gutterRef.current;
        if (input === null || gutter === null) return;
        gutter.scrollTop = input.scrollTop;
      };

      const gutterLines = [];
      for (let index = 1; index <= lineCount; index += 1) {
        gutterLines.push(React.createElement('div', {
          key: index,
          className: 'dfp-gutter-line',
          'data-active': index === caret.line ? '1' : undefined
        }, String(index)));
      }

      return React.createElement('div', { className: 'dfp-editor' },
        React.createElement('div', { className: 'dfp-edit-body' },
          React.createElement('div', { className: 'dfp-gutter', ref: gutterRef, 'data-lines': String(lineCount) }, gutterLines),
          React.createElement('div', { className: 'dfp-edit-scroll' },
            React.createElement('div', {
              className: 'dfp-edit-band',
              style: { top: `${8 + (caret.line - 1) * 20 - (inputRef.current?.scrollTop ?? 0)}px` }
            }),
            React.createElement('textarea', {
              className: 'dfp-code-input',
              ref: inputRef,
              value: tab.editor.text,
              spellCheck: false,
              wrap: 'off',
              autoCapitalize: 'off',
              autoCorrect: 'off',
              onScroll: syncScroll,
              onKeyDown,
              onKeyUp: readCaret,
              onClick: readCaret,
              onSelect: readCaret,
              onChange: (event) => setText(event.target.value)
            }))),
        React.createElement('div', { className: 'dfp-stats' },
          React.createElement('button', {
            type: 'button', className: 'dfp-btn', 'data-primary': '1',
            disabled: tab.editor.saving === true || tab.editor.dirty !== true,
            onClick: () => void saveEditor(sessionId)
          }, tab.editor.saving === true ? 'Saving…' : 'Save (⌘S)'),
          React.createElement('button', {
            type: 'button', className: 'dfp-btn', disabled: tab.editor.dirty !== true,
            onClick: () => mutate(sessionId, (s) => {
              const target = activeTab(s);
              if (target?.editor == null) return;
              target.editor.text = target.editor.baseText;
              target.editor.dirty = false;
              target.editor.error = null;
            })
          }, 'Revert edits'),
          React.createElement('span', { className: 'dfp-caret' }, `Ln ${caret.line}, Col ${caret.column}`),
          React.createElement('span', null, `${lineCount} lines`),
          React.createElement('span', null, tab.file?.lang ?? 'text'),
          tab.editor.dirty === true ? React.createElement('span', { className: 'dfp-badge' }, 'unsaved') : React.createElement('span', { className: 'dfp-badge' }, 'saved'),
          tab.stale === true ? React.createElement('span', { className: 'dfp-badge' }, 'changed on disk') : null,
          tab.editor.error !== null ? React.createElement('span', { className: 'dfp-del' }, tab.editor.error) : null));
    }

    function Palette({ state, sessionId }) {
      const palette = state.palette;
      if (palette.open !== true) return null;
      return React.createElement('div', { className: 'dfp-palette' },
        React.createElement('div', { className: 'dfp-findbar' },
          React.createElement('input', {
            className: 'dfp-input',
            autoFocus: true,
            placeholder: palette.kind === 'content' ? 'Search file contents…' : 'Search files by name…',
            value: palette.query,
            onChange: (event) => void runPalette(sessionId, event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                closePalette(sessionId);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                mutate(sessionId, (s) => { s.palette.index = Math.min(s.palette.index + 1, Math.max(0, s.palette.results.length - 1)) });
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                mutate(sessionId, (s) => { s.palette.index = Math.max(0, s.palette.index - 1) });
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const hit = palette.results[palette.index];
                if (hit !== undefined) {
                  closePalette(sessionId);
                  void openFile(sessionId, hit.path, hit.line !== undefined ? { findLine: hit.line } : undefined);
                }
              }
            }
          }),
          palette.loading === true ? React.createElement('span', { className: 'dfp-spin' }) : null,
          React.createElement('span', { className: 'dfp-sub' }, String(palette.results.length)),
          React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: () => closePalette(sessionId) }, '✕')),
        React.createElement('div', { className: 'dfp-palette-list' },
          palette.results.map((hit, index) => React.createElement('div', {
            key: `${hit.path}:${hit.line ?? 0}`,
            className: 'dfp-palette-item',
            'data-active': index === palette.index ? '1' : undefined,
            onClick: () => {
              closePalette(sessionId);
              void openFile(sessionId, hit.path, hit.line !== undefined ? { findLine: hit.line } : undefined);
            }
          },
            React.createElement('span', { className: 'dfp-row-name' }, basename(hit.path)),
            React.createElement('span', { className: 'dfp-palette-path' }, hit.line !== undefined ? `${hit.relativePath}:${hit.line}` : hit.relativePath),
            hit.text !== undefined ? React.createElement('span', { className: 'dfp-palette-path' }, hit.text.slice(0, 60)) : null))));
    }

    function FindBar({ state, tab, sessionId }) {
      if (state.find.open !== true || tab === null) return null;
      const count = state.find.hits.length;
      const matched = tab.lines.filter((line) => line.toLowerCase().includes(state.find.query.toLowerCase())).join('\n');
      return React.createElement('div', { className: 'dfp-findbar' },
        React.createElement('input', {
          className: 'dfp-input',
          autoFocus: true,
          placeholder: 'Find in file…',
          value: state.find.query,
          onChange: (event) => setFind(sessionId, event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              mutate(sessionId, (s) => { s.find.open = false; s.find.hits = [] });
            } else if (event.key === 'Enter') {
              event.preventDefault();
              stepFind(sessionId, event.shiftKey ? -1 : 1);
            }
          }
        }),
        React.createElement('span', { className: 'dfp-sub' }, count === 0 ? 'no match' : `${state.find.index + 1}/${count}`),
        React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: () => stepFind(sessionId, -1) }, '↑'),
        React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: () => stepFind(sessionId, 1) }, '↓'),
        React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: () => void copyText(matched) }, 'Copy matches'),
        React.createElement('button', { type: 'button', className: 'dfp-btn', onClick: () => mutate(sessionId, (s) => { s.find.open = false; s.find.hits = [] }) }, '✕'));
    }

    /**
     * Two different files can share a basename (`a/dup.js`, `b/dup.js`). Showing
     * "dup.js dup.js" in the strip looks like the duplicate-tab bug, so a
     * collision is disambiguated with the parent directory.
     */
    function tabLabel(tab, tabs) {
      const name = tab.name ?? basename(tab.path);
      const sameName = tabs.filter((entry) => (entry.name ?? basename(entry.path)) === name).length > 1;
      if (sameName !== true) return name;
      const parts = String(tab.relativePath ?? tab.path).split(/[/\\]+/).filter((part) => part.length > 0);
      return parts.length >= 2 ? `${parts[parts.length - 2]}/${name}` : name;
    }

    /**
     * What the gate refused, and why. Rendered above every surface so a refused
     * open is never mistaken for an empty file or a broken panel.
     */
    function OpenNotice({ state, sessionId }) {
      const notice = state.notice;
      if (notice === null) return null;
      return React.createElement('div', { className: 'dfp-note', 'data-tone': 'error', 'data-kind': 'refused' },
        React.createElement('div', { className: 'dfp-error-title' }, 'Not opened — that path is not on disk'),
        React.createElement('div', {
          className: 'dfp-path',
          title: `${notice.path}\n\nClick to copy`,
          onClick: () => void copyText(notice.path)
        }, React.createElement('span', { className: 'dfp-path-text' }, notice.path)),
        notice.requested !== notice.path
          ? React.createElement('div', { className: 'dfp-sub' }, `The link named “${notice.requested}”, read from the workspace root.`)
          : null,
        React.createElement('div', { className: 'dfp-sub' }, 'Only files that exist can be opened. Nothing was searched for and nothing was opened.'),
        React.createElement('div', { className: 'dfp-stats' },
          React.createElement('button', {
            type: 'button', className: 'dfp-btn',
            title: 'Search the workspace yourself — nothing opens until you pick',
            onClick: () => {
              openPalette(sessionId, 'files');
              void runPalette(sessionId, basename(notice.requested ?? notice.path));
            }
          }, 'Search workspace'),
          React.createElement('button', {
            type: 'button', className: 'dfp-btn',
            onClick: () => mutate(sessionId, (s) => { s.notice = null })
          }, 'Dismiss')));
    }

    function FileTabs({ state, sessionId }) {
      if (state.tabs.length < 2) return null;
      return React.createElement('div', { className: 'dfp-tabs', 'data-kind': 'files' },
        state.tabs.map((tab, index) => React.createElement('button', {
          key: tab.path,
          type: 'button',
          className: 'dfp-tab dfp-filetab',
          'data-active': index === state.active ? '1' : undefined,
          title: `${tabLabel(tab, state.tabs)}\n${tab.path}`,
          onClick: () => activateTab(sessionId, index)
        },
          tab.stale === true ? React.createElement('span', { className: 'dfp-dot' }) : null,
          React.createElement('span', { className: 'dfp-row-name' }, tabLabel(tab, state.tabs)),
          React.createElement('span', {
            className: 'dfp-close',
            onClick: (event) => {
              event.stopPropagation();
              closeTab(sessionId, index);
            }
          }, '✕'))));
    }

    function useNarrow(ref) {
      const [narrow, setNarrow] = React.useState(false);
      React.useEffect(() => {
        const element = ref.current;
        if (element === null) return undefined;
        const measure = () => setNarrow(element.getBoundingClientRect().width < 430);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
      }, [ref]);
      return narrow;
    }

    /** The panel's inner markup: header, tabs, surface, footer. */
    function PanelSurfaceBody({ sessionId, ctx, narrow }) {
      React.useSyncExternalStore(subscribe, getVersion, getVersion);
      const state = sessionStates.get(sessionId);
      if (state === undefined || runtime.owner !== sessionId) return null;
      const tab = activeTab(state);
      const views = [
        ['preview', 'Preview'],
        ['changes', tab !== null && (tab.diff?.hunks?.length ?? 0) > 0 ? `Changes · ${tab.diff.hunks.length}` : 'Changes'],
        ['review', changeCount(state) > 0 ? `Review · ${changeCount(state)}` : 'Review'],
        ['files', 'Files'],
        ['edit', 'Edit']
      ];
      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dfp-header' },
          React.createElement('div', { className: 'dfp-headline' },
            React.createElement('div', { className: 'dfp-name', title: tab?.path ?? '' }, tab?.name ?? 'File panel'),
            tab !== null
              ? React.createElement('div', {
                className: 'dfp-path',
                title: `${tab.path}\n\nClick to copy`,
                onClick: () => void copyText(tab.path)
              }, React.createElement('span', { className: 'dfp-path-text' }, tab.path))
              : null,
            React.createElement('div', { className: 'dfp-sub' },
              tab === null
                ? ''
                : [
                  tab.relativePath ?? '',
                  tab.requestedPath !== null && tab.requestedPath !== tab.path ? `link: ${tab.requestedPath}` : ''
                ].filter((part) => part.length > 0).join(' · '))),
          React.createElement('div', { className: 'dfp-actions' },
            React.createElement('button', { type: 'button', className: 'dfp-btn', title: 'Reveal in IDE / default app', disabled: tab === null, onClick: () => void openExternally(ctx, tab) }, 'Open IDE'),
            React.createElement('button', { type: 'button', className: 'dfp-btn', title: 'Find in file (⌘F)', disabled: tab === null, onClick: () => mutate(sessionId, (s) => { s.find.open = true }) }, '⌕'),
            React.createElement('button', { type: 'button', className: 'dfp-btn', title: 'Refresh', onClick: () => void refresh(sessionId) }, tab?.loading === true ? React.createElement('span', { className: 'dfp-spin' }) : '↻'),
            React.createElement('button', { type: 'button', className: 'dfp-btn', title: 'Close panel', onClick: () => closePanel(ctx) }, '✕'))),
        React.createElement(FileTabs, { state, sessionId }),
        React.createElement('div', { className: 'dfp-tabs' },
          views.map(([key, label]) => React.createElement('button', {
            key,
            type: 'button',
            className: 'dfp-tab',
            'data-active': state.tab === key ? '1' : undefined,
            onClick: () => selectView(ctx, sessionId, key)
          }, label))),
        React.createElement('div', { className: 'dfp-body' },
          state.pending !== null
            ? React.createElement('div', { className: 'dfp-note dfp-pending' },
              React.createElement('span', { className: 'dfp-spin' }),
              `Opening ${state.pending.path}`)
            : null,
          React.createElement(OpenNotice, { state, sessionId }),
          React.createElement(FindBar, { state, tab, sessionId }),
          React.createElement(Palette, { state, sessionId }),
          state.tab === 'files'
            ? React.createElement(FilesSurface, { state, sessionId })
            : state.tab === 'review'
              ? React.createElement(ReviewSurface, { state, sessionId })
              : state.tab === 'changes'
                ? React.createElement(ChangesSurface, { state, tab, sessionId })
                : state.tab === 'edit'
                  ? React.createElement(EditorSurface, { state, tab, sessionId })
                  : React.createElement(PreviewSurface, { state, tab, sessionId })),
        React.createElement('div', { className: 'dfp-footer' },
          tab?.file != null ? React.createElement('span', null, `${tab.file.lines ?? 0} lines · ${formatBytes(tab.file.size)}`) : null,
          tab?.file != null ? React.createElement('span', null, `modified ${formatAge(tab.file.mtimeMs)}`) : null,
          (tab?.diff?.hunks?.length ?? 0) > 0 ? React.createElement('span', null, `${tab.diff.hunks.length} hunk${tab.diff.hunks.length === 1 ? '' : 's'} this file`) : null,
          changeCount(state) > 0 ? React.createElement('span', null, `${changeCount(state)} files changed this session`) : null,
          state.notes.length > 0 ? React.createElement('span', null, `${state.notes.length} note${state.notes.length === 1 ? '' : 's'}`) : null,
          React.createElement('span', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }, title: 'auto-refresh' },
            React.createElement('span', { className: 'dfp-live' }),
            narrow === true ? null : 'auto-refresh'),
          React.createElement('span', {
            className: 'dfp-badge',
            title: 'client build — reload the window (Cmd-R) after installing a new one',
            'data-build': CLIENT_BUILD
          }, CLIENT_BUILD)));
    }

    /** The panel host: the layout's right column, pinned to the window when that
     *  column cannot be shown. */
    function PanelSeat(props) {
      // The host itself subscribes: dock width and host mode are runtime state,
      // and the seat entry is rendered once by the outlet.
      React.useSyncExternalStore(subscribe, getVersion, getVersion);
      const ref = React.useRef(null);
      const narrow = useNarrow(ref);
      const sessionId = props.sessionId;
      const ctx = props.__ctx;
      const docked = runtime.mode === 'overlay';
      // A slide-over must never feel stuck: clicking anywhere outside it, or
      // pressing Escape, puts the panel away.
      React.useEffect(() => {
        if (docked !== true) return undefined;
        const onPointerDown = (event) => {
          const node = ref.current;
          if (node === null || node.contains(event.target) === true) return;
          closePanel(ctx);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closePanel(ctx);
        };
        window.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('keydown', onKeyDown, true);
        return () => {
          window.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('keydown', onKeyDown, true);
        };
      }, [docked, ctx]);
      const seatState = sessionStates.get(sessionId);
      if (seatState === undefined || runtime.owner !== sessionId) return null;
      // "Nothing to show" means no tab, no notice and no tree on screen — the
      // file tree is content, so asking for the panel always draws something.
      const empty = seatState.tabs.length === 0 && seatState.notice === null && seatState.pending === null && seatState.tab === 'preview';
      if (docked === true && empty === true) return null;
      const dockWidth = docked === true
        ? Math.max(280, Math.min(clampDockWidth(runtime.dockWidth), window.innerWidth - 320))
        : runtime.dockWidth;
      return React.createElement('div', {
        className: 'dfp-root',
        ref,
        tabIndex: -1,
        'data-dock': docked ? 'true' : undefined,
        style: docked ? { '--dfp-dock-width': `${dockWidth}px` } : undefined,
        onKeyDown: (event) => handleKey(event, ctx, sessionId)
      },
        docked
          ? React.createElement('div', { className: 'dfp-dock-handle', onPointerDown: startDockDrag, title: 'Drag to resize' })
          : null,
        React.createElement(PanelSurfaceBody, { sessionId, ctx, narrow: docked ? runtime.dockWidth < 430 : narrow }));
    }

    /** Host 2 — a slide-over dock for windows where the column cannot open. */
    function OverlayDock() {
      React.useSyncExternalStore(subscribe, getVersion, getVersion);
      const sessionId = runtime.owner;
      const ctx = panelContext;
      if (runtime.visible !== true || sessionId === null || ctx === null) return null;
      if (sessionStates.get(sessionId) === undefined) return null;
      return React.createElement('div', {
        className: 'dfp-dock',
        style: { width: `${runtime.dockWidth}px` },
        tabIndex: -1,
        onKeyDown: (event) => handleKey(event, ctx, sessionId)
      },
        React.createElement('div', { className: 'dfp-dock-handle', onPointerDown: startDockDrag, title: 'Drag to resize' }),
        React.createElement('div', { className: 'dfp-dock-inner' },
          React.createElement(PanelSurface, { sessionId, ctx, narrow: runtime.dockWidth < 430 })));
    }

    // ------------------------------------------------------------------
    // behaviours
    // ------------------------------------------------------------------

    let panelContext = null;
    let overlayRoot = null;
    let overlayHost = null;
    let seatDisposer = null;
    let seatMountedFor = null;
    let originalOpenWorkspacePath = null;
    let layoutService = null;
    let originalLayoutOpen = null;
    let originalLayoutClose = null;
    let interceptEnabled = true;
    let pollTimer = null;
    let paletteToken = 0;

    function currentSessionId(ctx) {
      return ctx?.get('sessions')?.list?.getSnapshot?.()?.current ?? null;
    }

    function sessionFacts(ctx) {
      const list = ctx.get('sessions')?.list?.getSnapshot?.();
      const sessionId = list?.current ?? null;
      const cwd = sessionId === null ? null : list?.byId?.[sessionId]?.cwd ?? null;
      return { sessionId, cwd: typeof cwd === 'string' && cwd.length > 0 ? cwd : null };
    }

    /** The layout renders the right column only for a non-blank current session. */
    function canShowPanel(ctx) {
      const list = ctx.get('sessions')?.list?.getSnapshot?.();
      const current = list?.current;
      if (current === undefined || current === null) return false;
      return list.byId?.[current]?.blank === false;
    }

    /**
     * Whether the layout can show the right column at this window size. Mirrors
     * DSH's own computeColumns: the rail/sidebar, the 300px details minimum and a
     * 640px centre must all fit, otherwise the column resolves to 0 and a seated
     * panel would render invisibly.
     */
    /** Width of the layout's own right column — 0 when the layout refuses it. */
    function detailsColumnWidth() {
      const column = document.querySelector('[class*="detailsCol"]');
      if (column !== null) {
        const width = Math.round(column.getBoundingClientRect().width);
        if (width >= 0) return width;
      }
      const frame = document.querySelector('[data-shell-overlay]')?.parentElement ?? null;
      if (frame === null) return 0;
      return Math.round(frame.children[2]?.getBoundingClientRect().width ?? 0);
    }

    /** Width of the conversation column, for deciding how much room we may take. */
    function centerColumnWidth() {
      const column = document.querySelector('[class*="centerCol"]');
      if (column !== null) return Math.round(column.getBoundingClientRect().width);
      const frame = document.querySelector('[data-shell-overlay]')?.parentElement ?? null;
      if (frame === null) return window.innerWidth;
      return Math.round(frame.children[1]?.getBoundingClientRect().width ?? window.innerWidth);
    }

    /**
     * Inset the conversation only when it can afford it: the chat keeps at least
     * 700px of content, otherwise the panel floats over the edge instead of
     * squeezing the chat into a column.
     */
    function pushWidth() {
      const dock = Math.min(clampDockWidth(runtime.dockWidth), defaultDockWidth());
      const center = centerColumnWidth();
      return center - dock >= 700 ? dock : 0;
    }

    /** Sidebar width as the layout resolved it (rail width when collapsed). */
    function sidebarWidth() {
      const frame = document.querySelector('[data-shell-overlay]')?.parentElement ?? null;
      if (frame === null) return 280;
      const width = Math.round(frame.children[0]?.getBoundingClientRect().width ?? 0);
      return width > 0 ? width : 80;
    }

    /**
     * The layout's own column solver (`computeColumns`), reproduced exactly.
     * `openDetails()` asks for a 360px details column; whether the viewport can
     * afford it decides if the panel gets a real column or has to dock. Getting
     * this wrong is what made an earlier build sit in a 0px column: it measured
     * a closed column, concluded "no column", and never asked for one.
     */
    function predictDetailsWidth() {
      const viewport = window.innerWidth;
      const sidebar = Math.min(420, Math.max(264, sidebarWidth()));
      const wanted = 360;
      if (sidebar + wanted + 640 <= viewport) return wanted;
      const squeezed = Math.max(300, viewport - sidebar - 640);
      if (sidebar + squeezed + 640 <= viewport) return squeezed;
      return 0;
    }

    function columnFits() {
      // Measured, never predicted. A seat inside a collapsed column measures
      // zero pixels: that is the layout telling us it refused the column, and a
      // hand-rolled copy of DSH's column maths gets that wrong at some window
      // sizes (a 0px column holding a mounted panel is exactly what "my UI is
      // broken" looks like). A docked panel measures itself, so it must not be
      // consulted — only the real column counts then.
      const root = document.querySelector('.dfp-root');
      const docked = root !== null && root.getAttribute('data-dock') === 'true';
      if (root !== null && docked !== true) {
        const width = Math.round(root.getBoundingClientRect().width);
        if (width > 0) return width >= 300;
      }
      return detailsColumnWidth() >= 300;
    }

    let layoutObserver = null;

    /** Flip between the column and the dock the moment the layout changes its
     *  mind — on resize, on sidebar collapse, on anything. */
    function watchLayout(ctx, sessionId) {
      if (layoutObserver !== null) return;
      const frame = document.querySelector('[data-shell-overlay]')?.parentElement ?? null;
      if (frame === null) return;
      layoutObserver = new ResizeObserver(() => {
        if (runtime.visible !== true || runtime.owner === null) return;
        const want = detailsColumnWidth() >= 300 ? 'column' : 'overlay';
        const settled = runtime.mode === 'column' && rootHasWidth() === true;
        if (want === 'overlay' && runtime.mode === 'column' && settled !== true) return;
        if (want !== runtime.mode) {
          runtime.mode = want;
          notify();
        }
      });
      for (const child of frame.children) layoutObserver.observe(child);
      const column = document.querySelector('[class*="detailsCol"]');
      if (column !== null) layoutObserver.observe(column);
    }

    function rootHasWidth() {
      const root = document.querySelector('.dfp-root');
      return root !== null && Math.round(root.getBoundingClientRect().width) >= 300;
    }

    function unmountOverlay() {
      /* dock mode lives inside the seat; nothing extra to tear down */
    }

    /** The toggle tab lives in the document, not in the layout's slots. */
    function ensureToggleHost() {
      if (typeof document === 'undefined' || document.body === null) return;
      if (document.getElementById('dfp-toggle') !== null) return;
      const tab = document.createElement('button');
      tab.id = 'dfp-toggle';
      tab.className = 'dfp-toggle';
      tab.type = 'button';
      tab.textContent = '‹ File panel';
      tab.title = 'Open the file panel (⌥⌘F)';
      document.body.appendChild(tab);
    }

    /** Pick the host this window can actually render, and switch live on resize. */
    function applyPanelHost(ctx, sessionId) {
      // Decide from the column that is really there, before anything is
      // mounted: a seat inside a 0px column paints a sliver of overflowing
      // content at the window edge, and pushing the chat while DSH has already
      // opened its own column squeezes the conversation twice.
      runtime.mode = detailsColumnWidth() >= 300 ? 'column' : 'overlay';
      mountSeat(ctx, sessionId);
      notify();
      // After the first paint the real width is known: if the column handed us
      // nothing, dock instead of holding an invisible seat.
      window.requestAnimationFrame(() => {
        if (runtime.visible !== true || runtime.owner !== sessionId) return;
        const root = document.querySelector('.dfp-root');
        if (root === null) return;
        const seatWidth = Math.round(root.getBoundingClientRect().width);
        const column = detailsColumnWidth();
        const want = column >= 300 && seatWidth >= 300 ? 'column' : 'overlay';
        if (want !== runtime.mode) {
          runtime.mode = want;
          notify();
        }
        watchLayout(ctx, sessionId);
      });
    }

    let dockDragging = false;
    let dockMoves = 0;

    /**
     * How wide the panel may be. A 420px panel is a third of a 1200px window, so
     * the default scales with the window instead of assuming a wide one.
     */
    function defaultDockWidth() {
      return Math.max(300, Math.min(420, Math.round(window.innerWidth * 0.32)));
    }

    function clampDockWidth(width) {
      const limit = Math.max(280, Math.round(window.innerWidth * 0.45));
      return Math.max(280, Math.min(width, limit));
    }

    function startDockDrag(event) {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = runtime.dockWidth;
      dockDragging = true;
      const move = (moveEvent) => {
        dockMoves += 1;
        const max = Math.min(760, window.innerWidth - 140);
        runtime.dockWidth = clampDockWidth(Math.max(300, Math.min(max, startWidth + (startX - moveEvent.clientX))));
        notify();
      };
      const up = () => {
        dockDragging = false;
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    }

    function mountSeat(ctx, sessionId) {
      runtime.owner = sessionId;
      if (seatMountedFor === sessionId) return;
      unmountSeatOnly();
      seatMountedFor = sessionId;
      runtime.owner = sessionId;
      seatDisposer = ctx.slots.inject('details', () => ctx.slots.register({
        name: 'details',
        priority: SEAT_PRIORITY,
        inject: () => ({ __ctx: ctx })
      }, PanelSeat));
    }

    function unmountSeatOnly() {
      if (seatDisposer !== null) {
        try {
          seatDisposer();
        } catch (error) {
          console.warn('[dsh-file-panel] seat release failed:', error);
        }
        seatDisposer = null;
      }
      seatMountedFor = null;
    }

    function unmountSeat() {
      unmountSeatOnly();
      runtime.owner = null;
    }

    /** Ask the layout for its details column. This call is what opens it. */
    async function openColumn(ctx) {
      const attempts = [
        () => originalLayoutOpen?.(),
        () => layoutService?.openDetails?.(),
        () => ctx.get('layout')?.openDetails?.()
      ];
      for (const attempt of attempts) {
        try {
          attempt();
          return;
        } catch (error) {
          console.warn('[dsh-file-panel] openDetails attempt failed:', error?.message ?? error);
        }
      }
    }

    function closePanel(ctx) {
      runtime.visible = false;
      unmountOverlay();
      unmountSeat();
      notify();
      try {
        originalLayoutClose?.();
      } catch {
        /* already closed */
      }
    }

    /** The seat never outlives its owning session. */
    function watchSessions(ctx) {
      const sessions = ctx.get('sessions');
      if (sessions?.list?.subscribe === undefined) return;
      sessions.list.subscribe(() => {
        if (runtime.visible !== true || runtime.owner === null) return;
        const current = sessions.list.getSnapshot()?.current ?? null;
        if (current !== runtime.owner) closePanel(ctx);
      });
    }

    function installOpenerInterceptor(ctx) {
      const service = ctx.remote?.session;
      if (service === undefined) return false;
      const descriptor = Object.getOwnPropertyDescriptor(service, 'openWorkspacePath');
      if (descriptor === undefined) return false;
      const callOriginal = descriptor.get !== undefined ? descriptor.get.call(service) : descriptor.value;
      originalOpenWorkspacePath = (request, signal) => callOriginal(request, signal);
      Object.defineProperty(service, 'openWorkspacePath', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: async (request, signal) => {
          const target = request?.path;
          if (interceptEnabled === true && typeof target === 'string' && target.length > 0 && canShowPanel(ctx)) {
            void openPath(ctx, target).catch((error) => {
              console.warn('[dsh-file-panel] open failed:', error?.message ?? error);
            });
            return { ok: true, value: { opened: true } };
          }
          return originalOpenWorkspacePath(request, signal);
        }
      });
      return true;
    }

    function installLayoutYield(ctx) {
      const layout = ctx.get('layout');
      if (layout === undefined) return;
      layoutService = layout;
      const prototype = Object.getPrototypeOf(layout);
      if (typeof prototype?.openDetails === 'function') {
        // Bind the instance: the implementation reaches into private fields, so
        // calling the raw prototype method with a foreign `this` throws and the
        // request is lost. A bound copy keeps the real receiver.
        originalLayoutOpen = layout.openDetails.bind(layout);
        Object.defineProperty(layout, 'openDetails', {
          configurable: true,
          writable: true,
          value: function openDetails() {
            if (runtime.visible === true) closePanel(ctx);
            return originalLayoutOpen.call(this);
          }
        });
      }
      if (typeof prototype?.closeDetails === 'function') originalLayoutClose = layout.closeDetails.bind(layout);
    }

    // ------------------------------------------------------------------
    // data loading
    // ------------------------------------------------------------------

    function pushTab(state, path, relativePath, name, key) {
      const identity = key ?? lexicalNormalize(path);
      const candidate = { key: identity, path };
      const existing = state.tabs.findIndex((tab) => sameFilePath(tab, candidate));
      if (existing !== -1) {
        const tab = state.tabs[existing];
        state.active = existing;
        // A better identity (the host's canonical spelling) always replaces a
        // guess, so later opens of either spelling land on this same tab.
        if (key !== null && key !== undefined) tab.key = key;
        if (typeof relativePath === 'string' && relativePath.length > 0) tab.relativePath = relativePath;
        return tab;
      }
      const tab = newTabState(path, relativePath ?? path, name ?? basename(path));
      tab.key = identity;
      state.tabs.push(tab);
      if (state.tabs.length > MAX_TABS) {
        state.tabs.splice(0, state.tabs.length - MAX_TABS);
      }
      state.active = state.tabs.indexOf(tab);
      return tab;
    }

    /**
     * The gate in front of every open: a tab exists only for a path the host
     * confirms right now. A stale link, a typo, a path somebody invented — none
     * of them can put content on screen, because none of them get a tab.
     */
    function refuseOpen(sessionId, notice) {
      mutate(sessionId, (state) => {
        state.pending = null;
        state.notice = notice;
        trace(state, 'refused', notice);
      });
    }

    let toggleButton = null;

    /** Open the panel without a file: the last tab, or the workspace tree. */
    function showPanel(ctx, sessionId) {
      ensureStyles();
      const id = sessionId ?? currentSessionId(ctx);
      if (id === null || id === undefined) return;
      // No blank-session gate here: the dock owns its own space, it does not
      // need the layout to render a column for it.
      const facts = sessionFacts(ctx);
      mutate(id, (state) => {
        if (state.cwd === null) state.cwd = facts.cwd;
        if (state.tabs.length === 0) state.tab = 'files';
        const active = activeTab(state);
        if (active !== null) {
          if (active.file === null && active.loading !== true && active.error === null) void loadFile(id, active.id);
          state.tab = 'preview';
        }
      });
      runtime.visible = true;
      if (runtime.dockWidth > defaultDockWidth()) runtime.dockWidth = defaultDockWidth();
      applyPanelHost(ctx, id);
      const state = sessionState(id);
      if (state.tabs.length === 0 && state.cwd !== null) void loadTree(id, state.cwd);
    }

    function togglePanel(ctx) {
      if (runtime.visible === true) closePanel(ctx);
      else showPanel(ctx, runtime.owner ?? currentSessionId(ctx));
    }

    /** The slim tab that is the plugin's only resting UI. */
    function syncToggleButton() {
      if (typeof document === 'undefined' || document.body === null) return;
      const owner = runtime.owner ?? (panelContext === null ? null : currentSessionId(panelContext));
      const state = owner === null ? undefined : sessionStates.get(owner);
      const hasWork = state !== undefined && (state.tabs.length > 0 || state.notice !== null || state.pending !== null);
      const canvas = document.getElementById('dfp-toggle') ?? null;
      if (canvas === null) {
        if (toggleButton !== null) {
          toggleButton.remove();
          toggleButton = null;
        }
        return;
      }
      if (toggleButton === null) {
        toggleButton = canvas;
        canvas.addEventListener('click', (event) => {
          event.stopPropagation();
          if (panelContext === null) return;
          togglePanel(panelContext);
        });
      }
      const open = runtime.visible === true;
      canvas.textContent = open ? '✕ File panel' : '‹ File panel';
      canvas.setAttribute('data-open', open ? '1' : '0');
      canvas.title = open
        ? 'Close the file panel (⌥⌘F)'
        : hasWork ? 'Reopen the file panel (⌥⌘F)' : 'Open the file panel (⌥⌘F)';
    }

    function closeTab(sessionId, index) {
      mutate(sessionId, (state) => {
        state.tabs.splice(index, 1);
        state.active = Math.max(0, Math.min(state.active, state.tabs.length - 1));
        if (state.tabs.length === 0) state.tab = 'files';
      });
    }

    /**
     * A link names a path. The panel opens exactly that path — the string the
     * link carried, joined to the workspace root when it is relative — and
     * nothing else. There is no basename hunting and no nearest-match search: a
     * link that points at something which is not there says so, with the exact
     * absolute path it tried, so nobody has to wonder which file was opened.
     */
    async function openPath(ctx, rawPath, options) {
      ensureStyles();
      const facts = sessionFacts(ctx);
      const sessionId = options?.sessionId ?? facts.sessionId;
      if (sessionId === null || sessionId === undefined) return;
      const cwd = options?.cwd ?? facts.cwd;
      const requested = lexicalNormalize(String(rawPath ?? '').trim());
      if (requested.length === 0) return;
      const absolute = requested.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(requested)
        ? nativePath(requested)
        : (typeof cwd === 'string' && cwd.length > 0 ? nativePath(`${cwd.replace(/[/\\]+$/, '')}/${requested}`) : requested);

      runtime.visible = true;
      if (runtime.dockWidth > defaultDockWidth()) runtime.dockWidth = defaultDockWidth();
      applyPanelHost(ctx, sessionId);
      // The workspace root is known whether or not the path turns out to exist:
      // the refused notice and the tree still need somewhere to point at.
      mutate(sessionId, (state) => { state.cwd = cwd });

      // Nothing opens unless it is on disk right now. A directory link opens the
      // tree at that directory; anything else that is not there is refused with
      // the exact path it tried — no tab, no content, no guess.
      const stat = await callHost('stat', { path: absolute, cwd }).catch(() => null);
      if (stat === null) {
        refuseOpen(sessionId, { kind: 'missing', path: absolute, requested, at: Date.now() });
        return;
      }
      if (stat.isDirectory === true) {
        mutate(sessionId, (state) => {
          state.cwd = cwd;
          state.pending = null;
          state.tab = 'files';
          trace(state, 'link-directory', { requested, absolute });
        });
        await loadTree(sessionId, absolute);
        return;
      }

      const relative = typeof cwd === 'string' && cwd.length > 0 && hasPrefix(absolute, cwd)
        ? absolute.slice(cwd.length).replace(/^[/\\]+/, '')
        : null;
      const tab = mutate(sessionId, (state) => {
        state.cwd = cwd;
        state.palette.open = false;
        state.find = { open: false, query: '', hits: [], index: 0 };
        state.pending = null;
        const entry = pushTab(state, absolute, relative, null, null);
        entry.error = null;
        entry.requestedPath = requested;
        state.notice = null;
        state.tab = options?.view ?? 'preview';
        trace(state, 'link', { requested, absolute });
        return entry;
      });
      await loadFile(sessionId, tab.id);
      void Promise.all([loadDiff(sessionId, tab.id), loadChanges(sessionId)]);
      if (cwd !== null && sessionState(sessionId).tree[cwd] === undefined) void loadTree(sessionId, cwd);
    }

    async function openFile(sessionId, path, options) {
      if (sessionId === null || sessionId === undefined) return;
      ensureStyles();
      const normalized = lexicalNormalize(String(path ?? ''));
      if (normalized.length === 0) return;
      if (runtime.visible !== true || runtime.owner !== sessionId) {
        runtime.visible = true;
        if (panelContext !== null) {
          const facts = sessionFacts(panelContext);
          mutate(sessionId, (state) => { if (state.cwd === null) state.cwd = facts.cwd });
          applyPanelHost(panelContext, sessionId);
        }
      }
      const cwd = options?.cwd ?? sessionState(sessionId).cwd;
      const stat = await callHost('stat', { path: normalized, cwd }).catch(() => null);
      if (stat === null) {
        refuseOpen(sessionId, { kind: 'missing', path: normalized, requested: normalized, at: Date.now() });
        return;
      }
      if (stat.isDirectory === true) {
        mutate(sessionId, (state) => {
          state.pending = null;
          state.notice = null;
          state.tab = 'files';
        });
        await loadTree(sessionId, normalized);
        return;
      }
      const tab = mutate(sessionId, (state) => {
        state.pending = null;
        state.notice = null;
        const entry = pushTab(state, normalized, options?.relativePath ?? null, null, options?.key ?? null);
        entry.error = null;
        entry.requestedPath = normalized;
        state.error = null;
        // Opening a file is an explicit navigation: land on the file itself.
        state.tab = options?.tab ?? 'preview';
        trace(state, 'openFile', { id: entry.id, path: entry.path });
        return entry;
      });
      await loadFile(sessionId, tab.id);
      void Promise.all([loadDiff(sessionId, tab.id), loadChanges(sessionId)]);
      if (options?.findLine !== undefined) {
        mutate(sessionId, (state) => {
          state.tab = state.tab === 'edit' ? 'edit' : 'preview';
          state.find = { open: true, query: '', hits: [], index: 0 };
        });
        window.setTimeout(() => {
          const rows = document.querySelectorAll('.dfp-surface [class*="_line"]');
          rows[Math.max(0, (options.findLine ?? 1) - 1)]?.scrollIntoView({ block: 'center' });
        }, 250);
      }
    }

    async function loadFile(sessionId, tabId) {
      const state = sessionState(sessionId);
      const tab = tabId === undefined ? activeTab(state) : findTabById(state, tabId);
      if (tab === null) return;
      const target = tab.path;
      const seq = (tab.loadSeq ?? 0) + 1;
      mutate(sessionId, (s) => {
        const current = findTabById(s, tab.id);
        if (current !== null) {
          current.loadSeq = seq;
          current.loading = true;
          current.error = null;
        }
      });
      try {
        const file = await callHost('file', { path: target, cwd: state.cwd });
        mutate(sessionId, (s) => {
          const current = findTabById(s, tab.id);
          if (current === null) return;
          // A newer request for this tab already answered: this one is stale.
          if (current.loadSeq !== seq) return;
          current.file = file;
          current.relativePath = file.relativePath ?? current.relativePath;
          current.name = basename(file.canonicalPath ?? current.path);
          if (typeof file.canonicalPath === 'string' && file.canonicalPath.length > 0) {
            // The tab carries the true spelling from here on: it is the identity
            // the next open of this file will be compared against.
            current.key = file.canonicalPath;
            current.path = file.canonicalPath;
          }
          // Two spellings of one file converge here: keep the tab that has the
          // data, retire the other, and leave the selection on a real tab.
          const duplicate = s.tabs.findIndex((entry) => entry !== current && sameFilePath(entry, current));
          if (duplicate !== -1) {
            const activeId = activeTab(s)?.id ?? null;
            s.tabs.splice(duplicate, 1);
            const nextActive = s.tabs.findIndex((entry) => entry.id === activeId);
            s.active = nextActive === -1 ? s.tabs.indexOf(current) : nextActive;
            trace(s, 'tab-merged', { kept: current.path, dropped: duplicate });
          }
          current.lines = file.binary === true ? [] : linesOf(file.content);
          current.view = viewFor(file);
          current.loading = false;
          current.stale = false;
          if (current.editor !== null) {
            current.editor.baseSha = file.sha256;
            current.editor.baseText = file.content;
          }
          trace(s, 'loaded', { id: current.id, path: current.path, lines: file.lines ?? 0 });
        });
      } catch (error) {
        mutate(sessionId, (s) => {
          const current = findTabById(s, tab.id);
          if (current === null) return;
          if (current.loadSeq !== seq) return;
          current.loading = false;
          current.error = error.message;
          current.file = null;
          trace(s, 'load-failed', { id: current.id, path: current.path, message: error.message });
        });
      }
    }

    async function loadDiff(sessionId, tabId) {
      const state = sessionState(sessionId);
      const tab = tabId === undefined ? activeTab(state) : findTabById(state, tabId);
      if (tab === null) return;
      const target = tab.path;
      mutate(sessionId, (s) => {
        const current = findTabById(s, tab.id);
        if (current !== null) current.loadingDiff = true;
      });
      try {
        const diff = await callHost('diff', { path: target, cwd: state.cwd, sessionId });
        mutate(sessionId, (s) => {
          const current = findTabById(s, tab.id);
          if (current === null) return;
          current.diff = diff;
          current.loadingDiff = false;
          current.pendingRevert = null;
          current.diffError = null;
        });
      } catch (error) {
        mutate(sessionId, (s) => {
          const current = findTabById(s, tab.id);
          if (current === null) return;
          current.loadingDiff = false;
          current.diffError = error.message;
        });
      }
    }

    async function loadChanges(sessionId) {
      const state = sessionState(sessionId);
      mutate(sessionId, (s) => { s.loadingChanges = true });
      try {
        const payload = await callHost('changes', { sessionId, cwd: state.cwd });
        const byRelative = {};
        for (const file of payload.files ?? []) {
          byRelative[file.relativePath ?? file.path] = file;
          byRelative[file.path] = file;
        }
        mutate(sessionId, (s) => { s.changes = { files: payload.files ?? [], byRelative } });
      } catch (error) {
        console.warn('[dsh-file-panel] changes failed:', error.message);
      } finally {
        mutate(sessionId, (s) => { s.loadingChanges = false });
      }
    }

    async function loadTree(sessionId, directory) {
      const state = sessionState(sessionId);
      mutate(sessionId, (s) => { s.loadingTree[directory] = true });
      try {
        const payload = await callHost('tree', { path: directory, cwd: state.cwd });
        mutate(sessionId, (s) => { s.tree[directory] = payload.entries });
      } catch (error) {
        mutate(sessionId, (s) => {
          s.tree[directory] = [];
          const current = activeTab(s);
          if (current !== null) current.error = error.message;
        });
      }
    }

    async function refresh(sessionId) {
      const tab = activeTab(sessionState(sessionId));
      await loadFile(sessionId, tab?.id);
      void Promise.all([loadDiff(sessionId, tab?.id), loadChanges(sessionId)]);
    }

    async function saveEditor(sessionId) {
      const state = sessionState(sessionId);
      const tab = activeTab(state);
      if (tab === null || tab.editor === null) return;
      const target = tab.path;
      mutate(sessionId, (s) => {
        const current = findTabById(s, tab.id);
        if (current?.editor != null) {
          current.editor.saving = true;
          current.editor.error = null;
        }
      });
      try {
        const result = await postHost('write', { path: target, cwd: state.cwd, content: tab.editor.text, expectedSha256: tab.editor.baseSha });
        mutate(sessionId, (s) => {
          const current = findTabById(s, tab.id);
          if (current?.editor == null) return;
          current.editor.saving = false;
          current.editor.dirty = false;
          current.editor.baseSha = result.sha256;
          current.editor.baseText = current.editor.text;
          current.savedAt = Date.now();
          current.stale = false;
        });
        await refresh(sessionId);
      } catch (error) {
        mutate(sessionId, (s) => {
          const current = findTabById(s, tab.id);
          if (current?.editor == null) return;
          current.editor.saving = false;
          current.editor.error = error.code === 'stale' ? 'file changed on disk — reopen the file' : error.message;
        });
      }
    }

    async function revertHunk(sessionId, index) {
      const state = sessionState(sessionId);
      const tab = activeTab(state);
      if (tab === null || tab.diff === null) return;
      const hunk = tab.diff.hunks[index];
      if (hunk === undefined) return;
      const target = tab.path;
      try {
        await postHost('revert', {
          path: target,
          cwd: state.cwd,
          oldText: hunk.oldText,
          newText: hunk.newText,
          expectedSha256: tab.file?.sha256
        });
        await refresh(sessionId);
        mutate(sessionId, (s) => {
          const current = findTabById(s, tab.id);
          if (current !== null) {
            current.pendingRevert = null;
            current.reverted = { ...(current.reverted ?? {}), [hunkSignature(hunk)]: true };
          }
        });
      } catch (error) {
        mutate(sessionId, (s) => {
          const current = findTabById(s, tab.id);
          if (current !== null) {
            current.diffError = error.message;
            current.pendingRevert = null;
          }
        });
        await refresh(sessionId);
      }
    }

    /** Apply every recorded hunk's inverse in one guarded write. */
    async function revertAllForPath(sessionId, path) {
      const state = sessionState(sessionId);
      const record = state.changes?.files?.find((file) => file.path === path);
      if (record === undefined) return;
      try {
        const file = await callHost('file', { path, cwd: state.cwd });
        let content = file.content;
        for (const hunk of [...record.hunks].reverse()) {
          const newText = hunk.newText ?? '';
          if (newText.length === 0) continue;
          const at = content.indexOf(newText);
          if (at === -1) continue;
          content = content.slice(0, at) + (hunk.oldText ?? '') + content.slice(at + newText.length);
        }
        await postHost('write', { path, cwd: state.cwd, content, expectedSha256: file.sha256 });
        await refresh(sessionId);
        await loadChanges(sessionId);
      } catch (error) {
        console.warn('[dsh-file-panel] revert file failed:', error.message);
        mutate(sessionId, (s) => {
          const current = activeTab(s);
          if (current !== null) current.diffError = error.message;
        });
      }
    }

    async function openExternally(ctx, tab) {
      if (tab === null) return;
      try {
        if (originalOpenWorkspacePath !== null) {
          await originalOpenWorkspacePath({ path: tab.path }, new AbortController().signal);
          return;
        }
        await ctx.remote.session.openWorkspacePath({ path: tab.path });
      } catch (error) {
        console.warn('[dsh-file-panel] external open failed:', error?.message ?? error);
      }
    }

    function selectView(ctx, sessionId, view) {
      mutate(sessionId, (s) => {
        s.tab = view;
        s.palette.open = false;
      });
      const state = sessionState(sessionId);
      if (view === 'changes' && activeTab(state)?.diff === null) void loadDiff(sessionId);
      if (view === 'changes') {
        const width = document.querySelector('.dfp-root')?.getBoundingClientRect().width ?? 0;
        const tab = activeTab(state);
        if (tab !== null && width > 0 && width < 430 && tab.diffModeUserSet !== true) tab.diffMode = 'inline';
      }
      if (view === 'review' || view === 'files') void loadChanges(sessionId);
      if (view === 'files' && state.cwd !== null && state.tree[state.cwd] === undefined) void loadTree(sessionId, state.cwd);
      if (view === 'preview') {
        const tab = activeTab(state);
        if (tab !== null && tab.file === null && tab.loading !== true && tab.error === null) void loadFile(sessionId, tab.id);
      }
      if (view === 'edit' && activeTab(state)?.file === null) void loadFile(sessionId);
    }

    function setFind(sessionId, queryText) {
      mutate(sessionId, (s) => {
        const tab = activeTab(s);
        const hits = [];
        if (tab?.lines != null && queryText.length > 0) {
          const needle = queryText.toLowerCase();
          tab.lines.forEach((line, index) => {
            if (line.toLowerCase().includes(needle)) hits.push(index + 1);
          });
        }
        s.find = { open: true, query: queryText, hits: hits.slice(0, 500), index: 0 };
      });
    }

    function stepFind(sessionId, delta) {
      mutate(sessionId, (s) => {
        if (s.find.hits.length === 0) return;
        s.find.index = (s.find.index + delta + s.find.hits.length) % s.find.hits.length;
      });
    }

    function openPalette(sessionId, kind) {
      mutate(sessionId, (s) => {
        s.palette = { open: true, kind: kind === 'content' ? 'content' : 'files', query: '', results: [], loading: false, index: 0 };
      });
      void runPalette(sessionId, '');
    }

    function closePalette(sessionId) {
      mutate(sessionId, (s) => { s.palette.open = false });
    }

    async function runPalette(sessionId, queryText) {
      const state = sessionState(sessionId);
      const kind = state.palette.kind;
      const token = (paletteToken += 1);
      mutate(sessionId, (s) => {
        s.palette.query = queryText;
        s.palette.loading = true;
      });
      try {
        const payload = await callHost('search', { cwd: state.cwd, q: queryText, kind, limit: 60 });
        if (token !== paletteToken) return;
        mutate(sessionId, (s) => {
          s.palette.results = payload.matches ?? [];
          s.palette.index = 0;
          s.palette.loading = false;
        });
      } catch (error) {
        if (token !== paletteToken) return;
        mutate(sessionId, (s) => {
          s.palette.loading = false;
          s.palette.results = [];
        });
        console.warn('[dsh-file-panel] search failed:', error.message);
      }
    }

    function handleKey(event, ctx, sessionId) {
      const mod = event.metaKey || event.ctrlKey;
      const key = String(event.key).toLowerCase();
      if (key === 'escape') {
        const state = sessionState(sessionId);
        if (state.palette.open === true) {
          event.preventDefault();
          closePalette(sessionId);
          return;
        }
        if (state.find.open === true) {
          event.preventDefault();
          mutate(sessionId, (s) => { s.find.open = false });
          return;
        }
        event.preventDefault();
        closePanel(ctx);
        return;
      }
      if (!mod) return;
      if (key === 's') {
        event.preventDefault();
        void saveEditor(sessionId);
      } else if (key === 'f' && event.shiftKey) {
        event.preventDefault();
        openPalette(sessionId, 'content');
      } else if (key === 'f') {
        event.preventDefault();
        mutate(sessionId, (s) => { s.find.open = true });
      } else if (key === 'p') {
        event.preventDefault();
        openPalette(sessionId, 'files');
      } else if (key === 'w') {
        event.preventDefault();
        closeTab(sessionId, sessionState(sessionId).active);
      }
    }

    function startPolling(ctx) {
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(async () => {
        if (runtime.visible !== true || runtime.owner === null) return;
        const sessionId = runtime.owner;
        const state = sessionState(sessionId);
        // A resolution that never answered must not leave "Opening …" on screen
        // forever: the banner is a promise, so it expires like one.
        if (state.pending !== null && Date.now() - (state.pending.since ?? 0) > 8000) {
          const stale = state.pending.path;
          mutate(sessionId, (s) => { s.pending = null });
          console.warn('[dsh-file-panel] resolution timed out for', stale);
        }
        const tab = activeTab(state);
        if (tab === null || tab.path === null) return;
        try {
          const stat = await callHost('stat', { path: tab.path, cwd: state.cwd });
          const known = tab.file?.mtimeMs ?? 0;
          if (stat.mtimeMs !== known) {
            if (tab.editor !== null && tab.editor.dirty === true) {
              mutate(sessionId, (s) => {
                const current = findTabById(s, tab.id);
                if (current !== null) current.stale = true;
              });
            } else {
              await refresh(sessionId);
            }
          }
        } catch {
          /* transient */
        }
      }, POLL_INTERVAL_MS);
    }

    function apply(ctx) {
      ensureStyles();
      ensureToggleHost();
      panelContext = ctx; // eslint-disable-line no-unused-expressions
      // Ask the host what its paths look like; a Windows harness answers `\\`.
      void callHost('health', {}).then((value) => {
        const separator = value?.platform?.separator;
        if (typeof separator === 'string' && separator.length === 1) pathSeparator = separator;
      }).catch(() => {});
      installLayoutYield(ctx);
      const wrapped = installOpenerInterceptor(ctx);
      if (wrapped !== true) console.warn('[dsh-file-panel] opener not wrapped; file links keep opening externally');
      watchSessions(ctx);
      startPolling(ctx);
      window.addEventListener('keydown', (event) => {
        // ⌥⌘F (Ctrl+Alt+F off macOS) toggles the panel from anywhere.
        if (event.altKey === true && (event.metaKey === true || event.ctrlKey === true) && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          togglePanel(ctx);
        }
      }, true);
      window.addEventListener('resize', () => {
        if (runtime.visible === true && runtime.owner !== null && panelContext !== null) {
          applyPanelHost(panelContext, runtime.owner);
        }
      });
      const ownerOrCurrent = () => runtime.owner ?? currentSessionId(ctx);
      window.__dshFilePanel = {
        open: (path, options) => openPath(ctx, path, options),
        close: () => closePanel(ctx),
        refresh: () => refresh(ownerOrCurrent()),
        openFile: (sessionId, path, options) => openFile(sessionId, path, options),
        callHost: (route, params) => callHost(route, params),
        postHost: (route, body) => postHost(route, body),
        state: (sessionId) => {
          const id = sessionId ?? ownerOrCurrent();
          const state = id === null || id === undefined ? null : sessionStates.get(id) ?? null;
          if (state === null) return { visible: runtime.visible, owner: runtime.owner, tabs: [], tab: null };
          const tab = activeTab(state);
          return {
            visible: runtime.visible,
            owner: runtime.owner,
            sessionId: state.id,
            tab: state.tab,
            tabs: state.tabs.map((entry) => entry.name),
            active: state.active,
            path: tab?.path ?? null,
            relativePath: tab?.relativePath ?? null,
            loaded: tab?.file !== null && tab?.file !== undefined,
            lines: tab?.file?.lines ?? 0,
            error: tab?.error ?? null,
            view: tab?.view ?? null,
            diff: tab?.diff ?? null,
            loadingDiff: tab?.loadingDiff ?? false,
            find: state.find,
            palette: { open: state.palette.open, kind: state.palette.kind, results: state.palette.results.length, index: state.palette.index, query: state.palette.query },
            pending: state.pending,
            notice: state.notice,
            build: CLIENT_BUILD,
            events: state.events.slice(-40),
            changes: state.changes?.files?.length ?? 0,
            notes: state.notes.length,
            editor: tab?.editor ?? null,
            savedAt: tab?.savedAt ?? null,
            stale: tab?.stale ?? false,
            selected: tab?.selected ?? null,
            review: Object.keys(state.review).length
          };
        },
        debug: {
          ctx: () => panelContext,
          canShowPanel: () => canShowPanel(panelContext),
          seatMounted: () => seatMountedFor !== null,
          seatOwner: () => runtime.owner,
          hostMode: () => runtime.mode,
          dockInDom: () => document.querySelector('.dfp-root[data-dock="true"]') !== null,
          dockDragging: () => dockDragging,
          dockMoves: () => dockMoves,
          setDockWidth: (px) => { runtime.dockWidth = Math.max(300, Math.min(760, Math.round(px))); notify(); return runtime.dockWidth },
          dockRect: () => { const node = document.querySelector('.dfp-root[data-dock="true"]'); if (node === null) return null; const box = node.getBoundingClientRect(); return { x: Math.round(box.x), w: Math.round(box.width), h: Math.round(box.height) } },
          columnFits: () => columnFits(),
          dockWidth: () => runtime.dockWidth,
          haveOpener: () => originalOpenWorkspacePath !== null,
          primitives: () => primitives !== null,
          primitiveKeys: () => (primitives === null ? [] : Object.keys(primitives)),
          layout: () => layoutService,
          setIntercept: (value) => { interceptEnabled = value === true },
          openPalette: (kind) => openPalette(ownerOrCurrent(), kind),
          setPaletteQuery: (text) => runPalette(ownerOrCurrent(), text),
          setFind: (text) => setFind(ownerOrCurrent(), text),
          stepFind: (delta) => stepFind(ownerOrCurrent(), delta),
          revertHunk: (index) => revertHunk(ownerOrCurrent(), index),
          revertAll: (path) => revertAllForPath(ownerOrCurrent(), path),
          selectTab: (index) => activateTab(ownerOrCurrent(), index),
          resetTabs: () => mutate(ownerOrCurrent(), (s) => { s.tabs = []; s.active = 0; s.tab = 'files' }),
          closePanel: () => closePanel(ctx),
          tabs: () => sessionState(ownerOrCurrent()).tabs.map((tab) => ({
            name: tab.name,
            path: tab.path,
            key: tab.key,
            relativePath: tab.relativePath,
            loading: tab.loading === true,
            loaded: tab.file !== null && tab.file !== undefined,
            view: tab.view,
            error: tab.error,
            requestedPath: tab.requestedPath,
            id: tab.id
          }))
        }
      };
      console.log(`[dsh-file-panel] ready ${CLIENT_BUILD}`, { wrapped, primitives: primitives !== null });
      // Announce arrival and then keep reporting while the panel is on screen.
      reportDiag('loaded', true);
      window.setTimeout(() => reportDiag('settled', true), 2500);
      window.setInterval(() => {
        if (runtime.visible === true) reportDiag('heartbeat', true);
      }, 15000);
    }

    const inject = ['slots', 'sessions', 'layout', 'remote', 'remote.session'];

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
