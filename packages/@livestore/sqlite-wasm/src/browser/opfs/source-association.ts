const associationBrand: unique symbol = Symbol('OpfsSourceAssociation')

export interface OpfsSourceAssociation {
  readonly [associationBrand]: true
}

type Binding = { directory: string; path: string; isHeld: () => boolean }
const bindings = new WeakMap<OpfsSourceAssociation, Binding>()

/** Records only the completed VFS association write, never a free pool or directory observation. */
export class OpfsSourceAssociations {
  readonly #pending = new Map<string, OpfsSourceAssociation>()
  constructor(readonly directory: string) {}

  record(path: string, isHeld: () => boolean): void {
    const receipt: OpfsSourceAssociation = Object.freeze({ [associationBrand]: true as const })
    bindings.set(receipt, { directory: this.directory, path, isHeld })
    this.#pending.set(path, receipt)
  }

  take(path: string): OpfsSourceAssociation | undefined {
    const receipt = this.#pending.get(path)
    this.#pending.delete(path)
    return receipt
  }
}

export const consumeOpfsSourceAssociation = (receipt: OpfsSourceAssociation, directory: string): (() => boolean) => {
  const binding = bindings.get(receipt)
  bindings.delete(receipt)
  if (
    binding === undefined ||
    binding.directory !== directory ||
    binding.path !== '/eventlog.db' ||
    binding.isHeld() === false
  ) {
    throw new Error('OPFS SOURCE association is missing, spent, foreign or no longer owned')
  }
  return binding.isHeld
}
