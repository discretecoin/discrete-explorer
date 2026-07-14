# Discrete Blockchain Explorer
Block explorer for Discrete, a post-quantum-only cryptocurrency.

It is a static single-page app: all data is fetched in the browser directly
from a `discreted` node over its JSON RPC. It understands post-quantum
transactions (ML-DSA-65 signatures, ML-KEM-768 stealth outputs, nullifiers),
bech32m `disc1…` / `tdisc1…` addresses, and on-chain account numbers
(`H-I-C` / `H-I-T-C`).

#### Installation

1) It takes data from the `discreted` daemon, which should be reachable from the browser. Run it with an open RPC port and CORS enabled:
```bash
./discreted --restricted-rpc --enable-cors=* --enable-blockchain-indexes --rpc-bind-ip=0.0.0.0 --rpc-bind-port=9331
```
2) Upload the files to any static web host and edit the `api` / `apiList` variables in `config.js` to point at your node(s).

#### Local development

```bash
node dev-server.js
```
serves the app at http://localhost:8080. The configured `discreted` RPC must
allow the explorer origin with `--enable-cors`.
