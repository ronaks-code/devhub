# M4 Claude control-contract authority

Captured: 2026-07-12 PDT. This is static documentation/package inspection only; it made no Claude model or provider turn.

## Pinned primary source

- Official repository: <https://github.com/anthropics/claude-agent-sdk-typescript>
- Official release inspected: `@anthropic-ai/claude-agent-sdk@0.3.207`, published as the current GitHub release on 2026-07-11.
- npm tarball: <https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.207.tgz>
- npm SHA-1: `b0e8e34fc6f7f762fa988d0f687a5b1a944d416e`
- npm integrity: `sha512-y0PkQRmQBi96MHiN5Xzfq+GaddxCZCqI/cXEQBLYBLXGa4i1nDSlulQqkMBj2RorrrSGQJ6Wdw+uhu6OfHNPzA==`

The inspected artifacts were `package/sdk.d.ts` and `package/sdk.mjs`, streamed from the official tarball without installing the package or retaining a scratch copy.

## Confirmed wire forms

```json
{"type":"control_request","request_id":"request-1","request":{"subtype":"interrupt"}}
```

```json
{"type":"control_response","response":{"subtype":"success","request_id":"request-1","response":{}}}
```

```json
{"type":"control_response","response":{"subtype":"error","request_id":"request-1","error":"constant error"}}
```

```json
{"type":"control_cancel_request","request_id":"request-1"}
```

The current `can_use_tool` request requires `tool_name`, object `input`, and `tool_use_id`. Optional fields include `permission_suggestions`, `blocked_path`, `decision_reason`, `decision_reason_type`, `classifier_approvable`, `title`, `display_name`, `description`, `agent_id`, and `requires_user_interaction`. The current closed `decision_reason_type` union is `rule`, `mode`, `subcommandResults`, `permissionPromptTool`, `hook`, `asyncAgent`, `sandboxOverride`, `workingDir`, `safetyCheck`, `classifier`, or `other`.

An initialize success/error may carry `pending_permission_requests` and `pending_user_dialog_requests` beside its response payload. The SDK re-enters pending permission/dialog frames through its ordinary request handlers and aborts in-flight callbacks on `control_cancel_request`.

When `system/init.capabilities` contains `interrupt_receipt_v1`, an interrupt success payload is expected to contain `still_queued: string[]`. A result frame can race before the receipt on an interrupt failure path, so only the correlated control response is cancellation acknowledgement.

## Installed CLI cross-check

Static strings from the selected installed binary `/Users/ronak/.local/share/claude/versions/2.1.207` show its `can_use_tool` construction uses optional values or JavaScript `void 0`; JSON serialization omits absent optional fields. The `null` values retained in M1 evidence are SDK callback normalization, not proof that the raw CLI frame emits nullable fields.

## M4 capability policy

- Parse and retain unknown inner subtypes, but treat them as unsupported until an explicit bridge exists.
- Do not advertise SDK MCP servers, programmable hook callbacks, user-dialog handling, MCP elicitation, command approval variants, or persistent permission grants in this slice.
- A generic control error is not permission acceptance. Permission timeout behavior belongs to the fail-closed permission bridge.
- Synthetic conformance does not enable `persistentClaude`; raw live multi-query/resume/permission/interrupt/post-interrupt-resume proof remains blocked by the exhausted three-turn Claude budget.
