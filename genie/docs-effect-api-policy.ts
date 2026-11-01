/**
 * These recipes intentionally use the reviewed official Effect 4.1 APIs for their existing jobs.
 * Opt in per exact export and file so unrelated experimental APIs still fail the strict compiler gate.
 * Runtime and test consumers remain separate entries; no severity or exit-code setting is changed.
 */
export const docsEffectApiPolicy = {
  runtime: [],
  diagnosticOverrides: [
    {
      // Each history operation owns the HTTP and ephemeral session KV required by its public backend constructor.
      include: ['reference/mcp/history.ts'],
      options: {
        allowedUnstableApis: ['effect/http/FetchHttpClient#layer', 'effect/persistence/KeyValueStore#layerMemory'],
      },
    },
    // Build the documented derived atom through the chosen official Effect integration.
    {
      include: ['patterns/effect/derived-example/derived.ts'],
      options: { allowedUnstableApis: ['effect/reactivity/Atom#make'] },
    },
    // Preserve optimistic updates without returning to the incompatible Effect 3 bridge.
    {
      include: ['patterns/effect/optimistic-example/optimistic.ts'],
      options: { allowedUnstableApis: ['effect/reactivity/Atom#make'] },
    },
    // Expose the ready Store query as an official reactive atom.
    {
      include: ['patterns/effect/store-setup/queries.ts'],
      options: { allowedUnstableApis: ['effect/reactivity/Atom#make'] },
    },
    // Bind the public Store subscription to the atom lifetime.
    {
      include: ['patterns/effect/store-setup/query-atom.ts'],
      options: { allowedUnstableApis: ['effect/reactivity/Atom#make'] },
    },
    // Subscribe React UI to the owned query atoms through the official hook.
    {
      include: ['patterns/effect/store-setup/user-list.tsx'],
      options: { allowedUnstableApis: ['@effect/atom-react/Hooks#useAtomValue'] },
    },
    // Construct the batch and derived atoms documented by this recipe.
    {
      include: ['patterns/effect/store-setup/utils.ts'],
      options: { allowedUnstableApis: ['effect/reactivity/Atom#make'] },
    },
    // Drive a real registry to verify invalidation and subscription cleanup.
    {
      include: ['recipes/query-atom.test.ts'],
      options: { allowedUnstableApis: ['effect/reactivity/AtomRegistry#make'] },
    },
    // Public backend constructors require HTTP and session KV for accepted-history transfer.
    {
      include: ['reference/cli/sync-events-node.ts'],
      options: {
        allowedUnstableApis: ['effect/http/FetchHttpClient#layer', 'effect/persistence/KeyValueStore#layerMemory'],
      },
    },
    // Exercise the actual Cloudflare transport with its public HTTP and session services.
    {
      include: ['reference/cli/sync-events-runtime.spec.ts'],
      options: {
        allowedUnstableApis: ['effect/http/FetchHttpClient#layer', 'effect/persistence/KeyValueStore#layerMemory'],
      },
    },
    // Keep the coach on the official AI provider, model service, and HTTP transport.
    {
      include: ['reference/mcp/coach.ts'],
      options: {
        allowedUnstableApis: [
          '@effect/ai-openai/OpenAiClient#layer',
          '@effect/ai-openai/OpenAiLanguageModel#layer',
          'effect/ai/LanguageModel#LanguageModel',
          'effect/http/FetchHttpClient#layer',
        ],
      },
    },
    // Own the standalone stdio process through the official Node runtime.
    {
      include: ['reference/mcp/node-server.ts'],
      options: { allowedUnstableApis: ['@effect/platform-node/NodeRuntime#runMain'] },
    },
    // Verify readonly SQL and resource cleanup against actual filesystem-backed SQLite.
    {
      include: ['reference/mcp/readonly-query.test.ts'],
      options: { allowedUnstableApis: ['@effect/platform-node/NodeFileSystem#layer'] },
    },
    // Supply the normal Node filesystem to the public SQLite readonly capability.
    {
      include: ['reference/mcp/readonly-query.ts'],
      options: { allowedUnstableApis: ['@effect/platform-node/NodeFileSystem#layer'] },
    },
    // Exercise the same transport context used by the runtime without live provider credentials.
    {
      include: ['reference/mcp/runtime.test.ts'],
      options: {
        allowedUnstableApis: ['effect/http/FetchHttpClient#layer', 'effect/persistence/KeyValueStore#layerMemory'],
      },
    },
    // Register the preserved tools, resources, and exact supported protocol versions on owned stdio.
    {
      include: ['reference/mcp/server.ts'],
      options: {
        allowedUnstableApis: [
          '@effect/platform-node/NodeStdio#layer',
          'effect/ai/McpProtocol#v2024_11_05',
          'effect/ai/McpProtocol#v2025_03_26',
          'effect/ai/McpProtocol#v2025_06_18',
          'effect/ai/McpProtocol#v2025_11_25',
          'effect/ai/McpProtocol#v2026_07_28',
          'effect/ai/McpServer#layerStdio',
          'effect/ai/McpServer#resource',
          'effect/ai/McpServer#toolkit',
          'effect/http/FetchHttpClient#layer',
          'effect/persistence/KeyValueStore#layerMemory',
        ],
      },
    },
    // Define the existing typed tools; readonly annotations do not replace the tested SQL guard.
    {
      include: ['reference/mcp/toolkit.ts'],
      options: {
        allowedUnstableApis: [
          'effect/ai/Tool#EmptyParams',
          'effect/ai/Tool#Readonly',
          'effect/ai/Tool#make',
          'effect/ai/Toolkit#make',
        ],
      },
    },
    // Observe a real background-worker event through the public sync backend transports.
    {
      include: ['reference/platform-adapters/node-adapter/worker-sync.spec.ts'],
      options: {
        allowedUnstableApis: ['effect/http/FetchHttpClient#layer', 'effect/persistence/KeyValueStore#layerMemory'],
      },
    },
  ],
} as const
