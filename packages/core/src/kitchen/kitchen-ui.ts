/**
 * Kitchen UI - Inline HTML/CSS/JS for the dev dashboard.
 *
 * Phase 1 MVP: Single-page dashboard with three panels.
 * No build step required — pure inline vanilla JS.
 */

export function renderKitchenHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mandu Kitchen</title>
  <style>${CSS}</style>
</head>
<body>
  <div class="app-shell">
    <header class="hero">
      <div class="hero-copy">
        <div class="hero-kicker">Mandu Dev Console</div>
        <div class="logo">
          <span class="logo-text">Mandu Kitchen</span>
          <span class="logo-badge">live</span>
        </div>
        <p class="hero-subtitle">Routes, architecture, live activity, file changes, and contract checks for the current dev session.</p>
      </div>
      <div class="hero-side">
        <a class="hero-link" href="/" target="_blank" rel="noreferrer">Open app</a>
        <div class="status-pill">
          <span id="sse-status" class="status-dot disconnected"></span>
          <span id="sse-label">Connecting...</span>
        </div>
      </div>
    </header>

    <section class="overview">
      <div class="metric-card">
        <span class="metric-label">Activity</span>
        <strong id="metric-activity" class="metric-value">0</strong>
      </div>
      <div class="metric-card">
        <span class="metric-label">Routes</span>
        <strong id="metric-routes" class="metric-value">...</strong>
      </div>
      <div class="metric-card">
        <span class="metric-label">Guard</span>
        <strong id="metric-guard" class="metric-value">...</strong>
      </div>
      <div class="metric-card">
        <span class="metric-label">Changes</span>
        <strong id="metric-changes" class="metric-value">...</strong>
      </div>
      <div class="metric-card">
        <span class="metric-label">Contracts</span>
        <strong id="metric-contracts" class="metric-value">...</strong>
      </div>
    </section>

    <nav class="tabs">
      <button class="tab" data-panel="activity">Activity</button>
      <button class="tab" data-panel="agent">Agent</button>
      <button class="tab active" data-panel="routes">Routes</button>
      <button class="tab" data-panel="guard">Guard</button>
      <button class="tab" data-panel="preview">Preview</button>
      <button class="tab" data-panel="contracts">Contracts</button>
      <button class="tab" data-panel="requests">Requests</button>
      <button class="tab" data-panel="mcp-activity">MCP</button>
      <button class="tab" data-panel="cache">Cache</button>
      <button class="tab" data-panel="metrics">Metrics</button>
    </nav>

    <main class="panels">
      <section id="panel-activity" class="panel">
        <div class="panel-header">
          <div>
            <h2>Activity Stream</h2>
            <p class="panel-subtitle">Recent Kitchen events and MCP activity.</p>
          </div>
          <button id="clear-activity" class="btn-sm">Clear</button>
        </div>
        <div id="activity-list" class="activity-list">
          <div class="empty-state">Waiting for MCP activity...</div>
        </div>
      </section>

      <section id="panel-agent" class="panel">
        <div class="panel-header">
          <div>
            <h2>Agent Supervisor</h2>
            <p class="panel-subtitle">Situation brief, tool routing, prompt pack, and next safe action for supervised agents.</p>
          </div>
          <button id="refresh-agent" class="btn-sm">Refresh</button>
        </div>
        <div id="agent-content" class="agent-content">
          <div class="empty-state">Open Agent to build a context pack.</div>
        </div>
      </section>

      <section id="panel-routes" class="panel active">
        <div class="panel-header">
          <div>
            <h2>Routes</h2>
            <p class="panel-subtitle">Current filesystem routes, slots, contracts, and hydration hints.</p>
          </div>
          <div id="routes-summary" class="summary"></div>
        </div>
        <div id="routes-list" class="routes-list">
          <div class="empty-state">Loading routes...</div>
        </div>
      </section>

      <section id="panel-guard" class="panel">
        <div class="panel-header">
          <div>
            <h2>Architecture Guard</h2>
            <p class="panel-subtitle">Run a scan and inspect dependency rule violations.</p>
          </div>
          <button id="scan-guard" class="btn-sm">Scan</button>
        </div>
        <div id="guard-status" class="guard-status"></div>
        <div id="guard-list" class="violations-list">
          <div class="empty-state">Click "Scan" to check architecture rules.</div>
        </div>
      </section>

      <section id="panel-preview" class="panel">
        <div class="panel-header">
          <div>
            <h2>Preview</h2>
            <p class="panel-subtitle">Inspect changed files and open diffs without leaving Kitchen.</p>
          </div>
          <button id="refresh-changes" class="btn-sm">Refresh</button>
        </div>
        <div id="preview-list" class="preview-list">
          <div class="empty-state">Loading file changes...</div>
        </div>
        <div id="preview-diff" class="preview-diff" style="display:none;"></div>
      </section>

      <section id="panel-contracts" class="panel">
        <div class="panel-header">
          <div>
            <h2>Contracts</h2>
            <p class="panel-subtitle">Browse route contracts and validate payloads in place.</p>
          </div>
          <div class="panel-actions">
            <button id="export-openapi-json" class="btn-sm">Export JSON</button>
            <button id="export-openapi-yaml" class="btn-sm">Export YAML</button>
          </div>
        </div>
        <div class="contracts-layout">
          <div id="contracts-list" class="contracts-list">
            <div class="empty-state">Loading contracts...</div>
          </div>
          <div id="contracts-detail" class="contracts-detail">
            <div id="contract-schema" class="contract-schema"></div>
            <div id="contract-playground" class="contract-playground">
              <h3>Validate</h3>
              <div class="playground-controls">
                <select id="validate-method" class="select-sm">
                  <option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option>
                </select>
                <button id="validate-btn" class="btn-sm">Validate</button>
              </div>
              <div class="playground-inputs">
                <label>Query <textarea id="validate-query" rows="2" placeholder='{"key":"value"}'></textarea></label>
                <label>Body <textarea id="validate-body" rows="3" placeholder='{"key":"value"}'></textarea></label>
                <label>Params <textarea id="validate-params" rows="2" placeholder='{"id":"1"}'></textarea></label>
              </div>
              <div id="validate-result" class="validate-result"></div>
            </div>
          </div>
        </div>
      </section>

      <section id="panel-requests" class="panel">
        <div class="panel-header">
          <div>
            <h2>Requests</h2>
            <p class="panel-subtitle">Recent HTTP requests. Click a row to see correlation-linked events.</p>
          </div>
          <button id="refresh-requests" class="btn-sm">Refresh</button>
        </div>
        <div id="requests-list" class="requests-list">
          <div class="empty-state">Loading requests...</div>
        </div>
        <div id="requests-detail" class="requests-detail" style="display:none;"></div>
      </section>

      <section id="panel-mcp-activity" class="panel">
        <div class="panel-header">
          <div>
            <h2>MCP Activity</h2>
            <p class="panel-subtitle">Recent MCP tool calls from the EventBus, grouped by correlation.</p>
          </div>
          <button id="refresh-mcp" class="btn-sm">Refresh</button>
        </div>
        <div id="mcp-list" class="mcp-list">
          <div class="empty-state">Loading MCP activity...</div>
        </div>
      </section>

      <section id="panel-cache" class="panel">
        <div class="panel-header">
          <div>
            <h2>Cache</h2>
            <p class="panel-subtitle">ISR/SWR cache store statistics.</p>
          </div>
          <button id="refresh-cache" class="btn-sm">Refresh</button>
        </div>
        <div id="cache-content" class="cache-content">
          <div class="empty-state">Loading cache stats...</div>
        </div>
      </section>

      <section id="panel-metrics" class="panel">
        <div class="panel-header">
          <div>
            <h2>Metrics</h2>
            <p class="panel-subtitle">Rolling 5-minute window over all observability events.</p>
          </div>
          <button id="refresh-metrics" class="btn-sm">Refresh</button>
        </div>
        <div id="metrics-content" class="metrics-content">
          <div class="empty-state">Loading metrics...</div>
        </div>
      </section>
    </main>

    <div id="debug-bar" class="debug-bar"></div>
  </div>

  <script>${JS}</script>
</body>
</html>`;
}

// ─── CSS ─────────────────────────────────────────

const CSS = /* css */ `
  * { margin: 0; padding: 0; box-sizing: border-box; }

  /*
   * Plan 18 DA-1 — the legacy dark-tool palette below is intentionally
   * redirected to the Stitch tokens defined at the bottom of this file.
   * Component layout / spacing / interaction is preserved; only the
   * literal colors and the font family swap. The :root block (later in
   * the cascade) wins, so any later override stays effective.
   */

  body.legacy-dark-tool-shell, /* kept as a hook for future toggle */
  body {
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
    background: var(--bg, #FFFDF5);
    color: var(--ink, #4A3222);
    min-height: 100vh;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    background: var(--surface-strong, #FBF6EC);
    border-bottom: 1px solid var(--line, #4A3222);
  }

  .logo {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 18px;
    font-weight: 700;
    font-family: var(--font-display, var(--font-sans));
  }

  .logo-icon { font-size: 24px; }

  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    color: var(--muted, #7A6B5D);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    transition: background 0.3s;
  }

  .status-dot.connected { background: var(--success, #6B9E47); }
  .status-dot.disconnected { background: var(--danger, #C85450); }
  .status-dot.connecting { background: var(--warning, #E8A93A); }

  .tabs {
    display: flex;
    gap: 0;
    background: var(--surface-strong, #FBF6EC);
    border-bottom: 1px solid var(--line, #4A3222);
    padding: 0 20px;
  }

  .tab {
    padding: 10px 20px;
    background: none;
    border: none;
    color: var(--muted, #7A6B5D);
    font-size: 14px;
    font-family: var(--font-sans);
    font-weight: 500;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: all 0.2s;
  }

  .tab:hover { color: var(--ink, #4A3222); }
  .tab.active {
    color: var(--accent, #FF8C66);
    border-bottom-color: var(--accent, #FF8C66);
    font-weight: 700;
  }

  .panels { padding: 16px 20px; }

  .panel { display: none; }
  .panel.active { display: block; }

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }

  .panel-header h2 {
    font-size: 16px;
    font-weight: 600;
  }

  /*
   * Stitch primary button — hard shadow + bold + larger radius.
   * Hover lifts: shadow 0 + translate so the surface "presses" into the
   * shadow slot. Mirrors the .btn-hard pattern in mandujs.com globals.css.
   */
  .btn-sm {
    padding: 6px 14px;
    background: var(--surface);
    border: 2px solid var(--ink);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-sm);
    color: var(--ink);
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
    transition: transform 150ms ease, box-shadow 150ms ease, background 0.2s;
  }

  .btn-sm:hover {
    background: var(--accent-soft);
    box-shadow: none;
    transform: translate(2px, 2px);
  }
  .btn-sm:active {
    box-shadow: none;
    transform: translate(2px, 2px);
  }
  .btn-sm:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    box-shadow: var(--shadow-sm);
    transform: none;
  }

  .empty-state {
    padding: 40px 20px;
    text-align: center;
    color: var(--muted);
    font-size: 14px;
  }

  /* Activity */
  .activity-list {
    max-height: calc(100vh - 180px);
    overflow-y: auto;
  }

  .activity-item {
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
    font-family: var(--font-mono);
    display: flex;
    gap: 10px;
    align-items: flex-start;
    animation: fadeIn 0.3s ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .activity-time {
    color: var(--muted);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .activity-tool {
    color: var(--accent);
    font-weight: 500;
    flex-shrink: 0;
  }

  .activity-detail {
    color: var(--muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Routes */
  .summary {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: var(--muted);
  }

  .summary-item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .summary-count {
    font-weight: 600;
    color: var(--ink);
  }

  .route-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }

  .route-kind {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    flex-shrink: 0;
    min-width: 44px;
    text-align: center;
  }

  .route-kind.page { background: rgba(74, 144, 194, 0.15); color: var(--info); }
  .route-kind.api { background: rgba(107, 158, 71, 0.18); color: var(--success); }

  .route-pattern {
    font-family: var(--font-mono);
    color: var(--ink);
    flex: 1;
  }

  .route-badges {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }

  .badge {
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    background: var(--surface-alt);
    color: var(--muted);
  }

  /* Guard */
  .guard-status {
    margin-bottom: 12px;
    font-size: 13px;
    color: var(--muted);
  }

  .guard-summary {
    display: flex;
    gap: 16px;
    padding: 12px;
    background: var(--surface-strong);
    border-radius: 8px;
    margin-bottom: 12px;
  }

  .guard-stat {
    text-align: center;
  }

  .guard-stat-value {
    font-size: 24px;
    font-weight: 700;
  }

  .guard-stat-label {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
  }

  .sev-error { color: var(--danger); }
  .sev-warning { color: var(--warning); }
  .sev-info { color: var(--info); }

  .violation-item {
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
  }

  .violation-file {
    font-family: var(--font-mono);
    color: var(--accent);
    margin-bottom: 2px;
  }

  .violation-msg {
    color: var(--muted);
    font-size: 12px;
  }

  .violation-sev {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    margin-right: 4px;
  }

  .violation-sev.error { background: rgba(200, 84, 80, 0.18); color: var(--danger); }
  .violation-sev.warning { background: rgba(232, 169, 58, 0.20); color: var(--warning); }
  .violation-sev.info { background: rgba(74, 144, 194, 0.18); color: var(--info); }

  /* Preview */
  .preview-list { max-height: 40vh; overflow-y: auto; }
  .preview-diff { max-height: 50vh; overflow-y: auto; padding: 8px; }

  .change-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--line);
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s;
  }
  .change-item:hover { background: var(--surface-alt); }
  .change-icon { flex-shrink: 0; }
  .change-path {
    font-family: var(--font-mono);
    color: var(--ink);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .change-status {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    text-transform: uppercase;
    font-weight: 600;
    flex-shrink: 0;
  }
  .change-status.added { background: rgba(107, 158, 71, 0.18); color: var(--success); }
  .change-status.modified { background: rgba(74, 144, 194, 0.15); color: var(--info); }
  .change-status.deleted { background: rgba(200, 84, 80, 0.18); color: var(--danger); }
  .change-status.untracked { background: rgba(232, 169, 58, 0.20); color: var(--warning); }
  .change-status.renamed { background: var(--accent-soft); color: var(--accent); }

  .diff-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 8px 12px; background: var(--surface-strong); border-radius: 6px 6px 0 0;
    border-bottom: 1px solid var(--surface-alt);
  }
  .diff-file { font-family: monospace; color: var(--accent); font-size: 13px; }
  .diff-stats { font-size: 12px; }
  .diff-add { color: var(--success); margin-right: 8px; }
  .diff-del { color: var(--danger); }
  .diff-hunk-header { padding: 4px 12px; background: rgba(74, 144, 194, 0.18); color: var(--info); font-size: 12px; font-family: monospace; }
  .diff-line { display: flex; font-family: monospace; font-size: 12px; line-height: 20px; }
  .diff-line-num { width: 40px; text-align: right; padding: 0 4px; color: var(--muted); user-select: none; flex-shrink: 0; }
  .diff-line-content { flex: 1; padding: 0 8px; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
  .diff-line.add { background: rgba(74,222,128,0.08); }
  .diff-line.add .diff-line-content::before { content: '+'; color: var(--success); }
  .diff-line.remove { background: rgba(239,68,68,0.08); }
  .diff-line.remove .diff-line-content::before { content: '-'; color: var(--danger); }
  .diff-line.context .diff-line-content::before { content: ' '; }

  /* Contracts */
  .contracts-layout { display: flex; gap: 12px; height: calc(100vh - 180px); }
  .contracts-list { width: 300px; flex-shrink: 0; overflow-y: auto; border-right: 1px solid var(--surface-alt); padding-right: 12px; }
  .contracts-detail { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; }

  .contract-item {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; border-bottom: 1px solid var(--line);
    cursor: pointer; transition: background 0.15s; font-size: 13px;
  }
  .contract-item:hover { background: var(--surface-alt); }
  .contract-item.selected { background: var(--surface-alt); border-left: 2px solid var(--accent); }

  .method-badge {
    display: inline-block; padding: 1px 6px; border-radius: 3px;
    font-size: 10px; font-weight: 600; text-transform: uppercase;
    flex-shrink: 0; min-width: 36px; text-align: center;
  }
  .method-badge.get { background: rgba(107, 158, 71, 0.18); color: var(--success); }
  .method-badge.post { background: rgba(74, 144, 194, 0.15); color: var(--info); }
  .method-badge.put { background: rgba(232, 169, 58, 0.20); color: var(--warning); }
  .method-badge.patch { background: var(--accent-soft); color: var(--accent); }
  .method-badge.delete { background: rgba(200, 84, 80, 0.18); color: var(--danger); }

  .contract-pattern { font-family: monospace; color: var(--ink); }

  .contract-schema {
    background: var(--surface-strong); border-radius: 8px; padding: 12px;
    font-family: monospace; font-size: 12px; white-space: pre-wrap;
    max-height: 40vh; overflow-y: auto;
  }

  .contract-playground { background: var(--surface-strong); border-radius: 8px; padding: 12px; }
  .contract-playground h3 { font-size: 14px; margin-bottom: 8px; }

  .playground-controls { display: flex; gap: 8px; margin-bottom: 8px; }
  .select-sm {
    padding: 4px 8px; background: var(--surface-alt); border: 1px solid var(--line);
    border-radius: 6px; color: var(--ink); font-size: 12px;
  }
  .playground-inputs { display: flex; flex-direction: column; gap: 6px; }
  .playground-inputs label { font-size: 11px; color: var(--muted); display: flex; flex-direction: column; gap: 2px; }
  .playground-inputs textarea {
    background: var(--surface-alt); border: 1px solid var(--line); border-radius: 4px;
    color: var(--ink); font-family: monospace; font-size: 12px; padding: 6px;
    resize: vertical;
  }
  .validate-result { margin-top: 8px; padding: 8px; border-radius: 4px; font-size: 12px; font-family: monospace; }
  .validate-result.success { background: rgba(107, 158, 71, 0.18); color: var(--success); }
  .validate-result.error { background: rgba(200, 84, 80, 0.18); color: var(--danger); }

  .debug-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 4px 12px;
    background: var(--bg);
    border-top: 1px solid var(--surface-alt);
    font-size: 11px;
    font-family: monospace;
    color: var(--muted);
    max-height: 60px;
    overflow-y: auto;
  }

  .debug-bar .err { color: var(--danger); }
  .debug-bar .ok { color: var(--success); }

  /*
   * Plan 18 DA-1 — token values aligned to mandujs.com Stitch system
   * (app/globals.css + tokens.css). Variable names stay the same so the
   * cascade with the legacy dark-mode block earlier in this file does
   * not break. Stitch identity: Peach #FF8C66 / Dark Brown #4A3222 /
   * Cream #FFFDF5 + hard shadow (blur 0).
   */
  :root {
    /* Page surfaces */
    --bg: #FFFDF5;                  /* mandujs.com --color-background (cream) */
    --bg-soft: rgba(255, 253, 245, 0.7);
    --surface: #FFFFFF;             /* --color-surface */
    --surface-strong: #FBF6EC;      /* --color-code-bg-light, slightly darker cream */
    --surface-alt: #F5F0E8;         /* --color-muted */

    /* Text */
    --ink: #4A3222;                 /* --color-foreground (dark brown, not black) */
    --muted: #7A6B5D;               /* --color-muted-foreground (warm gray) */
    --line: #4A3222;                /* --color-border (2px brown lines are Stitch) */

    /* Brand */
    --accent: #FF8C66;              /* --color-primary (peach) */
    --accent-strong: #FF7A4F;       /* --color-primary-hover */
    --accent-soft: rgba(255, 140, 102, 0.14);

    /* Semantic — docs-grade muted channels (tokens.css) */
    --success: #6B9E47;             /* olive green */
    --danger:  #C85450;             /* muted red-brown */
    --info:    #4A90C2;             /* calm blue */
    --warning: #E8A93A;             /* warm amber */

    /* Hard shadow (Stitch signature — blur 0, solid color block). The
     * standard variant is exposed as --shadow so existing references
     * inherit the new look without per-selector edits. */
    --shadow: 4px 4px 0 0 var(--ink);
    --shadow-sm: 2px 2px 0 0 var(--ink);
    --shadow-lg: 6px 6px 0 0 var(--ink);

    /* Radius scale — rounded & playful */
    --radius-sm: 0.5rem;
    --radius-md: 1rem;
    --radius-lg: 1.5rem;
    --radius-xl: 2rem;

    /* Typography */
    --font-sans: 'Pretendard Variable', 'Pretendard', 'Noto Sans JP', 'Noto Sans SC', ui-sans-serif, system-ui, sans-serif;
    --font-display: 'Nunito', 'Jua', 'Pretendard Variable', 'Pretendard', ui-sans-serif, system-ui, sans-serif;
    --font-mono: 'Consolas', 'Monaco', 'Ubuntu Mono', ui-monospace, monospace;
  }

  body {
    font-family: var(--font-sans);
    background: var(--bg);
    color: var(--ink);
    padding: 24px;
  }

  .app-shell {
    width: min(1360px, 100%);
    margin: 0 auto;
  }

  .hero {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    padding: 28px 30px;
    background:
      linear-gradient(135deg, rgba(255, 249, 240, 0.92), rgba(247, 238, 224, 0.9)),
      linear-gradient(120deg, rgba(184, 106, 18, 0.08), transparent 60%);
    border: 1px solid rgba(220, 207, 186, 0.9);
    border-radius: 28px;
    box-shadow: var(--shadow);
    margin-bottom: 18px;
  }

  .hero-kicker {
    display: inline-flex;
    align-items: center;
    padding: 6px 10px;
    border-radius: 999px;
    background: rgba(30, 42, 58, 0.08);
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-bottom: 14px;
  }

  .logo {
    gap: 10px;
    font-size: 32px;
    font-weight: 700;
    letter-spacing: -0.03em;
    color: var(--ink);
  }

  .logo-badge {
    display: inline-flex;
    align-items: center;
    padding: 4px 10px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-strong);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .hero-subtitle {
    margin-top: 12px;
    max-width: 720px;
    color: var(--muted);
    font-size: 15px;
    line-height: 1.6;
  }

  .hero-side {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 12px;
    min-width: 190px;
  }

  .hero-link,
  .hero-link:visited {
    color: var(--ink);
    text-decoration: none;
    font-size: 13px;
    font-weight: 600;
    padding: 10px 14px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.72);
  }

  .hero-link:hover {
    border-color: var(--accent);
    color: var(--accent-strong);
  }

  .status-pill {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.78);
    border: 1px solid var(--line);
    color: var(--muted);
    font-size: 13px;
    font-weight: 600;
  }

  .status-dot.connected { background: var(--success); }
  .status-dot.disconnected { background: var(--danger); }
  .status-dot.connecting { background: var(--warning); }

  .overview {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 14px;
    margin-bottom: 18px;
  }

  .metric-card {
    padding: 16px 18px;
    background: var(--bg-soft);
    border: 1px solid rgba(220, 207, 186, 0.9);
    border-radius: 18px;
    box-shadow: 0 8px 24px rgba(49, 39, 23, 0.05);
  }

  .metric-label {
    display: block;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 10px;
  }

  .metric-value {
    font-size: 28px;
    line-height: 1;
    letter-spacing: -0.04em;
    color: var(--ink);
  }

  .tabs {
    gap: 10px;
    flex-wrap: wrap;
    background: transparent;
    border-bottom: none;
    padding: 0 0 16px 0;
  }

  .tab {
    padding: 10px 14px;
    border: 1px solid transparent;
    border-radius: 999px;
    color: var(--muted);
    font-weight: 600;
    background: rgba(255, 252, 246, 0.5);
  }

  .tab:hover {
    color: var(--ink);
    background: rgba(255, 255, 255, 0.85);
    border-color: var(--line);
  }

  .tab.active {
    color: var(--accent-strong);
    border-bottom-color: transparent;
    border-color: rgba(184, 106, 18, 0.24);
    background: rgba(184, 106, 18, 0.14);
  }

  .panels {
    padding: 0;
  }

  .panel {
    display: none;
    background: rgba(255, 253, 250, 0.88);
    border: 1px solid rgba(220, 207, 186, 0.9);
    border-radius: 24px;
    padding: 24px;
    box-shadow: var(--shadow);
  }

  .panel.active {
    display: block;
  }

  .panel-header {
    align-items: flex-start;
    margin-bottom: 18px;
    gap: 12px;
  }

  .panel-header h2 {
    font-size: 22px;
    letter-spacing: -0.03em;
    color: var(--ink);
  }

  .panel-subtitle {
    margin-top: 6px;
    font-size: 14px;
    line-height: 1.5;
    color: var(--muted);
  }

  .panel-actions {
    display: flex;
    gap: 8px;
  }

  .btn-sm {
    padding: 8px 14px;
    background: rgba(255, 255, 255, 0.9);
    border: 1px solid var(--line);
    border-radius: 999px;
    color: var(--ink);
    font-size: 12px;
    font-weight: 700;
  }

  .btn-sm:hover {
    background: rgba(184, 106, 18, 0.12);
    border-color: rgba(184, 106, 18, 0.28);
  }

  .summary {
    gap: 8px;
    flex-wrap: wrap;
  }

  .summary-item {
    padding: 8px 12px;
    border-radius: 999px;
    background: rgba(184, 106, 18, 0.08);
    color: var(--accent-strong);
    font-weight: 600;
  }

  .summary-count {
    color: var(--ink);
  }

  .activity-list,
  .routes-list,
  .violations-list,
  .preview-list,
  .contracts-list,
  .contracts-detail,
  .preview-diff {
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(220, 207, 186, 0.9);
    border-radius: 18px;
  }

  .activity-list,
  .routes-list,
  .violations-list,
  .preview-list {
    overflow: hidden;
  }

  .activity-list {
    max-height: calc(100vh - 320px);
  }

  .activity-item,
  .route-item,
  .change-item,
  .contract-item {
    border-bottom: 1px solid rgba(220, 207, 186, 0.72);
  }

  .activity-item:last-child,
  .route-item:last-child,
  .change-item:last-child,
  .contract-item:last-child {
    border-bottom: none;
  }

  .activity-item {
    padding: 12px 14px;
    font-size: 12px;
    color: var(--ink);
  }

  .activity-time {
    color: var(--muted);
  }

  .activity-tool {
    color: var(--accent-strong);
  }

  .activity-detail {
    color: var(--ink);
  }

  .route-item {
    padding: 14px 16px;
  }

  .route-kind.page {
    background: rgba(46, 102, 184, 0.12);
    color: var(--info);
  }

  .route-kind.api {
    background: rgba(23, 127, 86, 0.12);
    color: var(--success);
  }

  .route-pattern {
    color: var(--ink);
  }

  .badge {
    background: rgba(30, 42, 58, 0.08);
    color: var(--muted);
    border: 1px solid rgba(220, 207, 186, 0.72);
  }

  .guard-status {
    margin-bottom: 12px;
    color: var(--muted);
    font-size: 14px;
  }

  .guard-summary {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
    padding: 0;
    background: transparent;
    margin-bottom: 16px;
  }

  .guard-stat {
    padding: 16px;
    border-radius: 18px;
    background: rgba(255, 255, 255, 0.72);
    border: 1px solid rgba(220, 207, 186, 0.9);
  }

  .guard-stat-value {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.04em;
    color: var(--ink);
  }

  .guard-stat-label {
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    margin-top: 8px;
  }

  .sev-error { color: var(--danger); }
  .sev-warning { color: var(--warning); }
  .sev-info { color: var(--info); }

  .violation-item {
    padding: 14px 16px;
    border-bottom: 1px solid rgba(220, 207, 186, 0.72);
  }

  .violation-item:last-child {
    border-bottom: none;
  }

  .violation-file {
    color: var(--ink);
    font-weight: 600;
    margin-bottom: 4px;
  }

  .violation-msg {
    color: var(--muted);
  }

  .preview-list,
  .preview-diff {
    margin-bottom: 16px;
  }

  .change-item {
    padding: 14px 16px;
  }

  .change-item:hover,
  .contract-item:hover {
    background: rgba(184, 106, 18, 0.06);
  }

  .change-icon {
    color: var(--accent-strong);
  }

  .change-path {
    color: var(--ink);
  }

  .change-status {
    font-weight: 700;
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.08em;
  }

  .contracts-layout {
    grid-template-columns: minmax(280px, 0.9fr) minmax(420px, 1.6fr);
    gap: 16px;
  }

  .contracts-list,
  .contracts-detail {
    padding: 8px;
  }

  .contract-item {
    padding: 14px 14px;
    border-radius: 14px;
  }

  .contract-item.selected {
    background: rgba(184, 106, 18, 0.12);
    border-color: rgba(184, 106, 18, 0.28);
  }

  .method-badge {
    border-radius: 999px;
    padding: 4px 8px;
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
  }

  .contract-schema,
  .contract-playground {
    background: rgba(255, 255, 255, 0.78);
    border: 1px solid rgba(220, 207, 186, 0.9);
    border-radius: 16px;
  }

  .contract-schema {
    padding: 16px;
    max-height: 420px;
    overflow: auto;
    color: var(--ink);
  }

  .contract-playground {
    margin-top: 14px;
    padding: 16px;
  }

  .playground-inputs label {
    color: var(--muted);
    font-size: 13px;
  }

  textarea,
  .select-sm {
    background: rgba(255, 252, 246, 0.92);
    border: 1px solid var(--line);
    color: var(--ink);
    border-radius: 12px;
  }

  textarea {
    width: 100%;
    margin-top: 6px;
    padding: 10px 12px;
    resize: vertical;
    font-family: "IBM Plex Mono", "Cascadia Code", monospace;
  }

  .select-sm {
    padding: 8px 12px;
  }

  .validate-result {
    margin-top: 12px;
    border-radius: 12px;
    padding: 12px 14px;
  }

  .validate-result.success {
    background: rgba(23, 127, 86, 0.12);
    color: var(--success);
  }

  .validate-result.error {
    background: rgba(188, 61, 61, 0.12);
    color: var(--danger);
  }

  .diff-header,
  .diff-hunk-header {
    background: transparent;
    color: var(--ink);
  }

  .diff-line-num {
    color: var(--muted);
  }

  .diff-line.add {
    background: rgba(23, 127, 86, 0.08);
  }

  .diff-line.remove {
    background: rgba(188, 61, 61, 0.08);
  }

  .empty-state {
    padding: 48px 20px;
    color: var(--muted);
  }

  .debug-bar {
    position: sticky;
    bottom: 0;
    margin-top: 16px;
    border-radius: 16px;
    background: rgba(30, 42, 58, 0.94);
    border: 1px solid rgba(30, 42, 58, 0.94);
    color: rgba(255, 255, 255, 0.76);
    box-shadow: 0 12px 28px rgba(30, 42, 58, 0.22);
  }

  .requests-list, .mcp-list, .cache-content, .metrics-content, .agent-content {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .agent-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
    gap: 14px;
  }

  .agent-stack {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .agent-card {
    padding: 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.72);
  }

  .agent-card-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
    color: var(--ink);
    font-size: 14px;
    font-weight: 700;
  }

  .agent-card-body {
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .agent-pill-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }

  .agent-pill {
    padding: 4px 8px;
    border-radius: 6px;
    background: rgba(30, 42, 58, 0.08);
    color: var(--ink);
    font-family: "IBM Plex Mono", "Cascadia Code", monospace;
    font-size: 11px;
  }

  .agent-severity {
    padding: 3px 7px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
  }

  .agent-severity.info { background: rgba(46, 102, 184, 0.12); color: var(--info); }
  .agent-severity.warn { background: rgba(173, 122, 18, 0.14); color: var(--warning); }
  .agent-severity.error { background: rgba(188, 61, 61, 0.12); color: var(--danger); }

  .agent-stat-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 8px;
    margin-top: 12px;
  }

  .agent-stat {
    padding: 10px;
    border-radius: 8px;
    border: 1px solid rgba(220, 207, 186, 0.7);
    background: rgba(255, 253, 250, 0.84);
  }

  .agent-stat-label {
    color: var(--muted);
    font-size: 11px;
  }

  .agent-stat-value {
    color: var(--ink);
    font-size: 19px;
    font-weight: 700;
    margin-top: 3px;
  }

  .agent-rec {
    display: grid;
    grid-template-columns: 150px 1fr;
    gap: 10px;
    padding: 10px 0;
    border-top: 1px solid rgba(220, 207, 186, 0.65);
  }

  .agent-rec:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .agent-rec-title {
    color: var(--ink);
    font-weight: 700;
    font-size: 13px;
  }

  .agent-rec-detail {
    color: var(--muted);
    font-size: 12px;
    line-height: 1.5;
  }

  .agent-prompt {
    width: 100%;
    min-height: 220px;
    margin-top: 10px;
    padding: 12px;
    resize: vertical;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink);
    font-family: "IBM Plex Mono", "Cascadia Code", monospace;
    font-size: 12px;
    line-height: 1.45;
  }

  .req-row {
    display: grid;
    grid-template-columns: 70px 60px 1fr 90px 90px;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.55);
    border: 1px solid var(--line);
    cursor: pointer;
    font-family: "IBM Plex Mono", "Cascadia Code", monospace;
    font-size: 12px;
    align-items: center;
  }

  .req-row:hover { background: rgba(184, 106, 18, 0.08); }
  .req-row.selected { background: rgba(184, 106, 18, 0.12); border-color: rgba(184, 106, 18, 0.28); }

  .req-method {
    font-weight: 700;
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.06em;
  }
  .req-method.get { color: #2563eb; }
  .req-method.post { color: #16a34a; }
  .req-method.put, .req-method.patch { color: #d97706; }
  .req-method.delete { color: #dc2626; }

  .req-status { font-weight: 700; }
  .req-status.s2 { color: var(--success); }
  .req-status.s3 { color: #2563eb; }
  .req-status.s4 { color: #d97706; }
  .req-status.s5 { color: var(--danger); }

  .req-path { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .req-dur, .req-cache { color: var(--muted); text-align: right; }

  .requests-detail {
    margin-top: 14px;
    padding: 14px;
    background: rgba(255, 255, 255, 0.78);
    border: 1px solid var(--line);
    border-radius: 14px;
    max-height: 420px;
    overflow: auto;
  }

  .corr-event {
    padding: 8px 10px;
    border-bottom: 1px solid rgba(220, 207, 186, 0.6);
    font-family: "IBM Plex Mono", "Cascadia Code", monospace;
    font-size: 12px;
  }
  .corr-event:last-child { border-bottom: none; }
  .corr-type {
    display: inline-block;
    padding: 2px 6px;
    border-radius: 6px;
    font-size: 10px;
    font-weight: 700;
    margin-right: 8px;
    background: rgba(30, 42, 58, 0.08);
  }

  .mcp-group {
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.55);
  }
  .mcp-group-header {
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .mcp-event {
    display: grid;
    grid-template-columns: 90px 22px 1fr 70px;
    gap: 8px;
    font-family: "IBM Plex Mono", "Cascadia Code", monospace;
    font-size: 12px;
    padding: 4px 0;
    align-items: center;
  }
  .mcp-status-ok { color: var(--success); font-weight: 700; }
  .mcp-status-err { color: var(--danger); font-weight: 700; }

  .cache-grid, .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 12px;
  }
  .stat-card {
    padding: 14px;
    border-radius: 14px;
    background: rgba(255, 255, 255, 0.78);
    border: 1px solid var(--line);
  }
  .stat-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
  .stat-value { font-size: 22px; font-weight: 700; margin-top: 4px; color: var(--ink); }
  .stat-sub { font-size: 11px; color: var(--muted); margin-top: 4px; }

  @media (max-width: 1040px) {
    body {
      padding: 18px;
    }

    .hero {
      flex-direction: column;
    }

    .hero-side {
      align-items: flex-start;
    }

    .overview {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .contracts-layout {
      grid-template-columns: 1fr;
    }

    .agent-grid {
      grid-template-columns: 1fr;
    }

    .guard-summary {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    body {
      padding: 12px;
    }

    .hero,
    .panel {
      padding: 18px;
      border-radius: 20px;
    }

    .overview {
      grid-template-columns: 1fr;
    }

    .tabs {
      gap: 8px;
    }

    .tab {
      width: calc(50% - 4px);
      justify-content: center;
    }

    .panel-header {
      flex-direction: column;
    }

    .agent-stat-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .agent-rec {
      grid-template-columns: 1fr;
    }
  }
`;

// ─── JavaScript ──────────────────────────────────

const JS = /* js */ `
(function() {
  var dbg = document.getElementById('debug-bar');
  function log(msg, cls) {
    if (!dbg) return;
    var s = document.createElement('span');
    s.className = cls || '';
    s.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg + '  ';
    dbg.appendChild(s);
    dbg.scrollTop = dbg.scrollHeight;
    console.log('[Kitchen]', msg);
  }

  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(String(str)));
    return d.innerHTML;
  }

  function setMetric(id, value) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(value);
  }

  try { log('JS loaded', 'ok'); } catch(e) {}

  // Tab switching
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].addEventListener('click', function() {
      var all = document.querySelectorAll('.tab');
      var panels = document.querySelectorAll('.panel');
      for (var j = 0; j < all.length; j++) all[j].classList.remove('active');
      for (var j = 0; j < panels.length; j++) panels[j].classList.remove('active');
      this.classList.add('active');
      var p = document.getElementById('panel-' + this.getAttribute('data-panel'));
      if (p) p.classList.add('active');
    });
  }

  // ─── SSE Activity Stream ─────────────────────
  var statusDot = document.getElementById('sse-status');
  var statusLabel = document.getElementById('sse-label');
  var activityList = document.getElementById('activity-list');
  var activityCount = 0;
  var MAX_ITEMS = 200;
  var sseRetryCount = 0;

  function connectSSE() {
    statusDot.className = 'status-dot connecting';
    statusLabel.textContent = 'Connecting...';
    log('SSE connecting...');

    var es;
    try {
      es = new EventSource('/__kitchen/sse/activity');
    } catch(e) {
      log('SSE EventSource failed: ' + e.message, 'err');
      statusDot.className = 'status-dot disconnected';
      statusLabel.textContent = 'Failed';
      return;
    }

    es.onopen = function() {
      statusDot.className = 'status-dot connected';
      statusLabel.textContent = 'Connected';
      sseRetryCount = 0;
      log('SSE connected', 'ok');
    };

    es.onmessage = function(e) {
      try {
        var data = JSON.parse(e.data);
        if (data.type === 'connected') {
          log('SSE welcome: ' + data.clientId, 'ok');
          return;
        }
        if (data.type === 'heartbeat') return;
        appendActivity(data);
      } catch(err) {
        log('SSE parse error: ' + err.message, 'err');
      }
    };

    es.onerror = function(evt) {
      log('SSE error (readyState=' + es.readyState + ')', 'err');
      statusDot.className = 'status-dot disconnected';
      statusLabel.textContent = 'Disconnected';
      es.close();
      sseRetryCount++;
      var delay = Math.min(3000 * sseRetryCount, 15000);
      log('SSE retry in ' + (delay/1000) + 's');
      setTimeout(connectSSE, delay);
    };
  }

  function appendActivity(data) {
    if (activityCount === 0) {
      activityList.innerHTML = '';
    }
    activityCount++;
    setMetric('metric-activity', activityCount);

    var item = document.createElement('div');
    item.className = 'activity-item';

    var ts = data.ts || data.timestamp || new Date().toISOString();
    var time = new Date(ts).toLocaleTimeString();
    var tool = data.tool || data.type || 'event';
    var detail = data.description || data.message || data.resource || JSON.stringify(data).substring(0, 120);

    item.innerHTML =
      '<span class="activity-time">' + escapeHtml(time) + '</span>' +
      '<span class="activity-tool">' + escapeHtml(tool) + '</span>' +
      '<span class="activity-detail">' + escapeHtml(detail) + '</span>';

    activityList.insertBefore(item, activityList.firstChild);

    while (activityList.children.length > MAX_ITEMS) {
      activityList.removeChild(activityList.lastChild);
    }
  }

  document.getElementById('clear-activity').addEventListener('click', function() {
    activityList.innerHTML = '<div class="empty-state">Waiting for MCP activity...</div>';
    activityCount = 0;
    setMetric('metric-activity', 0);
  });

  connectSSE();

  // ─── Routes ──────────────────────────────────
  function loadRoutes() {
    log('Fetching routes...');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/__kitchen/api/routes', true);
    xhr.onload = function() {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          log('Routes loaded: ' + data.summary.total + ' routes', 'ok');
          renderRoutes(data);
        } catch(e) {
          log('Routes parse error: ' + e.message, 'err');
        }
      } else {
        log('Routes HTTP ' + xhr.status, 'err');
        document.getElementById('routes-list').innerHTML =
          '<div class="empty-state">Failed to load routes (HTTP ' + xhr.status + ')</div>';
      }
    };
    xhr.onerror = function() {
      log('Routes network error', 'err');
      document.getElementById('routes-list').innerHTML =
        '<div class="empty-state">Network error loading routes.</div>';
    };
    xhr.send();
  }

  function renderRoutes(data) {
    var summaryEl = document.getElementById('routes-summary');
    var listEl = document.getElementById('routes-list');
    var s = data.summary;
    setMetric('metric-routes', s.total);

    summaryEl.innerHTML =
      '<span class="summary-item"><span class="summary-count">' + s.total + '</span> total</span>' +
      '<span class="summary-item"><span class="summary-count">' + s.pages + '</span> pages</span>' +
      '<span class="summary-item"><span class="summary-count">' + s.apis + '</span> APIs</span>' +
      '<span class="summary-item"><span class="summary-count">' + s.withIslands + '</span> islands</span>';

    if (!data.routes.length) {
      listEl.innerHTML = '<div class="empty-state">No routes found.</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < data.routes.length; i++) {
      var r = data.routes[i];
      var badges = '';
      if (r.hasSlot) badges += '<span class="badge">slot</span>';
      if (r.hasContract) badges += '<span class="badge">contract</span>';
      if (r.hasClient) badges += '<span class="badge">island</span>';
      if (r.hasLayout) badges += '<span class="badge">layout</span>';
      if (r.hydration && r.hydration !== 'none') badges += '<span class="badge">' + escapeHtml(r.hydration) + '</span>';

      html += '<div class="route-item">' +
        '<span class="route-kind ' + r.kind + '">' + r.kind + '</span>' +
        '<span class="route-pattern">' + escapeHtml(r.pattern) + '</span>' +
        '<span class="route-badges">' + badges + '</span>' +
        '</div>';
    }
    listEl.innerHTML = html;
  }

  loadRoutes();

  // ─── Guard ───────────────────────────────────
  var scanBtn = document.getElementById('scan-guard');
  var guardStatusEl = document.getElementById('guard-status');
  var guardListEl = document.getElementById('guard-list');

  function loadGuardStatus() {
    log('Fetching guard status...');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/__kitchen/api/guard', true);
    xhr.onload = function() {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          log('Guard: ' + (data.enabled ? 'enabled (' + data.preset + ')' : 'disabled'), 'ok');
          renderGuardData(data);
        } catch(e) {
          log('Guard parse error: ' + e.message, 'err');
        }
      }
    };
    xhr.onerror = function() { log('Guard network error', 'err'); };
    xhr.send();
  }

  scanBtn.addEventListener('click', function() {
    scanBtn.disabled = true;
    scanBtn.textContent = 'Scanning...';
    log('Guard scan started...');

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/__kitchen/api/guard/scan', true);
    xhr.onload = function() {
      scanBtn.disabled = false;
      scanBtn.textContent = 'Scan';
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          log('Guard scan done: ' + (data.report ? data.report.totalViolations + ' violations' : 'no report'), 'ok');
          renderGuardData(data);
        } catch(e) {
          log('Guard scan parse error: ' + e.message, 'err');
        }
      } else {
        log('Guard scan HTTP ' + xhr.status, 'err');
        guardStatusEl.textContent = 'Scan failed.';
      }
    };
    xhr.onerror = function() {
      scanBtn.disabled = false;
      scanBtn.textContent = 'Scan';
      log('Guard scan network error', 'err');
      guardStatusEl.textContent = 'Scan failed.';
    };
    xhr.send();
  });

  function renderGuardData(data) {
    if (!data.enabled) {
      guardStatusEl.textContent = 'Guard is not configured for this project.';
      guardListEl.innerHTML = '';
      setMetric('metric-guard', 'off');
      return;
    }

    guardStatusEl.innerHTML = 'Preset: <strong>' + escapeHtml(data.preset) + '</strong>';

    if (!data.report) {
      guardListEl.innerHTML = '<div class="empty-state">No scan results yet. Click "Scan" to check.</div>';
      setMetric('metric-guard', 'ready');
      return;
    }

    var r = data.report;
    setMetric('metric-guard', r.totalViolations);
    var summaryHtml = '<div class="guard-summary">' +
      '<div class="guard-stat"><div class="guard-stat-value">' + r.totalViolations + '</div><div class="guard-stat-label">Total</div></div>' +
      '<div class="guard-stat"><div class="guard-stat-value sev-error">' + (r.bySeverity.error || 0) + '</div><div class="guard-stat-label">Errors</div></div>' +
      '<div class="guard-stat"><div class="guard-stat-value sev-warning">' + (r.bySeverity.warning || 0) + '</div><div class="guard-stat-label">Warnings</div></div>' +
      '<div class="guard-stat"><div class="guard-stat-value sev-info">' + (r.bySeverity.info || 0) + '</div><div class="guard-stat-label">Info</div></div>' +
      '</div>';

    if (!r.violations.length) {
      guardListEl.innerHTML = summaryHtml + '<div class="empty-state">No violations found!</div>';
      return;
    }

    var violHtml = '';
    var list = r.violations.length > 100 ? r.violations.slice(0, 100) : r.violations;
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      violHtml += '<div class="violation-item">' +
        '<div class="violation-file">' +
          '<span class="violation-sev ' + v.severity + '">' + v.severity + '</span>' +
          escapeHtml(v.filePath) + ':' + v.line +
        '</div>' +
        '<div class="violation-msg">' +
          escapeHtml(v.fromLayer) + ' &rarr; ' + escapeHtml(v.toLayer) + ': ' + escapeHtml(v.ruleDescription) +
        '</div>' +
        '</div>';
    }
    guardListEl.innerHTML = summaryHtml + violHtml;
  }

  loadGuardStatus();

  // ─── Preview ──────────────────────────────────
  var previewListEl = document.getElementById('preview-list');
  var previewDiffEl = document.getElementById('preview-diff');
  var refreshChangesBtn = document.getElementById('refresh-changes');

  function loadFileChanges() {
    log('Fetching file changes...');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/__kitchen/api/file/changes', true);
    xhr.onload = function() {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          log('Changes loaded: ' + data.changes.length, 'ok');
          renderFileChanges(data.changes);
        } catch(e) {
          log('Changes parse error: ' + e.message, 'err');
        }
      }
    };
    xhr.onerror = function() { log('Changes network error', 'err'); };
    xhr.send();
  }

  function renderFileChanges(changes) {
    setMetric('metric-changes', changes.length);
    if (!changes.length) {
      previewListEl.innerHTML = '<div class="empty-state">No file changes detected.</div>';
      return;
    }
    var html = '';
    var icons = { added: '+', modified: '~', deleted: '-', untracked: '?', renamed: 'R' };
    for (var i = 0; i < changes.length; i++) {
      var c = changes[i];
      html += '<div class="change-item" data-path="' + escapeHtml(c.filePath) + '">' +
        '<span class="change-icon">' + (icons[c.status] || '?') + '</span>' +
        '<span class="change-path">' + escapeHtml(c.filePath) + '</span>' +
        '<span class="change-status ' + c.status + '">' + c.status + '</span>' +
        '</div>';
    }
    previewListEl.innerHTML = html;

    // Attach click handlers
    var items = previewListEl.querySelectorAll('.change-item');
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener('click', function() {
        var p = this.getAttribute('data-path');
        loadFileDiff(p);
      });
    }
  }

  function loadFileDiff(filePath) {
    log('Fetching diff for ' + filePath);
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/__kitchen/api/file/diff?path=' + encodeURIComponent(filePath), true);
    xhr.onload = function() {
      if (xhr.status === 200) {
        try {
          var diff = JSON.parse(xhr.responseText);
          renderDiff(diff);
        } catch(e) {
          log('Diff parse error: ' + e.message, 'err');
        }
      }
    };
    xhr.onerror = function() { log('Diff network error', 'err'); };
    xhr.send();
  }

  function renderDiff(diff) {
    if (!diff.hunks || !diff.hunks.length) {
      previewDiffEl.innerHTML = '<div class="empty-state">No diff available.</div>';
      previewDiffEl.style.display = 'block';
      return;
    }
    var html = '<div class="diff-header">' +
      '<span class="diff-file">' + escapeHtml(diff.filePath) + '</span>' +
      '<span class="diff-stats"><span class="diff-add">+' + diff.additions + '</span><span class="diff-del">-' + diff.deletions + '</span></span>' +
      '<button class="btn-sm" onclick="document.getElementById(\'preview-diff\').style.display=\'none\'">Close</button>' +
      '</div>';
    for (var h = 0; h < diff.hunks.length; h++) {
      var hunk = diff.hunks[h];
      html += '<div class="diff-hunk-header">' + escapeHtml(hunk.header) + '</div>';
      for (var l = 0; l < hunk.lines.length; l++) {
        var line = hunk.lines[l];
        var cls = line.type === 'add' ? 'add' : line.type === 'remove' ? 'remove' : 'context';
        html += '<div class="diff-line ' + cls + '">' +
          '<span class="diff-line-num">' + (line.oldLine || '') + '</span>' +
          '<span class="diff-line-num">' + (line.newLine || '') + '</span>' +
          '<span class="diff-line-content">' + escapeHtml(line.content) + '</span>' +
          '</div>';
      }
    }
    previewDiffEl.innerHTML = html;
    previewDiffEl.style.display = 'block';
  }

  refreshChangesBtn.addEventListener('click', loadFileChanges);
  loadFileChanges();

  // ─── Contracts ─────────────────────────────────
  var contractsListEl = document.getElementById('contracts-list');
  var contractSchemaEl = document.getElementById('contract-schema');
  var validateBtn = document.getElementById('validate-btn');
  var validateResultEl = document.getElementById('validate-result');
  var exportJsonBtn = document.getElementById('export-openapi-json');
  var exportYamlBtn = document.getElementById('export-openapi-yaml');
  var selectedContractId = null;

  function loadContracts() {
    log('Fetching contracts...');
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/__kitchen/api/contracts', true);
    xhr.onload = function() {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          log('Contracts loaded: ' + data.contracts.length, 'ok');
          renderContractsList(data.contracts);
        } catch(e) {
          log('Contracts parse error: ' + e.message, 'err');
          contractsListEl.innerHTML = '<div class="empty-state">Failed to parse contracts.</div>';
        }
      } else if (xhr.status === 404) {
        contractsListEl.innerHTML = '<div class="empty-state">Contracts API not available.</div>';
      }
    };
    xhr.onerror = function() {
      log('Contracts network error', 'err');
      contractsListEl.innerHTML = '<div class="empty-state">Network error.</div>';
    };
    xhr.send();
  }

  function renderContractsList(contracts) {
    setMetric('metric-contracts', contracts.length);
    if (!contracts.length) {
      contractsListEl.innerHTML = '<div class="empty-state">No contracts found.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < contracts.length; i++) {
      var c = contracts[i];
      var methods = (c.methods || []).map(function(m) {
        return '<span class="method-badge ' + m.toLowerCase() + '">' + m + '</span>';
      }).join('');
      html += '<div class="contract-item" data-id="' + escapeHtml(c.id) + '">' +
        methods +
        '<span class="contract-pattern">' + escapeHtml(c.pattern) + '</span>' +
        '</div>';
    }
    contractsListEl.innerHTML = html;

    var items = contractsListEl.querySelectorAll('.contract-item');
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener('click', function() {
        var id = this.getAttribute('data-id');
        selectedContractId = id;
        var all = contractsListEl.querySelectorAll('.contract-item');
        for (var k = 0; k < all.length; k++) all[k].classList.remove('selected');
        this.classList.add('selected');
        loadContractDetail(id);
      });
    }
  }

  function loadContractDetail(id) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', '/__kitchen/api/contracts/' + encodeURIComponent(id), true);
    xhr.onload = function() {
      if (xhr.status === 200) {
        try {
          var data = JSON.parse(xhr.responseText);
          contractSchemaEl.textContent = JSON.stringify(data, null, 2);
        } catch(e) {
          contractSchemaEl.textContent = 'Parse error';
        }
      }
    };
    xhr.send();
  }

  validateBtn.addEventListener('click', function() {
    if (!selectedContractId) {
      validateResultEl.className = 'validate-result error';
      validateResultEl.textContent = 'Select a contract first.';
      return;
    }
    var method = document.getElementById('validate-method').value;
    var input = {};
    try {
      var q = document.getElementById('validate-query').value.trim();
      var b = document.getElementById('validate-body').value.trim();
      var p = document.getElementById('validate-params').value.trim();
      if (q) input.query = JSON.parse(q);
      if (b) input.body = JSON.parse(b);
      if (p) input.params = JSON.parse(p);
    } catch(e) {
      validateResultEl.className = 'validate-result error';
      validateResultEl.textContent = 'Invalid JSON: ' + e.message;
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/__kitchen/api/contracts/validate', true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.onload = function() {
      try {
        var result = JSON.parse(xhr.responseText);
        if (result.valid) {
          validateResultEl.className = 'validate-result success';
          validateResultEl.textContent = 'Validation passed!';
        } else {
          validateResultEl.className = 'validate-result error';
          validateResultEl.textContent = JSON.stringify(result.errors || result, null, 2);
        }
      } catch(e) {
        validateResultEl.className = 'validate-result error';
        validateResultEl.textContent = 'Response parse error';
      }
    };
    xhr.send(JSON.stringify({ contractId: selectedContractId, method: method, input: input }));
  });

  exportJsonBtn.addEventListener('click', function() {
    window.open('/__kitchen/api/contracts/openapi', '_blank');
  });

  exportYamlBtn.addEventListener('click', function() {
    window.open('/__kitchen/api/contracts/openapi.yaml', '_blank');
  });

  loadContracts();

  // ─── Requests Tab ─────────────────────────────
  var requestsListEl = document.getElementById('requests-list');
  var requestsDetailEl = document.getElementById('requests-detail');
  var agentContentEl = document.getElementById('agent-content');

  function fetchJson(url, cb) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.onload = function() {
      if (xhr.status === 200) {
        try { cb(null, JSON.parse(xhr.responseText)); }
        catch(e) { cb(e); }
      } else { cb(new Error('HTTP ' + xhr.status)); }
    };
    xhr.onerror = function() { cb(new Error('network')); };
    xhr.send();
  }

  function statusClass(s) {
    if (!s) return '';
    if (s >= 500) return 's5';
    if (s >= 400) return 's4';
    if (s >= 300) return 's3';
    return 's2';
  }

  // ─── Agent Supervisor Tab ─────────────────────
  function renderAgentPills(items) {
    if (!items || !items.length) return '';
    var html = '<div class="agent-pill-row">';
    for (var i = 0; i < items.length; i++) {
      html += '<span class="agent-pill">' + escapeHtml(items[i]) + '</span>';
    }
    return html + '</div>';
  }

  function renderAgentDetails(items) {
    if (!items || !items.length) return '';
    var html = '<ul>';
    for (var i = 0; i < items.length; i++) {
      html += '<li>' + escapeHtml(items[i]) + '</li>';
    }
    return html + '</ul>';
  }

  function renderAgentContext(data) {
    var situation = data.situation || {};
    var summary = data.summary || {};
    var routes = summary.routes || {};
    var status = data.agentStatus || {};
    var brain = status.brain || {};
    var action = data.nextSafeAction || {};
    var prompt = data.prompt || {};
    var recs = data.toolRecommendations || [];
    var cards = data.knowledgeCards || [];
    var promptText = prompt.copyText || '';

    var html = '<div class="agent-grid">' +
      '<div class="agent-stack">' +
        '<div class="agent-card">' +
          '<div class="agent-card-title">' +
            '<span>' + escapeHtml(situation.title || 'No situation') + '</span>' +
            '<span class="agent-severity ' + escapeHtml(situation.severity || 'info') + '">' + escapeHtml(situation.category || 'agent') + '</span>' +
          '</div>' +
          '<div class="agent-card-body">' + renderAgentDetails(situation.details || []) + '</div>' +
          '<div class="agent-stat-grid">' +
            '<div class="agent-stat"><div class="agent-stat-label">Routes</div><div class="agent-stat-value">' + escapeHtml(routes.total || 0) + '</div></div>' +
            '<div class="agent-stat"><div class="agent-stat-label">Islands</div><div class="agent-stat-value">' + escapeHtml(routes.islands || 0) + '</div></div>' +
            '<div class="agent-stat"><div class="agent-stat-label">Contracts</div><div class="agent-stat-value">' + escapeHtml(routes.contracts || 0) + '</div></div>' +
            '<div class="agent-stat"><div class="agent-stat-label">MCP Calls</div><div class="agent-stat-value">' + escapeHtml(status.observedToolCalls || 0) + '</div></div>' +
          '</div>' +
        '</div>' +
        '<div class="agent-card">' +
          '<div class="agent-card-title"><span>Next Safe Action</span><span class="agent-severity info">' + escapeHtml(action.mode || 'observe') + '</span></div>' +
          '<div class="agent-card-body"><strong>' + escapeHtml(action.title || '-') + '</strong><br>' + escapeHtml(action.reason || '') + '</div>' +
          renderAgentPills([action.tool || '', action.command || ''].filter(Boolean)) +
          renderAgentPills(action.validation || []) +
        '</div>' +
        '<div class="agent-card">' +
          '<div class="agent-card-title"><span>Prompt Pack</span><button id="copy-agent-prompt" class="btn-sm">Copy</button></div>' +
          '<textarea id="agent-prompt-text" class="agent-prompt" readonly>' + escapeHtml(promptText) + '</textarea>' +
        '</div>' +
      '</div>' +
      '<div class="agent-stack">' +
        '<div class="agent-card">' +
          '<div class="agent-card-title"><span>Brain</span><span class="agent-severity info">' + escapeHtml(brain.oauth || 'unknown') + '</span></div>' +
          '<div class="agent-card-body">' + escapeHtml(brain.note || '') + '</div>' +
          renderAgentPills([brain.statusTool || 'mandu.brain.status']) +
        '</div>' +
        '<div class="agent-card">' +
          '<div class="agent-card-title"><span>Tool Router</span></div>';

    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      html += '<div class="agent-rec">' +
        '<div class="agent-rec-title">' + escapeHtml(r.skill) + '</div>' +
        '<div class="agent-rec-detail">' +
          '<strong>' + escapeHtml(r.task) + '</strong><br>' +
          escapeHtml(r.useWhen) +
          renderAgentPills(r.mcpTools || []) +
          '<div style="margin-top:6px;">Fallback: <code>' + escapeHtml(r.cliFallback) + '</code></div>' +
        '</div>' +
      '</div>';
    }

    html += '</div><div class="agent-card">' +
      '<div class="agent-card-title"><span>Knowledge</span></div>';

    for (var c = 0; c < cards.length; c++) {
      var card = cards[c];
      html += '<div class="agent-rec">' +
        '<div class="agent-rec-title">' + escapeHtml(card.title) + '</div>' +
        '<div class="agent-rec-detail">' + escapeHtml(card.body) + renderAgentPills(card.references || []) + '</div>' +
      '</div>';
    }

    html += '</div></div></div>';
    agentContentEl.innerHTML = html;

    var copyBtn = document.getElementById('copy-agent-prompt');
    if (copyBtn) {
      copyBtn.addEventListener('click', function() {
        var textEl = document.getElementById('agent-prompt-text');
        var text = textEl ? textEl.value : promptText;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function() {
            copyBtn.textContent = 'Copied';
            setTimeout(function() { copyBtn.textContent = 'Copy'; }, 900);
          }).catch(function() {
            textEl && textEl.select();
          });
        } else if (textEl) {
          textEl.select();
        }
      });
    }
  }

  function loadAgentContext() {
    if (!agentContentEl) return;
    agentContentEl.innerHTML = '<div class="empty-state">Building agent context...</div>';
    fetchJson('/__kitchen/api/agent-context', function(err, data) {
      if (err) {
        agentContentEl.innerHTML = '<div class="empty-state">Failed: ' + escapeHtml(err.message) + '</div>';
        return;
      }
      renderAgentContext(data);
    });
  }

  document.getElementById('refresh-agent').addEventListener('click', loadAgentContext);

  function loadRequests() {
    requestsListEl.innerHTML = '<div class="empty-state">Loading requests...</div>';
    fetchJson('/__kitchen/api/requests?limit=100', function(err, data) {
      if (err) {
        requestsListEl.innerHTML = '<div class="empty-state">Failed: ' + escapeHtml(err.message) + '</div>';
        return;
      }
      var reqs = data.requests || [];
      if (!reqs.length) {
        requestsListEl.innerHTML = '<div class="empty-state">No requests yet.</div>';
        return;
      }
      var html = '';
      for (var i = 0; i < reqs.length; i++) {
        var r = reqs[i];
        // EventBus event shape vs legacy ring buffer shape
        var method = (r.data && r.data.method) || r.method || '?';
        var pathStr = (r.data && (r.data.path || r.data.url)) || r.path || r.message || '';
        var status = (r.data && r.data.status) || r.status || 0;
        var dur = r.duration || (r.data && r.data.duration) || 0;
        var cache = (r.data && (r.data.cacheStatus || r.data.cache)) || r.cacheStatus || '';
        var corr = r.correlationId || '';
        html += '<div class="req-row" data-corr="' + escapeHtml(corr) + '">' +
          '<span class="req-method ' + String(method).toLowerCase() + '">' + escapeHtml(method) + '</span>' +
          '<span class="req-status ' + statusClass(status) + '">' + escapeHtml(status || '-') + '</span>' +
          '<span class="req-path">' + escapeHtml(pathStr) + '</span>' +
          '<span class="req-dur">' + (dur ? Math.round(dur) + 'ms' : '-') + '</span>' +
          '<span class="req-cache">' + escapeHtml(cache || '-') + '</span>' +
          '</div>';
      }
      requestsListEl.innerHTML = html;

      var rows = requestsListEl.querySelectorAll('.req-row');
      for (var j = 0; j < rows.length; j++) {
        rows[j].addEventListener('click', function() {
          var all = requestsListEl.querySelectorAll('.req-row');
          for (var k = 0; k < all.length; k++) all[k].classList.remove('selected');
          this.classList.add('selected');
          var cid = this.getAttribute('data-corr');
          if (cid) loadCorrelation(cid);
          else {
            requestsDetailEl.innerHTML = '<div class="empty-state">No correlation ID on this request.</div>';
            requestsDetailEl.style.display = 'block';
          }
        });
      }
    });
  }

  function loadCorrelation(cid) {
    requestsDetailEl.innerHTML = '<div class="empty-state">Loading correlated events...</div>';
    requestsDetailEl.style.display = 'block';
    fetchJson('/__kitchen/api/correlation?id=' + encodeURIComponent(cid), function(err, data) {
      if (err) {
        requestsDetailEl.innerHTML = '<div class="empty-state">Failed: ' + escapeHtml(err.message) + '</div>';
        return;
      }
      var events = data.events || [];
      if (!events.length) {
        requestsDetailEl.innerHTML = '<div class="empty-state">No events for correlation ' + escapeHtml(cid) + '</div>';
        return;
      }
      var html = '<div style="font-size:11px;color:var(--muted);margin-bottom:8px;">correlation: ' + escapeHtml(cid) + '</div>';
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        var t = new Date(e.timestamp).toLocaleTimeString();
        html += '<div class="corr-event">' +
          '<span class="corr-type">' + escapeHtml(e.type) + '</span>' +
          '<span>' + escapeHtml(t) + ' </span>' +
          '<span>' + escapeHtml(e.message || '') + '</span>' +
          (e.duration ? ' <span style="color:var(--muted)">(' + Math.round(e.duration) + 'ms)</span>' : '') +
          '</div>';
      }
      requestsDetailEl.innerHTML = html;
    });
  }

  document.getElementById('refresh-requests').addEventListener('click', loadRequests);

  // ─── MCP Activity Tab ─────────────────────────
  var mcpListEl = document.getElementById('mcp-list');

  function loadMcpActivity() {
    mcpListEl.innerHTML = '<div class="empty-state">Loading MCP activity...</div>';
    fetchJson('/__kitchen/api/activity?limit=100', function(err, data) {
      if (err) {
        mcpListEl.innerHTML = '<div class="empty-state">Failed: ' + escapeHtml(err.message) + '</div>';
        return;
      }
      var events = data.events || [];
      if (!events.length) {
        mcpListEl.innerHTML = '<div class="empty-state">No MCP activity yet.</div>';
        return;
      }

      // Group by correlationId (fall back to individual items)
      var groups = {};
      var order = [];
      for (var i = 0; i < events.length; i++) {
        var e = events[i];
        var cid = e.correlationId || ('_' + (e.id || i));
        if (!groups[cid]) { groups[cid] = []; order.push(cid); }
        groups[cid].push(e);
      }

      var html = '';
      for (var g = 0; g < order.length; g++) {
        var cid = order[g];
        var items = groups[cid];
        var header = cid.charAt(0) === '_' ? 'ungrouped' : 'correlation: ' + cid;
        html += '<div class="mcp-group"><div class="mcp-group-header">' + escapeHtml(header) + '</div>';
        for (var k = 0; k < items.length; k++) {
          var ev = items[k];
          var ts = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : (ev.ts || '');
          var tool = (ev.data && (ev.data.tool || ev.data.name)) || ev.tool || ev.source || 'mcp';
          var isErr = ev.severity === 'error';
          var icon = isErr ? '<span class="mcp-status-err">X</span>' : '<span class="mcp-status-ok">OK</span>';
          var dur = ev.duration ? Math.round(ev.duration) + 'ms' : '-';
          html += '<div class="mcp-event">' +
            '<span>' + escapeHtml(ts) + '</span>' +
            icon +
            '<span>' + escapeHtml(tool) + ' ' + escapeHtml(ev.message || '') + '</span>' +
            '<span style="text-align:right;color:var(--muted)">' + dur + '</span>' +
            '</div>';
        }
        html += '</div>';
      }
      mcpListEl.innerHTML = html;
    });
  }

  document.getElementById('refresh-mcp').addEventListener('click', loadMcpActivity);

  // ─── Cache Tab ────────────────────────────────
  var cacheContentEl = document.getElementById('cache-content');

  function loadCacheStats() {
    cacheContentEl.innerHTML = '<div class="empty-state">Loading cache stats...</div>';
    fetchJson('/__kitchen/api/cache-stats', function(err, data) {
      if (err) {
        cacheContentEl.innerHTML = '<div class="empty-state">Failed: ' + escapeHtml(err.message) + '</div>';
        return;
      }
      if (!data.enabled) {
        cacheContentEl.innerHTML = '<div class="empty-state">Cache store is not enabled.</div>';
        return;
      }
      var s = data.stats || {};
      var entries = s.entries != null ? s.entries : data.size;
      var hits = s.hits || 0;
      var misses = s.misses || 0;
      var total = hits + misses;
      var hitRate = total > 0 ? ((hits / total) * 100).toFixed(1) + '%' : '-';
      var stale = s.stale != null ? s.stale : (s.staleCount != null ? s.staleCount : '-');
      var tags = s.tags != null ? (Array.isArray(s.tags) ? s.tags.length : s.tags) : '-';

      var html = '<div class="cache-grid">' +
        '<div class="stat-card"><div class="stat-label">Entries</div><div class="stat-value">' + escapeHtml(entries) + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">Hit Rate</div><div class="stat-value">' + escapeHtml(hitRate) + '</div><div class="stat-sub">' + hits + ' hit / ' + misses + ' miss</div></div>' +
        '<div class="stat-card"><div class="stat-label">Stale</div><div class="stat-value">' + escapeHtml(stale) + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">Tags</div><div class="stat-value">' + escapeHtml(tags) + '</div></div>' +
        '</div>';
      cacheContentEl.innerHTML = html;
    });
  }

  document.getElementById('refresh-cache').addEventListener('click', loadCacheStats);

  // ─── Metrics Tab ──────────────────────────────
  var metricsContentEl = document.getElementById('metrics-content');

  function loadMetrics() {
    metricsContentEl.innerHTML = '<div class="empty-state">Loading metrics...</div>';
    fetchJson('/__kitchen/api/metrics?window=5m', function(err, data) {
      if (err) {
        metricsContentEl.innerHTML = '<div class="empty-state">Failed: ' + escapeHtml(err.message) + '</div>';
        return;
      }
      var http = data.http || {};
      var mcp = data.mcp || {};
      var errRate = ((data.errorRate || 0) * 100).toFixed(2) + '%';
      var html = '<div class="metrics-grid">' +
        '<div class="stat-card"><div class="stat-label">HTTP Requests (5m)</div><div class="stat-value">' + (http.count || 0) + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">TTFB p50</div><div class="stat-value">' + Math.round(http.p50 || 0) + 'ms</div></div>' +
        '<div class="stat-card"><div class="stat-label">TTFB p95</div><div class="stat-value">' + Math.round(http.p95 || 0) + 'ms</div></div>' +
        '<div class="stat-card"><div class="stat-label">TTFB p99</div><div class="stat-value">' + Math.round(http.p99 || 0) + 'ms</div></div>' +
        '<div class="stat-card"><div class="stat-label">MCP Calls</div><div class="stat-value">' + (mcp.count || 0) + '</div><div class="stat-sub">' + (mcp.errors || 0) + ' errors</div></div>' +
        '<div class="stat-card"><div class="stat-label">MCP Avg Duration</div><div class="stat-value">' + Math.round(mcp.avgDuration || 0) + 'ms</div></div>' +
        '<div class="stat-card"><div class="stat-label">Error Rate</div><div class="stat-value">' + errRate + '</div></div>' +
        '<div class="stat-card"><div class="stat-label">Total Events</div><div class="stat-value">' + (data.totalEvents || 0) + '</div></div>' +
        '</div>';
      metricsContentEl.innerHTML = html;
    });
  }

  document.getElementById('refresh-metrics').addEventListener('click', loadMetrics);

  // Lazy-load new tab data when clicked (avoids loading everything up front)
  var tabLoaders = {
    'agent': loadAgentContext,
    'requests': loadRequests,
    'mcp-activity': loadMcpActivity,
    'cache': loadCacheStats,
    'metrics': loadMetrics
  };
  var loadedTabs = {};
  for (var t = 0; t < tabs.length; t++) {
    tabs[t].addEventListener('click', function() {
      var name = this.getAttribute('data-panel');
      if (tabLoaders[name] && !loadedTabs[name]) {
        loadedTabs[name] = true;
        tabLoaders[name]();
      }
    });
  }

})();
`;
