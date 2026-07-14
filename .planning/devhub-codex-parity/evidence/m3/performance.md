# M3 performance evidence

Date: 2026-07-13 (America/Los_Angeles)

Method: Browser/IAB semantic actions plus Chrome DevTools Protocol `Performance.getMetrics` against the local production browser client and Node/TypeScript fixture. Measurements are single-machine development observations, not cross-device benchmarks.

| Measure | Observed | Interpretation |
| --- | --- | --- |
| Warm route reload to selected task heading | 543 ms | Cached local DevHub launch to usable native task on the wide viewport. |
| Cached empty -> 600-message task heading | 324 ms | Includes the production REST read, validation, timeline build, and first virtualized render. |
| Long transcript DOM | 29 rendered message articles at 1800px; 17 at 768px, from 600 fixture messages | Virtualization bounds rendered message nodes instead of mounting all history. |
| Long-task CDP delta | +10 layouts; +29 style recalculations; 2.15 ms layout; 6.64 ms style; 161.03 ms script; 208.84 ms total task time | Measured around the precise 324 ms task switch. Heap used fell by 2.86 MB after collection; no leak is inferred from one sample. |
| Composer typing | 49 characters in 33 ms; controlled value exactly preserved | Local semantic typing check; draft was then cleared with keyboard selection/backspace. |
| Synthetic send -> user visible | 302 ms | Includes browser action, authenticated HTTP mutation, state update, and deliberate local scheduling noise. |
| Synthetic send -> assistant visible | 431 ms with fixture completion scheduled at 250 ms | About 181 ms beyond the fixture timer for route, SSE, normalization, React update, and observation. |
| Minimum-width overflow | 768px client width and 768px document/body/header scroll width | The repaired top bar adds no horizontal document overflow. |
| Native lazy chunk | 75.15 kB raw / 21.39 kB gzip | Feature-gated and lazy; flag-off users do not download the native pane chunk. |

Current production build also reports the main app chunk at 337.34 kB raw / 89.86 kB gzip and CSS at 110.91 kB raw / 21.81 kB gzip.

## Gate judgment

The M3 slice has no material long-history or minimum-width regression in this local run. The task switch is sub-second and mounts fewer than 5% of a 600-message transcript at either tested width. Final animation-frame, React rerender-profiler, packaged cold/warm launch, sidecar startup, and multi-device budgets remain M8 gates and are not claimed complete here.
