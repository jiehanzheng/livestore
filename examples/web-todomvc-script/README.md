# Web Script Example

Minimal web script example based on the TodoMVC schema.

## Running locally

```bash
pnpm install
pnpm dev
```

## Retained-store regression

From the LiveStore repository root, run:

```bash
node --test examples/web-todomvc-script/test/reopen.regression.ts
```

This uses the repository's Node adapter to run the script's event factories twice
against retained SQLite data without adding a Node adapter to the browser demo.
The filename keeps this Node regression separate from Playwright's discovery.
