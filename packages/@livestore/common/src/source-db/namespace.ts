/** Native hosts may also contain application tables outside the reserved SDK namespace. */
export const hasRetainedSourceNamespace = (tables: ReadonlySet<string>): boolean =>
  [...tables].some(
    (name) =>
      name === 'eventlog' ||
      name.startsWith('__livestore_') ||
      name === 'vfs_pages' ||
      name === 'vfs_files' ||
      name === 'vfs_blocks',
  )
