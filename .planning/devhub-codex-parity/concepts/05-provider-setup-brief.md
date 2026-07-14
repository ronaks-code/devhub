Use case: ui-mockup
Asset type: DevHub provider/model/mode/project setup concept
Governing input: Image 1 is the active-window empty native task capture. Preserve its measured shell and negative space. The setup surface is proposed DevHub UI.
Primary request: Rebrand to "DevHub" and show "New task". Open one compact setup popover anchored to the provider control in the stable composer. The popover has two text-only provider rows: "OpenAI · Codex" selected with a quiet green-gray dot, and "Anthropic · Claude" unselected with a quiet clay dot. No logos.
Setup fields: "Provider", "Model", "Mode", "Project", "Folder", "Permissions". For selected OpenAI show "Codex 5.6", reasoning "High", mode toggle "Code" / "Work" with Code selected, project "claude-ui", folder "…/active/claude-ui", permission "Workspace". Primary action "Create task".
Capability disclosure: Beneath the providers, exact text "Provider is fixed after creation. Fork to another provider to continue there." Show a compact Anthropic capability note: "Claude model selection unavailable until runtime support is verified." In a tiny diagnostic disclosure, show labels "Requested", "Session reported", "Response used", and warning "Model differs from request" to establish the future honest model presentation without pretending it is a normal selector.
Visible text (verbatim): "DevHub", "New task", "Provider", "OpenAI · Codex", "Anthropic · Claude", "Model", "Codex 5.6", "High", "Mode", "Code", "Work", "Project", "claude-ui", "Folder", "…/active/claude-ui", "Permissions", "Workspace", "Create task", "Provider is fixed after creation. Fork to another provider to continue there.", "Claude model selection unavailable until runtime support is verified.", "Requested", "Session reported", "Response used", "Model differs from request".
Classification: Codex model inventory is verified; Claude requested/init/actual model divergence is verified, so reliable Claude model selection stays gated. Provider lock and setup are proposed DevHub behavior.
Style/medium: shippable dark macOS UI; compact popover, not a wizard or settings dashboard.
Composition/framing: keep the blank canvas and measured composer/inspector geometry; popover floats just above the provider control with correct focus hierarchy.
Constraints: provider-specific permission names; no editable provider on an existing task; no provider logos; no raw OpenAI chat labeled Codex; no watermark.
Avoid: large onboarding cards, stepper wizard, decorative provider tiles, gradient brand colors, generic SaaS form page.
Quality: high
