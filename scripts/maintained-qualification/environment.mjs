import path from 'node:path'

export const toolEnvironment = (root, tools, rendererRuntime) => ({
  ...process.env,
  ...tools.environment,
  // Genie silently emits raw text when it cannot find oxfmt. Generation and
  // validation must therefore share the declared profile, not ambient tools.
  PATH: [
    path.dirname(process.execPath),
    path.dirname(tools.commands.pnpm[0]),
    path.dirname(tools.commands.format[0]),
    path.dirname(tools.commands.genie[0]),
    process.env.PATH,
  ]
    .filter(Boolean)
    .join(path.delimiter),
  ASTRO_TELEMETRY_DISABLED: '1',
  GITHUB_BRANCH_NAME: 'sdk-local-preview',
  WORKSPACE_ROOT: root,
  ...(rendererRuntime === undefined ? {} : { PLAYWRIGHT_BROWSERS_PATH: rendererRuntime }),
})
