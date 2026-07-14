Use case: ui-mockup targeted correction
Asset type: correction of the supplied DevHub intervention-state concept
Primary request: Preserve the supplied 2-by-3 plate, dark palette, panel geometry, type scale, and all unaffected content. Make only the semantic corrections below.

1. Add a quiet caption outside the product panels: "Proposed Claude request states — capability-gated until persistent runtime verification".
2. Permission panel: keep "Permission request", "Write", and "apps/web/src/features/tasks/api.ts". Include three actions "Allow", "Deny", and "Cancel". Show the actions disabled and add muted text "Unavailable until runtime support is verified".
3. Input panel: retain the question and radio options, but show "Send response" disabled and add muted text "Unavailable until runtime support is verified".
4. Failure panel: replace generic "Tool failed" with "Read failed" and pair "Retry" with the explicit note "Safe to retry". Do not imply automatic retry.
5. Reconnect panel: retain "Reconnecting…", "Check task status", and "Cancel" with legible spelling.
6. Expired panel must read exactly "Request expired — no action taken" and must have no approval action.
7. Cancelled panel: replace any Codex-specific footer controls such as "Full access" or "Goal" with fixed text identity "Anthropic · Claude" and permission text "Default". Do not show a provider picker.

Visible text requiring exact spelling: "DevHub", "Anthropic · Claude", "Proposed Claude request states — capability-gated until persistent runtime verification", "Permission request", "Write", "apps/web/src/features/tasks/api.ts", "Allow", "Deny", "Cancel", "Unavailable until runtime support is verified", "Input requested", "Which target should I verify?", "Browser + desktop", "Browser only", "Send response", "Read failed", "Retry", "Safe to retry", "Reconnecting…", "Check task status", "Request expired — no action taken", "Cancelled by you", "Default".

Constraints: keep six readable crops; inline requests, never modal; no Always allow; timeout never approves; no automatic retry; no logos; no new panels; no layout redesign; no watermark.
Quality: high
