# M3 live Codex runtime evidence

Date: 2026-07-13 (America/Los_Angeles)

Scope: one bounded, read-only scratch task through the production DevHub HTTP/SSE seam and the installed Codex `0.144.1` app-server. No Python process was invoked and no native file was edited.

## One-turn lifecycle

- Task ID: `019f5b78-18c0-7b60-8f0c-6afc120ecd7d`
- Turn ID: `019f5b78-1b40-7221-a234-f087f8045aef`
- Start: HTTP 201
- SSE attached before send: HTTP 200
- Send: HTTP 202
- Terminal status: `completed`
- Persisted turn count: 1
- Stream event families: 7 diagnostic, 2 message, 8 status, 1 usage
- Exact synthetic nonce observed: yes
- Stream error: none

## Recovery boundaries

- App-server crash test: terminated only the backend-owned child PID 69355. The next read started PID 99033 and returned the same task, one completed turn, and the exact nonce.
- DevHub restart test: stopped the QA backend, launched a new backend process against the same DevHub data root, and observed a new app-server PID 14871. The same task read returned HTTP 200 with the same completed turn and nonce.
- Explicit read-only resume: the installed runtime returned HTTP 409 because the adapter could not verify the requested safe effective policy. DevHub did not retry, did not start another turn, and retained readable native history. The UI's policy-repair state remains fail-closed. M1's direct app-server probe remains the live same-ID resume and continued-context proof for this installed build.

This 409 was the contemporaneous HTTP observation, not a successful DevHub resume. The temporary response file was later overwritten by a provider-unavailable retry, so it is not retained as independent raw proof of a specific policy-field mismatch. It does not broaden capability advertising or authorize unsafe continuation.

## No-turn policy probe

A later raw JSONL probe created a disposable zero-turn task with the same explicit read-only policy. `thread/start` returned the requested cwd, `sandbox:{type:"readOnly",networkAccess:false}`, `approvalPolicy:"on-request"`, `approvalsReviewer:"user"`, and `ephemeral:false` exactly. Immediate `thread/resume` returned `-32600: NO_ROLLOUT`: Codex does not persist a resumable rollout until a turn exists. The verifier therefore never received a resume result and no individual `verifyConfiguredResult` check could be identified as failing.

The operating contract permits at most two billable provider turns plus one extra for an unresolved lifecycle state. All three Codex turns were already consumed across M1 and M3. Creating another persisted scratch task solely to repeat the production-wrapper resume would exceed that cap, while using an unrelated user task would violate scope. Production-wrapper live resume/continued-conversation therefore remains an explicit artifact blocker; M1 direct app-server continuity and the synthetic production seam are supporting evidence, not a substitute claim.

## Native cleanup

Cleanup used the official raw `thread/delete` method through app-server, never direct rollout-file deletion:

- `019f5b78-18c0-7b60-8f0c-6afc120ecd7d`: delete returned `{}`; follow-up read returned `thread not loaded`.
- `019f5b42-90d6-7303-bbe2-a0f15b32b3d5`: delete reported `no rollout found`; follow-up read returned `thread not loaded`, confirming it was already absent.
- The no-turn policy-probe tasks were also deleted and verified absent.
- App-server exited cleanly with code 0. No server request, stderr error, Python process, or direct native-file edit occurred during cleanup.
