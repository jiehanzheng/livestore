# Client DO projection regression

This fixture subclasses the unchanged production `LiveStoreClientDO` and adds one test-only observer RPC. The observer uses public `getStore()` and `Store.subscribe` to wait for a completed todo in that actual store. Normal HTTP routes and the sync backend delegate to the production demo unchanged.

A producer's push acknowledgement does not mean another store has materialized its projection. The test waits for the client DO's own subscriber condition before asserting its normal GET response. It adds no readiness or ordering guarantee to the production HTTP contract, and uses no polling or injected state.

From the example directory, reserve backend and inspector ports with `pfm port reserve`, then keep the normal local server in the foreground:

```sh
pnpm exec wrangler dev --config test/wrangler.observer.toml --local --ip 127.0.0.1 --port <backend-port> --inspector-port <inspector-port> --persist-to <task-owned-state-directory>
```

From the repository root, run:

```sh
CF_TODOMVC_ORIGIN=http://127.0.0.1:<backend-port> node --test examples/cloudflare-todomvc/test/projection.regression.ts
```

The test creates a unique synthetic store and removes its disposable Node-client files. Stop the server and release only its reserved roles afterward. The isolated server state may then be removed after preserving the result. Typecheck the worker fixture from the example directory with `pnpm exec tsc --noEmit --project test/tsconfig.json`.
