---
title: Debugging a LiveStore app
sidebar:
  label: Debugging
  order: 52
---

When working on a LiveStore app you might end up in situations where you need to debug things. LiveStore is built with debuggability in mind and tries to make your life as a developer as easy as possible.

Here are a few things that LiveStore offers to help you debug your app:

- [OpenTelemetry](/building-with-livestore/opentelemetry) integration for tracing / metrics
- Platform debugging tools for inspecting the application and its store
- Store helper methods

## Debugging helpers on the store

The `store` exposes a `_dev` property which contains a few helpers that can help you debug your app.

## Other recommended practices and tools

### Expo

Use Expo's development menu to open React Native DevTools, then inspect the
component tree, console output and JavaScript breakpoints. The selected Expo
adapter requires `disableDevtools: true` in store configuration. Follow the
official debugging guide for the matching Expo development build. [Expo
debugging tools](https://docs.expo.dev/debugging/tools/)

### Node.js

Start the application with `node --inspect-brk path/to/entry.mjs` to pause before
executing its entry point. Attach a Node-compatible debugger, then place
breakpoints in store setup or the event handler being investigated. Use a
separate filesystem storage directory for a disposable debugging fixture and
close its store with `await store.shutdownPromise()` before another process
opens that directory. [Node.js debugger](https://nodejs.org/api/debugger.html)

The selected Node adapter requires `disableDevtools: true`. Its eventlog and
derived state belong to the calling process.
