# M4 performance and bundle impact

Date: 2026-07-13

## Current forced-build output

| Asset | Raw | Gzip |
| --- | ---: | ---: |
| Main application chunk | 338,090 B | 90,082 B |
| Provider-native pane lazy chunk | 77,541 B | 22,125 B |
| Settings lazy chunk | 85,872 B | 18,904 B |
| CSS | 110,906 B | 21,824 B |

The M3 provider-native pane baseline was approximately `75.15 kB` raw / `21.39 kB` gzip. M4 therefore adds about `2.39 kB` raw / `0.74 kB` gzip to the lazy native pane while adding Anthropic presentation and terminal-row reconciliation.

## Runtime checks

- Wide `1280x720` and narrow `768x720` documents had no horizontal overflow.
- The shared native pane retains the M3 bounded transcript window; the M3 600-message fixture rendered 17 nodes at narrow width and 29 at wide width.
- The composer retained one stable send/stop action slot through the active and completed fixture states.
- No claim is made yet for warm-launch, cached-switch, typing p95, event-to-paint p95, long tasks, animation frames, or packaged-app performance. Those remain repeatable M6/M8 gates.

## Judgment

No material M4 bundle or overflow regression was observed. Final performance completion remains open until the M6 shell and M8 packaged surface are measured with the required harnesses.
