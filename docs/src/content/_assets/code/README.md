## TODO

- [ ] Reuse/import code from examples more directly instead of copying it into this directory. This will require some further work on the `vite-plugin-snippet` to support this (i.e. resolve node_modules from the import example path).

## Dependencies

Use the standalone workspace package here to keep docs dependencies small. Declare snippet dependencies in `package.json.genie.ts`, regenerate its manifest with the canonical repository generator, and update the normal pnpm lockfile. Verify the result with a frozen strict-peer install.

## Type checking

`tsconfig.json` here mirrors the Twoslash compiler options. Use it when you need to run focused TypeScript checks for snippets.

Plain TypeScript checking does not cover Vue templates. Vue examples also need
the actual SFC renderer/type checks; missing package declarations or excluded
`.vue` files cannot qualify them.

Expo snippets live in the `native/` workspace so their actual Expo, React Native,
and React types resolve together instead of leaking into the browser examples.
The Expo guide imports that workspace directly; platform declaration stubs must
not stand in for the installed native APIs.

Each runnable schema declares an example-specific `projectionRevision`. Keep it
stable until its materialization behavior changes: it identifies the projection
that may safely be reused with retained events, not the version of the prose.
