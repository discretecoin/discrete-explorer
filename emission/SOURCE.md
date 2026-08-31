# XDS emission explorer source

This static export was built in a detached checkout of the immutable source commit:

https://github.com/MatthewFreeman/discrete-explorer/tree/f26d090fa7418a6395bc18d9caafc51d03edfadc

Rebuild from that clean checkout with:

```text
npm ci
npm run explorer:build
```

The build uses the committed npm lockfile, and the deterministic Next build ID is
the full source commit. The export manifest lists every generated file other than
the manifest itself with its SHA-256.

The emission model is pinned to Discrete consensus commit
`7311efa2775af3409e167e4fc1521b024c2d4d21`. Exact block ranges are authoritative;
projected dates assume the 90-second target cadence.

The `Today` position is shown only when both fixed public Explorer RPC nodes
agree on the exact tip hash, height, timestamp, generated supply, and next
reward. On disagreement or single-node availability, the page fails closed to
the code-derived static model.
