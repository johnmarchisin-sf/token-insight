# Dashboard Graph Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the dashboard charts from running away and replace the variance-prone "Recent 5-hour windows" bar chart with a line+area chart that shows trend against a peak reference.

**Architecture:** Pure presentation-layer change. Add a `.chart-wrap` wrapper element with size variants (`h-sm` / `h-md` / `h-lg`) around every Chart.js canvas so `maintainAspectRatio: false` has a sized parent. Rewrite `renderBlocksChart` to render two line datasets — primary trend with filled area and an active-window highlight, plus a dashed horizontal "recent peak" reference dataset. No backend, no API, no new deps.

**Tech Stack:** Vanilla HTML/CSS/JS, Chart.js 4.4 from CDN, Express static file serving via `npm run dev:dashboard`.

**Spec:** [`docs/superpowers/specs/2026-04-27-dashboard-graph-fix-design.md`](../specs/2026-04-27-dashboard-graph-fix-design.md)

**Note on testing:** This project has no unit test framework configured. Verification is by running `npm run dev:dashboard`, opening the dashboard URL, and observing chart behavior. Each task ends with explicit visual checks.

---

### Task 1: Add `.chart-wrap` CSS and wrap all canvases

Give every canvas a sized relative parent. After this task the runaway / blank-space behavior is gone but the windows chart is still a bar chart.

**Files:**
- Modify: `src/dashboard/public/styles.css` (append a new section at end of file)
- Modify: `src/dashboard/public/index.html` (wrap each `<canvas>` element)

- [ ] **Step 1: Add `.chart-wrap` rules to styles.css**

Append this block to the end of `src/dashboard/public/styles.css`:

```css
.chart-wrap {
  position: relative;
  width: 100%;
}
.chart-wrap.h-sm { height: 160px; }
.chart-wrap.h-md { height: 200px; }
.chart-wrap.h-lg { height: 240px; }
```

- [ ] **Step 2: Wrap `chart-blocks` canvas in index.html**

In `src/dashboard/public/index.html`, locate the section containing `<canvas id="chart-blocks" height="100"></canvas>` (around line 67) and replace that canvas line with:

```html
      <div class="chart-wrap h-sm">
        <canvas id="chart-blocks"></canvas>
      </div>
```

Note: drop the `height="100"` attribute. It is ignored by Chart.js when `maintainAspectRatio: false` and a sized parent exists.

- [ ] **Step 3: Wrap `chart-hours` canvas**

Replace `<canvas id="chart-hours" height="180"></canvas>` (around line 73) with:

```html
        <div class="chart-wrap h-md">
          <canvas id="chart-hours"></canvas>
        </div>
```

- [ ] **Step 4: Wrap `chart-daily` canvas**

Replace `<canvas id="chart-daily" height="180"></canvas>` (around line 77) with:

```html
        <div class="chart-wrap h-md">
          <canvas id="chart-daily"></canvas>
        </div>
```

- [ ] **Step 5: Wrap `chart-workspaces` canvas**

Replace `<canvas id="chart-workspaces" height="180"></canvas>` (around line 84) with:

```html
        <div class="chart-wrap h-lg">
          <canvas id="chart-workspaces"></canvas>
        </div>
```

- [ ] **Step 6: Wrap `chart-models` canvas**

Replace `<canvas id="chart-models" height="180"></canvas>` (around line 89) with:

```html
        <div class="chart-wrap h-lg">
          <canvas id="chart-models"></canvas>
        </div>
```

- [ ] **Step 7: Visual verification**

Run: `npm run dev:dashboard`

Open the URL printed in the terminal (default `http://localhost:7842`).

Expected:
- All five charts render at fixed heights matching their wrapper class (`chart-blocks` short, `chart-hours`/`chart-daily` medium, `chart-workspaces`/`chart-models` taller).
- No large blank space below any chart.
- Click the **Refresh** button several times and let the 30-second auto-refresh fire at least once. None of the charts grow on subsequent renders.
- Resize the browser window across the 900px breakpoint. Chart widths adjust; heights remain fixed.

If charts still grow: confirm the wrapper `<div>` immediately surrounds the `<canvas>` and is not nested inside another untouched container that might still have the old behavior.

- [ ] **Step 8: Commit**

```bash
git add src/dashboard/public/styles.css src/dashboard/public/index.html
git commit -m "fix(dashboard): give chart canvases sized wrappers"
```

---

### Task 2: Replace windows bar chart with line+area+peak reference

Rewrite `renderBlocksChart` so the "Recent 5-hour windows" panel reads as a trend line with a peak reference instead of a bar chart whose smaller windows collapse.

**Files:**
- Modify: `src/dashboard/public/app.js` — replace the `renderBlocksChart` function (currently lines 200–243)

- [ ] **Step 1: Replace `renderBlocksChart` implementation**

In `src/dashboard/public/app.js`, replace the entire existing `renderBlocksChart` function with:

```javascript
function renderBlocksChart(blocks, peak) {
  const ordered = [...(blocks || [])].reverse(); // oldest -> newest left-to-right
  const labels = ordered.map((b) => {
    const d = new Date(b.startedAt);
    return d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });
  const values = ordered.map((b) => b.totalTokens);
  const pointRadii = ordered.map((b) => (b.isActive ? 6 : 3));
  const pointColors = ordered.map((b) => (b.isActive ? '#3fb950' : '#58a6ff'));
  const peakLine = peak ? ordered.map(() => peak) : null;

  const datasets = [
    {
      label: 'Tokens per 5h window',
      data: values,
      borderColor: '#58a6ff',
      backgroundColor: 'rgba(88, 166, 255, 0.18)',
      fill: true,
      tension: 0.3,
      pointRadius: pointRadii,
      pointBackgroundColor: pointColors,
      pointBorderColor: pointColors,
      borderWidth: 2,
    },
  ];
  if (peakLine) {
    datasets.push({
      label: 'recent peak',
      data: peakLine,
      borderColor: '#8b949e',
      borderDash: [5, 5],
      borderWidth: 1,
      pointRadius: 0,
      fill: false,
    });
  }

  const ctx = $('chart-blocks').getContext('2d');
  if (charts.blocks) charts.blocks.destroy();
  charts.blocks = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets },
    options: {
      ...chartBaseOptions(),
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (ctx) => ctx.datasetIndex === 0,
          callbacks: {
            label: (ctx) => fmtTokens(ctx.parsed.y) + ' tokens',
          },
        },
      },
      scales: {
        x: { ticks: { color: '#8b949e', maxRotation: 60, minRotation: 30 }, grid: { color: '#1f2630' } },
        y: {
          beginAtZero: true,
          ticks: { color: '#8b949e', callback: (v) => fmtTokens(v) },
          grid: { color: '#1f2630' },
        },
      },
    },
  });
}
```

Key changes vs. the previous implementation:
- `type: 'bar'` → `type: 'line'`
- Single bar dataset → primary line+area dataset (with per-point radius/color array highlighting the active window) plus an optional dashed peak reference dataset.
- Removed `suggestedMax: peak * 1.1` (no longer needed; peak is shown as an explicit reference line).
- Added `beginAtZero: true` so the line+area starts at the x-axis.
- Added `tooltip.filter` so hover only triggers on the primary dataset (the peak reference line is decorative).

- [ ] **Step 2: Visual verification**

If the dev server from Task 1 was stopped, restart with: `npm run dev:dashboard`

Reload the dashboard URL (hard reload to bust the browser cache: Cmd-Shift-R on macOS).

Expected:
- The "Recent 5-hour windows" panel renders a smooth blue line with a translucent blue area underneath.
- The most recent (rightmost) point — if it is the active window — is rendered as a larger green dot. All other points are smaller blue dots.
- A horizontal dashed gray line spans the chart at the `recentPeak` value, visibly separated from the line/area when current windows are well below peak.
- Hovering shows a tooltip only over the data points (not the dashed reference line).
- The chart still respects the `chart-wrap.h-sm` wrapper height (160px) from Task 1.
- If `peakRecent` is 0 / falsy, the peak line is omitted gracefully and the primary line still renders.

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/public/app.js
git commit -m "feat(dashboard): replace windows bar chart with line+area+peak reference"
```

---

## Self-review notes

- **Spec coverage:** Section A (size guidelines for every chart) is implemented in Task 1. Section B (windows chart redesign) is implemented in Task 2. Both verification scenarios from the spec are exercised in the visual-verification steps.
- **Placeholders:** None. Every code/CSS/HTML block is complete.
- **Type/name consistency:** `chart-wrap`, `h-sm`/`h-md`/`h-lg`, `renderBlocksChart`, `peakRecent` (note: the function receives `peak`, which the caller passes from `d.peakRecent`) all match the existing app.js call site (`renderBlocksChart(d.recentBlocks, d.peakRecent);` at line 56).
- **Out of scope guardrails:** No other chart rendering functions are modified. No backend changes. No new dependencies.
