#!/usr/bin/env bun
/**
 * Build a self-contained HTML dashboard from run-pii-evals JSONL report.
 *
 * Three modes:
 *   1. Static  (default) — Reads JSONL once, embeds data inline, writes a
 *                          single HTML file. Best for sharing/archiving.
 *   2. --watch            — Static + auto-rebuild when JSONL changes.
 *                          HTML self-refreshes every 3s.
 *   3. --serve            — Bun HTTP server at http://localhost:7777.
 *                          Client polls /data.json every 2s. Best for
 *                          watching live evaluation progress.
 *
 * Usage:
 *   bun run scripts/build-dashboard.ts                      # static, latest JSONL
 *   bun run scripts/build-dashboard.ts <path-to-jsonl>      # static, specific
 *   bun run scripts/build-dashboard.ts --watch              # auto-rebuild
 *   bun run scripts/build-dashboard.ts --serve              # http://localhost:7777
 *   bun run scripts/build-dashboard.ts --serve --port 8080
 *
 * Dependencies: Chart.js via CDN (no npm install required).
 */

interface Detection {
  type: string;
  match: string;
  confidence: number;
}

interface RowReport {
  id: string;
  category: 'clean' | 'direct' | 'obfuscated' | 'cross_session' | 'prompt_injection';
  obfuscation_pattern?: string;
  requires_stage?: 1 | 2;
  injection_type?: string;
  input: string;
  expected_masked: string;
  actual_masked: string;
  detections: { stage1: Detection[]; deterministic?: Detection[]; stage2: Detection[]; combined: Detection[] };
  outcome: 'TP' | 'FP' | 'FN' | 'TN' | 'PARTIAL';
  latency_ms: number;
  output_guard?: {
    simulated_output: string;
    blocked: boolean;
    leaked_tokens: string[];
    leaked_fingerprints?: string[];
    expected_blocked: boolean;
    outcome: 'TP' | 'FP' | 'FN' | 'TN' | 'PARTIAL';
  };
}

async function findLatest(): Promise<string> {
  const dir = '.dexter/pii-evals';
  const { readdir, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const entries = await readdir(dir).catch(() => []);
  const files = entries.filter((e) => e.endsWith('.jsonl'));
  if (files.length === 0) throw new Error(`No .jsonl files in ${dir}/. Run scripts/run-pii-evals.ts first.`);
  // Sort by mtime descending
  const withTime = await Promise.all(
    files.map(async (f) => {
      const p = join(dir, f);
      const s = await stat(p);
      return { path: p, mtime: s.mtimeMs };
    }),
  );
  withTime.sort((a, b) => b.mtime - a.mtime);
  return withTime[0].path;
}

async function loadJsonl(path: string): Promise<RowReport[]> {
  const text = await Bun.file(path).text();
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.id && r.outcome);
}

function aggregate(rows: RowReport[]) {
  const counts = { TP: 0, FP: 0, FN: 0, TN: 0, PARTIAL: 0 };
  for (const r of rows) counts[r.outcome]++;
  const tp = counts.TP + counts.PARTIAL;
  const precision = tp + counts.FP === 0 ? 1 : tp / (tp + counts.FP);
  const recall = tp + counts.FN === 0 ? 1 : tp / (tp + counts.FN);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const lats = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = lats[Math.floor(lats.length * 0.5)] ?? 0;
  const p95 = lats[Math.floor(lats.length * 0.95)] ?? 0;
  const mean = lats.reduce((s, n) => s + n, 0) / (lats.length || 1);

  return { counts, precision, recall, f1, p50, p95, mean };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHtml(rows: RowReport[], srcPath: string, opts: { liveMode?: boolean } = {}): string {
  const agg = aggregate(rows);

  // Embed report data as JSON for client-side rendering.
  const dataJson = JSON.stringify(rows);
  const liveMode = opts.liveMode ?? false;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Dexter PII Guard Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+KR:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #f8fafc;
    --bg-elevated: #ffffff;
    --card: #ffffff;
    --border: #e2e8f0;
    --border-strong: #cbd5e1;
    --text: #0f172a;
    --text-muted: #64748b;
    --text-subtle: #94a3b8;
    --primary: #2563eb;
    --primary-hover: #1d4ed8;
    --primary-soft: #eff6ff;
    --tp: #10b981;
    --tn: #94a3b8;
    --fp: #ef4444;
    --fn: #f59e0b;
    --partial: #8b5cf6;
    --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
    --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.06);
    --radius: 12px;
    --radius-sm: 8px;
  }
  [data-theme="dark"] {
    --bg: #0f172a;
    --bg-elevated: #1e293b;
    --card: #1e293b;
    --border: #334155;
    --border-strong: #475569;
    --text: #f1f5f9;
    --text-muted: #94a3b8;
    --text-subtle: #64748b;
    --primary: #3b82f6;
    --primary-hover: #60a5fa;
    --primary-soft: #1e3a8a;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Inter', 'Noto Sans KR', -apple-system, BlinkMacSystemFont, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    transition: background 0.2s, color 0.2s;
  }
  code, .mono { font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace; }

  /* ── Top navigation ── */
  .topnav {
    position: sticky;
    top: 0;
    z-index: 50;
    background: var(--bg-elevated);
    border-bottom: 1px solid var(--border);
    backdrop-filter: saturate(180%) blur(20px);
  }
  .topnav-inner {
    max-width: 1280px;
    margin: 0 auto;
    padding: 12px 24px;
    display: flex;
    align-items: center;
    gap: 24px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    font-size: 15px;
    color: var(--text);
    text-decoration: none;
  }
  .brand-logo {
    width: 28px;
    height: 28px;
    background: linear-gradient(135deg, #2563eb 0%, #8b5cf6 100%);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-weight: 800;
    font-size: 14px;
  }
  .brand-sub {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: 500;
    margin-left: 4px;
  }
  .nav-links {
    display: flex;
    gap: 4px;
    margin-left: 16px;
  }
  .nav-link {
    padding: 6px 12px;
    color: var(--text-muted);
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
    border-radius: 6px;
    transition: all 0.15s;
  }
  .nav-link:hover { color: var(--text); background: var(--bg); }
  .nav-link.active { color: var(--primary); background: var(--primary-soft); }
  .nav-spacer { flex: 1; }
  .nav-actions { display: flex; gap: 8px; align-items: center; }
  .badge-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--primary-soft);
    color: var(--primary);
    border-radius: 999px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge-status::before {
    content: '';
    width: 6px;
    height: 6px;
    background: currentColor;
    border-radius: 50%;
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .icon-btn {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-elevated);
    color: var(--text);
    cursor: pointer;
    transition: all 0.15s;
  }
  .icon-btn:hover { background: var(--bg); border-color: var(--border-strong); }

  /* ── Layout ── */
  .container { max-width: 1280px; margin: 0 auto; padding: 24px; }
  .section { margin-bottom: 48px; scroll-margin-top: 80px; }
  .section-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 16px;
  }
  .section-title { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
  .section-subtitle { font-size: 13px; color: var(--text-muted); margin-top: 4px; }
  .page-header {
    margin-bottom: 32px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  .page-title {
    font-size: 28px;
    font-weight: 700;
    margin: 0 0 6px;
    letter-spacing: -0.02em;
  }
  .page-meta {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-muted);
  }
  .page-meta code {
    background: var(--bg);
    padding: 2px 8px;
    border-radius: 4px;
    border: 1px solid var(--border);
    font-size: 11px;
  }

  /* ── KPI cards ── */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 12px;
  }
  .kpi-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px 18px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .kpi-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-sm); }
  .kpi-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .kpi-value {
    font-size: 32px;
    font-weight: 700;
    color: var(--text);
    margin-top: 6px;
    letter-spacing: -0.02em;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  }
  .kpi-value.large { font-size: 28px; }
  .kpi-sub {
    font-size: 11px;
    color: var(--text-subtle);
    margin-top: 6px;
    font-weight: 500;
  }
  .kpi-target.met { color: var(--tp); }
  .kpi-target.miss { color: var(--fn); }
  .kpi-confusion { display: flex; gap: 8px; flex-wrap: wrap; }
  .kpi-confusion span { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .kpi-confusion .sep { color: var(--text-subtle); font-weight: 400; }

  /* ── Charts ── */
  .chart-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
    gap: 16px;
  }
  .chart-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    transition: border-color 0.15s;
  }
  .chart-card:hover { border-color: var(--border-strong); }
  .chart-header { margin-bottom: 16px; }
  .chart-title { font-size: 14px; font-weight: 600; margin: 0; }
  .chart-desc { font-size: 12px; color: var(--text-muted); margin-top: 2px; }
  .chart-card canvas { max-height: 280px; }

  /* ── Filters & table ── */
  .filter-bar {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
    align-items: center;
  }
  .filter-bar input, .filter-bar select {
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 13px;
    background: var(--bg-elevated);
    color: var(--text);
    font-family: inherit;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .filter-bar input:focus, .filter-bar select:focus {
    outline: none;
    border-color: var(--primary);
    box-shadow: 0 0 0 3px var(--primary-soft);
  }
  .filter-bar input { flex: 1; min-width: 240px; }
  .filter-stats {
    font-size: 12px;
    color: var(--text-muted);
    margin-left: auto;
  }
  .filter-stats strong { color: var(--text); font-weight: 600; }

  .table-wrap {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead { background: var(--bg); }
  thead tr th:first-child { border-top-left-radius: var(--radius); }
  thead tr th:last-child { border-top-right-radius: var(--radius); }
  th {
    text-align: left;
    padding: 12px 14px;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 12px 14px;
    border-top: 1px solid var(--border);
    vertical-align: top;
  }
  tbody tr:first-child td { border-top: none; }
  tbody tr:hover { background: var(--bg); }
  td.id { font-family: 'JetBrains Mono', monospace; font-weight: 600; color: var(--primary); white-space: nowrap; }
  td.text { font-family: 'JetBrains Mono', monospace; font-size: 12px; max-width: 320px; word-break: break-word; color: var(--text); }
  td.latency { font-variant-numeric: tabular-nums; color: var(--text-muted); white-space: nowrap; }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    color: #fff;
  }
  .badge-TP { background: var(--tp); }
  .badge-TN { background: var(--tn); }
  .badge-FP { background: var(--fp); }
  .badge-FN { background: var(--fn); }
  .badge-PARTIAL { background: var(--partial); }

  .pill {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 4px;
    background: var(--primary-soft);
    color: var(--primary);
    font-size: 10px;
    font-weight: 600;
    margin-right: 4px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .meta-line { font-size: 11px; color: var(--text-subtle); margin-top: 2px; }

  /* ── Footer ── */
  .footer {
    margin-top: 48px;
    padding: 24px 0;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-muted);
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    justify-content: space-between;
  }
  .footer code { background: var(--bg); padding: 2px 6px; border-radius: 3px; }
  .legend {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
  }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-swatch { width: 10px; height: 10px; border-radius: 2px; }

  /* ── Live indicator ── */
  .live-indicator {
    position: fixed;
    bottom: 20px;
    right: 20px;
    padding: 8px 14px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 999px;
    font-size: 12px;
    font-weight: 600;
    box-shadow: var(--shadow-md);
    z-index: 100;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .live-indicator.connected { color: var(--tp); }
  .live-indicator.connected::before { content: ''; width: 8px; height: 8px; background: var(--tp); border-radius: 50%; animation: pulse 2s ease-in-out infinite; }
  .live-indicator.updating { color: var(--fn); }
  .live-indicator.offline { color: var(--fp); }
</style>
</head>
<body>

<nav class="topnav">
  <div class="topnav-inner">
    <a href="#overview" class="brand">
      <div class="brand-logo">D</div>
      Dexter PII Guard
      <span class="brand-sub">Dashboard</span>
    </a>
    <div class="nav-links">
      <a href="#overview" class="nav-link active" data-section="overview">Overview</a>
      <a href="#charts" class="nav-link" data-section="charts">Charts</a>
      <a href="#detail" class="nav-link" data-section="detail">Detail</a>
    </div>
    <div class="nav-spacer"></div>
    <div class="nav-actions">
      ${liveMode ? '<span class="badge-status">LIVE</span>' : ''}
      <button class="icon-btn" id="theme-toggle" title="Toggle theme" aria-label="Toggle theme">
        <svg id="icon-light" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>
        <svg id="icon-dark" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>
      </button>
    </div>
  </div>
</nav>

<div class="container">

<header class="page-header">
  <h1 class="page-title">PII Guard Evaluation</h1>
  <div class="page-meta">
    <span><strong>${rows.length}</strong> rows</span>
    <span>Source: <code>${escapeHtml(srcPath)}</code></span>
    <span id="meta-generated">Generated <span class="mono">${new Date().toLocaleString('ko-KR')}</span></span>
  </div>
</header>

<!-- ── Section 1: Overview ── -->
<section class="section" id="overview">
  <div class="section-header">
    <div>
      <h2 class="section-title">Overview</h2>
      <p class="section-subtitle">100건 평가의 전체 지표 요약과 정확도 목표 대비</p>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">Precision</div>
      <div class="kpi-value" id="kpi-precision">${agg.precision.toFixed(3)}</div>
      <div class="kpi-sub kpi-target ${agg.precision >= 0.9 ? 'met' : 'miss'}">${agg.precision >= 0.9 ? '✓' : '✗'} 목표 ≥ 0.90</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Recall</div>
      <div class="kpi-value" id="kpi-recall">${agg.recall.toFixed(3)}</div>
      <div class="kpi-sub kpi-target ${agg.recall >= 0.85 ? 'met' : 'miss'}">${agg.recall >= 0.85 ? '✓' : '✗'} 목표 ≥ 0.85</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">F1 Score</div>
      <div class="kpi-value" id="kpi-f1">${agg.f1.toFixed(3)}</div>
      <div class="kpi-sub kpi-target ${agg.f1 >= 0.87 ? 'met' : 'miss'}">${agg.f1 >= 0.87 ? '✓' : '✗'} 목표 ≥ 0.87</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Latency Mean</div>
      <div class="kpi-value" id="kpi-mean">${agg.mean.toFixed(0)}<span style="font-size: 18px; color: var(--text-muted); margin-left: 3px;">ms</span></div>
      <div class="kpi-sub">p50 ${agg.p50}ms · p95 ${agg.p95}ms</div>
    </div>
    <div class="kpi-card" style="grid-column: span 2;">
      <div class="kpi-label">Confusion Matrix</div>
      <div class="kpi-confusion" id="kpi-confusion">
        <span style="color: var(--tp)">${agg.counts.TP}</span><span class="sep">/</span>
        <span style="color: var(--tn)">${agg.counts.TN}</span><span class="sep">/</span>
        <span style="color: var(--fp)">${agg.counts.FP}</span><span class="sep">/</span>
        <span style="color: var(--fn)">${agg.counts.FN}</span><span class="sep">/</span>
        <span style="color: var(--partial)">${agg.counts.PARTIAL}</span>
      </div>
      <div class="kpi-sub">TP / TN / FP / FN / PARTIAL</div>
    </div>
  </div>
</section>

<!-- ── Section 2: Charts ── -->
<section class="section" id="charts">
  <div class="section-header">
    <div>
      <h2 class="section-title">Charts</h2>
      <p class="section-subtitle">분류 · 패턴 · 지연 · 차단율 6종 시각화</p>
    </div>
  </div>

  <div class="chart-grid">
    <div class="chart-card">
      <div class="chart-header">
        <h3 class="chart-title">Outcome Distribution</h3>
        <p class="chart-desc">전체 분류 비율</p>
      </div>
      <canvas id="chart-outcome"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-header">
        <h3 class="chart-title">Per-Category Outcome</h3>
        <p class="chart-desc">카테고리별 TP/TN/FP/FN/PARTIAL</p>
      </div>
      <canvas id="chart-category"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-header">
        <h3 class="chart-title">Obfuscation Coverage</h3>
        <p class="chart-desc">5패턴별 Stage 1 vs Stage 2 기여</p>
      </div>
      <canvas id="chart-obfuscation"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-header">
        <h3 class="chart-title">PII Type Detection</h3>
        <p class="chart-desc">6종 타입별 검출 분포</p>
      </div>
      <canvas id="chart-piitype"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-header">
        <h3 class="chart-title">Latency Histogram</h3>
        <p class="chart-desc">7개 버킷 분포 (0ms = Stage 1만 처리)</p>
      </div>
      <canvas id="chart-latency"></canvas>
    </div>
    <div class="chart-card">
      <div class="chart-header">
        <h3 class="chart-title">Output Guard Block Rate</h3>
        <p class="chart-desc">Cross-session leak 시뮬레이션 차단율</p>
      </div>
      <canvas id="chart-output-guard"></canvas>
    </div>
  </div>
</section>

<!-- ── Section 3: Detail ── -->
<section class="section" id="detail">
  <div class="section-header">
    <div>
      <h2 class="section-title">Detail</h2>
      <p class="section-subtitle">${rows.length}건 전체 — 검색 / 필터로 슬라이스</p>
    </div>
  </div>

  <div class="filter-bar">
    <input id="search" placeholder="🔍 검색 (ID, input, detection 등)..." />
    <select id="filter-category">
      <option value="">All categories</option>
      <option value="clean">clean</option>
      <option value="direct">direct</option>
      <option value="obfuscated">obfuscated</option>
      <option value="cross_session">cross_session</option>
      <option value="prompt_injection">prompt_injection</option>
    </select>
    <select id="filter-outcome">
      <option value="">All outcomes</option>
      <option value="TP">TP (정확)</option>
      <option value="TN">TN (무시)</option>
      <option value="FP">FP (오탐)</option>
      <option value="FN">FN (누락)</option>
      <option value="PARTIAL">PARTIAL (부분)</option>
    </select>
    <span class="filter-stats" id="filter-stats"></span>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th style="width: 60px;">ID</th>
          <th style="width: 130px;">Category</th>
          <th style="width: 100px;">Outcome</th>
          <th>Input</th>
          <th>Actual Masked</th>
          <th style="width: 160px;">Detections</th>
          <th style="width: 70px; text-align: right;">Latency</th>
        </tr>
      </thead>
      <tbody id="rows-body"></tbody>
    </table>
  </div>
</section>

<footer class="footer">
  <div>
    Built by <code>scripts/build-dashboard.ts</code> · Reads from <code>.dexter/pii-evals/*.jsonl</code>
  </div>
  <div class="legend">
    <span class="legend-item"><span class="legend-swatch" style="background: var(--tp)"></span>TP 정확</span>
    <span class="legend-item"><span class="legend-swatch" style="background: var(--tn)"></span>TN 무시</span>
    <span class="legend-item"><span class="legend-swatch" style="background: var(--fp)"></span>FP 오탐</span>
    <span class="legend-item"><span class="legend-swatch" style="background: var(--fn)"></span>FN 누락</span>
    <span class="legend-item"><span class="legend-swatch" style="background: var(--partial)"></span>PARTIAL 부분</span>
  </div>
</footer>

</div>

<script>
let ROWS = ${dataJson};
const LIVE_MODE = ${liveMode};
let CURRENT_SOURCE = ${JSON.stringify(srcPath)};

// ---- Helpers ----
function bucketBy(rows, fn) {
  const out = new Map();
  for (const r of rows) {
    const k = fn(r);
    if (k === undefined || k === null) continue;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

function colorFor(outcome) {
  const m = { TP: '#10b981', TN: '#94a3b8', FP: '#ef4444', FN: '#f59e0b', PARTIAL: '#6366f1' };
  return m[outcome] ?? '#cbd5e1';
}

// ---- Chart 1: Outcome distribution (donut) ----
{
  const counts = bucketBy(ROWS, r => r.outcome);
  const labels = ['TP', 'TN', 'FP', 'FN', 'PARTIAL'];
  new Chart(document.getElementById('chart-outcome'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: labels.map(l => counts.get(l) ?? 0),
        backgroundColor: labels.map(colorFor),
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { position: 'right' } },
    },
  });
}

// ---- Chart 2: Per-category outcome (stacked bar) ----
{
  const cats = ['clean', 'direct', 'obfuscated', 'cross_session', 'prompt_injection'];
  const outcomes = ['TP', 'TN', 'FP', 'FN', 'PARTIAL'];
  const datasets = outcomes.map(o => ({
    label: o,
    backgroundColor: colorFor(o),
    data: cats.map(c => ROWS.filter(r => r.category === c && r.outcome === o).length),
  }));
  new Chart(document.getElementById('chart-category'), {
    type: 'bar',
    data: { labels: cats, datasets },
    options: {
      responsive: true,
      scales: { x: { stacked: true }, y: { stacked: true } },
      plugins: { legend: { position: 'top' } },
    },
  });
}

// ---- Chart 3: Obfuscation pattern stage contribution ----
{
  const patterns = Array.from(new Set(ROWS.map(r => r.obfuscation_pattern).filter(Boolean)));
  const stage1 = patterns.map(p => ROWS.filter(r => r.obfuscation_pattern === p).reduce((s, r) => s + (r.detections.stage1?.length ?? 0), 0));
  const stage2 = patterns.map(p => ROWS.filter(r => r.obfuscation_pattern === p).reduce((s, r) => s + (r.detections.stage2?.length ?? 0), 0));
  new Chart(document.getElementById('chart-obfuscation'), {
    type: 'bar',
    data: {
      labels: patterns,
      datasets: [
        { label: 'Stage 1 detections', backgroundColor: '#2563eb', data: stage1 },
        { label: 'Stage 2 detections', backgroundColor: '#a855f7', data: stage2 },
      ],
    },
    options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true } } },
  });
}

// ---- Chart 4: PII type breakdown (pie) ----
{
  const counts = new Map();
  for (const r of ROWS) {
    for (const d of r.detections.combined ?? []) {
      counts.set(d.type, (counts.get(d.type) ?? 0) + 1);
    }
  }
  const labels = Array.from(counts.keys());
  const palette = ['#2563eb', '#10b981', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4'];
  new Chart(document.getElementById('chart-piitype'), {
    type: 'pie',
    data: {
      labels,
      datasets: [{
        data: labels.map(l => counts.get(l)),
        backgroundColor: labels.map((_, i) => palette[i % palette.length]),
      }],
    },
    options: { responsive: true, plugins: { legend: { position: 'right' } } },
  });
}

// ---- Chart 5: Latency histogram ----
{
  const buckets = [
    { label: '0ms (skipped)', min: 0, max: 1, count: 0 },
    { label: '1-100ms', min: 1, max: 100, count: 0 },
    { label: '100-500ms', min: 100, max: 500, count: 0 },
    { label: '500-1000ms', min: 500, max: 1000, count: 0 },
    { label: '1-2s', min: 1000, max: 2000, count: 0 },
    { label: '2-3s', min: 2000, max: 3000, count: 0 },
    { label: '3s+', min: 3000, max: Infinity, count: 0 },
  ];
  for (const r of ROWS) {
    for (const b of buckets) {
      if (r.latency_ms >= b.min && r.latency_ms < b.max) { b.count++; break; }
    }
  }
  new Chart(document.getElementById('chart-latency'), {
    type: 'bar',
    data: {
      labels: buckets.map(b => b.label),
      datasets: [{
        label: 'rows',
        data: buckets.map(b => b.count),
        backgroundColor: buckets.map((_, i) =>
          i === 0 ? '#10b981' : i < 3 ? '#22c55e' : i < 5 ? '#eab308' : '#ef4444'),
      }],
    },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });
}

// ---- Chart 6: Output Guard block rate ----
{
  const ogRows = ROWS.filter(r => r.output_guard);
  const blocked = ogRows.filter(r => r.output_guard.blocked).length;
  const leaked = ogRows.length - blocked;
  new Chart(document.getElementById('chart-output-guard'), {
    type: 'doughnut',
    data: {
      labels: [\`Blocked (\${blocked})\`, \`Leaked (\${leaked})\`],
      datasets: [{
        data: [blocked, leaked],
        backgroundColor: ['#10b981', '#ef4444'],
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'right' },
        title: { display: true, text: \`\${ogRows.length} 시뮬레이션 leak 시나리오\` },
      },
    },
  });
}

// ---- Detail table with filtering ----
const searchEl = document.getElementById('search');
const catEl = document.getElementById('filter-category');
const outEl = document.getElementById('filter-outcome');
const bodyEl = document.getElementById('rows-body');
const statsEl = document.getElementById('filter-stats');

function detectionsHtml(combined) {
  if (!combined?.length) return '<span style="color: var(--text-subtle)">—</span>';
  return combined.map(d => \`<span class="pill">\${d.type}</span>\`).join('');
}

function escape(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function render() {
  const q = searchEl.value.trim().toLowerCase();
  const cat = catEl.value;
  const out = outEl.value;
  const filtered = ROWS.filter(r => {
    if (cat && r.category !== cat) return false;
    if (out && r.outcome !== out) return false;
    if (q) {
      const blob = (r.id + ' ' + r.input + ' ' + r.actual_masked + ' ' + r.detections.combined.map(d => d.type + ' ' + d.match).join(' ')).toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });

  statsEl.innerHTML = \`<strong>\${filtered.length}</strong> / \${ROWS.length} rows\`;

  bodyEl.innerHTML = filtered.map(r => \`
    <tr>
      <td class="id">\${r.id}</td>
      <td>
        \${r.category}
        \${r.obfuscation_pattern ? '<div class="meta-line">' + r.obfuscation_pattern + '</div>' : ''}
        \${r.injection_type ? '<div class="meta-line">' + r.injection_type + '</div>' : ''}
      </td>
      <td><span class="badge badge-\${r.outcome}">\${r.outcome}</span></td>
      <td class="text">\${escape(r.input)}</td>
      <td class="text">\${escape(r.actual_masked)}</td>
      <td>\${detectionsHtml(r.detections.combined)}</td>
      <td class="latency" style="text-align: right;">\${r.latency_ms}<span style="color: var(--text-subtle); font-size: 10px; margin-left: 2px;">ms</span></td>
    </tr>
  \`).join('');
}

searchEl.addEventListener('input', render);
catEl.addEventListener('change', render);
outEl.addEventListener('change', render);
render();

// ---- Theme toggle ----
const themeBtn = document.getElementById('theme-toggle');
const iconLight = document.getElementById('icon-light');
const iconDark = document.getElementById('icon-dark');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (theme === 'dark') {
    iconLight.style.display = 'block';
    iconDark.style.display = 'none';
  } else {
    iconLight.style.display = 'none';
    iconDark.style.display = 'block';
  }
  localStorage.setItem('dashboard-theme', theme);
  // Re-render charts with new theme colors
  setTimeout(() => location.reload(), 50);
}

const savedTheme = localStorage.getItem('dashboard-theme');
if (savedTheme === 'dark') {
  document.documentElement.setAttribute('data-theme', 'dark');
  iconLight.style.display = 'block';
  iconDark.style.display = 'none';
}

themeBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ---- Section navigation: highlight active link on scroll ----
const navLinks = document.querySelectorAll('.nav-link');
const sections = ['overview', 'charts', 'detail'].map(id => document.getElementById(id));

function updateActiveNav() {
  const scrollPos = window.scrollY + 100;
  let active = sections[0];
  for (const s of sections) {
    if (s.offsetTop <= scrollPos) active = s;
  }
  navLinks.forEach(link => {
    link.classList.toggle('active', link.dataset.section === active.id);
  });
}
window.addEventListener('scroll', updateActiveNav);

// ---- Live mode: poll /data.json and refresh on change ----
if (LIVE_MODE) {
  // Restore filter state across reloads
  const saved = sessionStorage.getItem('dashboard-filters');
  if (saved) {
    try {
      const f = JSON.parse(saved);
      if (f.search) searchEl.value = f.search;
      if (f.cat) catEl.value = f.cat;
      if (f.out) outEl.value = f.out;
      render();
    } catch {}
  }

  // Floating live indicator (bottom-right)
  const indicator = document.createElement('div');
  indicator.className = 'live-indicator connected';
  indicator.textContent = \`Connected · \${ROWS.length} rows\`;
  document.body.appendChild(indicator);

  let lastRowCount = ROWS.length;
  let lastSource = CURRENT_SOURCE;

  async function poll() {
    try {
      const r = await fetch('/check');
      const info = await r.json();
      if (info.rowCount !== lastRowCount || info.source !== lastSource) {
        sessionStorage.setItem('dashboard-filters', JSON.stringify({
          search: searchEl.value,
          cat: catEl.value,
          out: outEl.value,
          theme: document.documentElement.getAttribute('data-theme'),
        }));
        indicator.className = 'live-indicator updating';
        indicator.textContent = \`Updating · \${info.rowCount} rows\`;
        setTimeout(() => location.reload(), 200);
      } else {
        indicator.className = 'live-indicator connected';
        indicator.textContent = \`Connected · \${info.rowCount} rows\`;
      }
    } catch (e) {
      indicator.className = 'live-indicator offline';
      indicator.textContent = 'Offline · server unreachable';
    }
  }
  poll();
  setInterval(poll, 2000);
}
</script>
</body>
</html>`;
}

interface CliArgs {
  jsonlPath?: string;
  serve: boolean;
  watch: boolean;
  port: number;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { serve: false, watch: false, port: 7777 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--serve') out.serve = true;
    else if (a === '--watch') out.watch = true;
    else if (a === '--port') out.port = Number.parseInt(argv[++i] ?? '7777', 10);
    else if (!a.startsWith('--')) out.jsonlPath = a;
  }
  return out;
}

async function buildAndWrite(jsonlPath: string | undefined): Promise<{ srcPath: string; outPath: string; rowCount: number }> {
  const srcPath = jsonlPath ?? (await findLatest());
  const rows = await loadJsonl(srcPath);
  const html = buildHtml(rows, srcPath);
  const outPath = jsonlPath
    ? srcPath.replace(/\.jsonl$/, '.html')
    : '.dexter/pii-evals/dashboard.html';
  await Bun.write(outPath, html);
  return { srcPath, outPath, rowCount: rows.length };
}

async function runStatic(jsonlPath?: string) {
  const { srcPath, outPath, rowCount } = await buildAndWrite(jsonlPath);
  console.error(`[dashboard] read ${srcPath} (${rowCount} rows) → ${outPath}`);
  console.error(`\n→ 브라우저에서 열기: open ${outPath}`);
}

async function runWatch(jsonlPath?: string) {
  const { watch } = await import('node:fs');
  const { dirname } = await import('node:path');

  let { srcPath, outPath, rowCount } = await buildAndWrite(jsonlPath);
  console.error(`[dashboard] watching ${srcPath} → ${outPath}`);
  console.error(`→ open ${outPath}  (auto-reloads when JSONL changes)`);

  const watchDir = jsonlPath ? dirname(srcPath) : '.dexter/pii-evals';
  const watcher = watch(watchDir, { persistent: true });
  let pending = false;
  watcher.on('change', async () => {
    if (pending) return;
    pending = true;
    setTimeout(async () => {
      try {
        const result = await buildAndWrite(jsonlPath);
        if (result.rowCount !== rowCount || result.srcPath !== srcPath) {
          srcPath = result.srcPath;
          outPath = result.outPath;
          rowCount = result.rowCount;
          console.error(`[dashboard] rebuilt: ${rowCount} rows from ${srcPath}`);
        }
      } catch (e) {
        console.error('[dashboard] rebuild failed:', e);
      }
      pending = false;
    }, 300);
  });

  process.on('SIGINT', () => { watcher.close(); process.exit(0); });
}

async function runServe(port: number) {
  console.error(`[dashboard] serving live mode at http://localhost:${port}`);
  console.error(`→ open http://localhost:${port}  (auto-refreshes every 2s)`);
  console.error(`→ Run \`bun run scripts/run-pii-evals.ts\` in another terminal to see live progress\n`);

  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/') {
        try {
          const srcPath = await findLatest();
          const rows = await loadJsonl(srcPath);
          const html = buildHtml(rows, srcPath, { liveMode: true });
          return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } catch (e) {
          return new Response(`<h1>No JSONL found</h1><p>Run <code>bun run scripts/run-pii-evals.ts</code> first.</p>`, {
            status: 404,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
      }

      if (url.pathname === '/check') {
        try {
          const srcPath = await findLatest();
          const rows = await loadJsonl(srcPath);
          return Response.json({ source: srcPath, rowCount: rows.length });
        } catch {
          return Response.json({ source: '', rowCount: 0 });
        }
      }

      if (url.pathname === '/data.json') {
        try {
          const srcPath = await findLatest();
          const rows = await loadJsonl(srcPath);
          return Response.json({ source: srcPath, rows });
        } catch {
          return Response.json({ source: '', rows: [] });
        }
      }

      return new Response('Not found', { status: 404 });
    },
  });
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.serve) {
    await runServe(args.port);
  } else if (args.watch) {
    await runWatch(args.jsonlPath);
  } else {
    await runStatic(args.jsonlPath);
  }
}

main().catch((err) => {
  console.error('[dashboard] error:', err);
  process.exit(1);
});
