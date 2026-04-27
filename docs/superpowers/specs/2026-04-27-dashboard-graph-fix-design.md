# Dashboard graph sizing + windows-chart redesign

## Problem

Two related issues with the dashboard at `src/dashboard/public/`:

1. **Runaway sizing.** Every `<canvas>` is rendered by Chart.js with `responsive: true, maintainAspectRatio: false`. That mode requires a parent element with an explicit height; the current markup has none, so each chart leaves large blank space and visibly grows on each redraw / refresh cycle.

2. **Bar chart wastes space under variance.** The "Recent 5-hour windows" chart is a vertical bar chart whose y-axis is anchored to `peakRecent * 1.1`. When one historical peak window is much larger than the rest, every other bar collapses to a stub. The chart eats vertical space without conveying anything.

## Goals

- Charts render at predictable, bounded sizes. No layout thrash. No oversized blank canvases.
- The "Recent 5-hour windows" panel communicates trend over time and the relationship to the recent peak, instead of comparing magnitudes via bars.
- No new dependencies. Stay on Chart.js 4.4 from the existing CDN script tag.

## Non-goals

- Redesigning other charts. The "Time of day," "Daily tokens," "By workspace," and "By model" charts keep their existing types.
- Changing the API shape or data pipeline. This is a presentation-layer change only.

## Design

### A. Size guidelines for every chart

Add a wrapper element around each `<canvas>` that gives Chart.js a sized relative container.

CSS (in `src/dashboard/public/styles.css`):

```css
.chart-wrap {
  position: relative;
  width: 100%;
}
.chart-wrap.h-sm  { height: 160px; }
.chart-wrap.h-md  { height: 200px; }
.chart-wrap.h-lg  { height: 240px; }
```

HTML (in `src/dashboard/public/index.html`): each `<canvas>` is wrapped:

| Canvas              | Wrapper class       |
|---------------------|---------------------|
| `chart-blocks`      | `chart-wrap h-sm`   |
| `chart-hours`       | `chart-wrap h-md`   |
| `chart-daily`       | `chart-wrap h-md`   |
| `chart-workspaces`  | `chart-wrap h-lg`   |
| `chart-models`      | `chart-wrap h-lg`   |

The legacy `height="…"` attributes on the canvases are removed — they are ignored by Chart.js in `maintainAspectRatio: false` mode and are misleading.

### B. Replace the windows bar chart with a line + area + peak reference

In `src/dashboard/public/app.js`, rewrite `renderBlocksChart(blocks, peak)` so the chart is a line+area instead of a bar chart:

- **Primary dataset:** `type: 'line'`, oldest→newest. Border `#58a6ff`, semi-transparent fill `rgba(88,166,255,0.18)`, `tension: 0.3`, `pointRadius: 3`. The active (final) window's point is rendered larger and green: build a per-point `pointRadius` and `pointBackgroundColor` array that flags the point where `b.isActive` is true (radius 6, color `#3fb950`).
- **Reference dataset:** a second `type: 'line'` dataset whose values are `[peak, peak, …]` across all x positions, styled as a dashed gray horizontal line (`borderDash: [5, 5]`, `borderColor: '#8b949e'`, `pointRadius: 0`, `fill: false`, `borderWidth: 1`). Label: `recent peak`.
- **Scales:** y starts at 0, no `suggestedMax` cap. The axes use the existing `#8b949e` tick color, `#1f2630` grid color, and `fmtTokens` callback.
- **Tooltip:** preserve the current behavior (label shows formatted tokens). Hide the tooltip for the reference dataset (or have it show `peak: <value>`).
- **Legend:** keep hidden (`legend: { display: false }`) to match the rest of the dashboard. The dashed line speaks for itself.

The card heading stays as-is: "Recent 5-hour windows — how full each window got, vs your recent peak." The hint already describes the peak reference, so it now matches what the chart actually shows.

## Files touched

- `src/dashboard/public/index.html` — wrap each `<canvas>` in `<div class="chart-wrap h-*">`, drop `height="…"` attributes.
- `src/dashboard/public/styles.css` — add `.chart-wrap` rules.
- `src/dashboard/public/app.js` — rewrite `renderBlocksChart` to line+area+peak reference.

## Verification

- `npm run dev` to start the dashboard server. Open the dashboard URL.
- Confirm every chart renders at its declared height and stops resizing after first paint. No blank space below charts.
- Trigger a refresh (button + 30s auto-refresh) several times; charts must not grow.
- Visually inspect the "Recent 5-hour windows" chart: it is a smooth line+area with a dashed horizontal "recent peak" reference. The active window's terminal point is green and larger. When the peak is much larger than recent windows, the recent values are still readable (they are not crushed against the x-axis the way bars were).
- Resize the browser window across the 900px breakpoint; chart sizes adjust width but heights remain stable.

## Out of scope

- Any change to backend endpoints or report generation.
- Changes to non-chart panels (recommendations, KPI tiles, tables, clusters).
- Switching chart libraries or adding plugins (e.g., chartjs-plugin-annotation). The peak reference is implemented as a plain second dataset.
