# Codex App-Server Bindings

Generated from the installed arm64 `codex-cli 0.144.1` binary with:

```bash
codex app-server generate-json-schema --out codex-0.144.1/json-schema
codex app-server generate-ts --out codex-0.144.1/typescript
```

- Stable JSON Schema files: 267
- Stable TypeScript files: 598
- Generated size: 5.8 MiB
- `codex-0.144.1/SHA256SUMS` digest: `261ceff557260a6ad05fb5a429bce30991d0e962e5f57fe2a4cad3058cd3f63e`
- Binary SHA-256: `29915529b97697def1a957b0505e770aa6a45744435d62fc263e98d7619e167a`

`fallback/protocol.ts` is the compact compatibility surface DevHub will retain when a newer installed binary cannot be generated or contains incompatible additions. The runtime must still capability-probe every method; the fallback is not permission to advertise a feature.

No experimental generated files are retained here. Experimental methods remain opt-in and isolated.
