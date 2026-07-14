# Disposable shadcn Brownfield Preview

Captured against `shadcn` CLI `4.13.0`. No real-workspace shadcn file or dependency was changed.

## Baseline

Real workspace `pnpm dlx shadcn@latest info --json`:

- Framework: Vite.
- React Server Components: false.
- TypeScript: true.
- Tailwind: v4.
- CSS: `src/index.css`.
- Import alias: absent.
- `components.json`: absent.
- Installed shadcn components: none.

Disposable copy:

`/private/tmp/devhub-shadcn-preview-20260713T005136Z`

Excluded from the copy: `.git`, `node_modules`, `dist`, `.turbo`, Rust `target`, and real `.planning` artifacts.

## Deliberate alias preview

The disposable copy added only:

```json
// apps/web/tsconfig.json
"baseUrl": ".",
"paths": {
  "@/*": ["./src/*"]
}
```

```ts
// apps/web/vite.config.ts
import path from "path";

resolve: {
  alias: {
    "@": path.resolve(__dirname, "./src"),
  },
},
```

After this change, `shadcn info --json` correctly reported `importAlias:"@"` while preserving Vite, `rsc:false`, TypeScript, Tailwind v4, and `src/index.css`.

The Vite alias is only a preview. Before real adoption, typecheck/build must confirm whether the current ESM config should instead use `fileURLToPath(new URL("./src", import.meta.url))`; no NodeNext assumption is accepted without the gate.

## Initialization command and result

Command:

```bash
pnpm dlx shadcn@latest init \
  --base radix \
  --css-variables \
  --no-monorepo \
  --no-rtl \
  --no-pointer
```

Forbidden flags were not used: no `--defaults`, `--preset`, `--force`, `--reinstall`, `--overwrite`, or bulk add.

CLI 4.13.0 still required a named preset choice. The named Nova/Vega/Maia/Lyra/Mira/Luma/Sera/Rhea choices were rejected. Selecting `Custom` did not initialize the project; it printed a shadcn/create URL and asked to open a browser. Browser navigation was declined.

Post-command verification:

- Exit: 0.
- `components.json`: still absent.
- Config/preset: null.
- Components: none.
- Diff against the pre-command disposable snapshot: empty.

## Upstream constraint

The current fixed requirements conflict:

1. use `pnpm dlx shadcn@latest init`;
2. use Radix;
3. do not use presets;
4. CLI 4.13.0 requires a named preset or a custom preset produced by shadcn/create.

No silent workaround is selected. The single design/plan gate must include one recommended deviation:

- Recommended: allow one explicit Radix custom preset generated from the locked design-system choices, inspect its full init diff in a disposable copy, and apply only if it preserves the existing CSS, `cn()`, dependencies, and aliases.
- Alternative: manually author official-schema `components.json` and skip `init`; this violates the current initialization requirement and is not recommended.
- Rejected: choose a named visual preset and later restyle it; that introduces unapproved default design decisions.

## Real-workspace safety result

The preview proves the alias detection path and proves that current no-preset initialization is a no-op. It does not authorize any real shadcn initialization. Real adoption remains post-design-approval and must rerun this preview with the user-approved deviation.
