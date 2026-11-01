// Distinct local bindings keep type exports valid in both Babel 7 and Babel 8's global-augmentation scopes.
type Placeholder<_Reason extends string = 'unknown'> = any
export type { Placeholder as TODO, Placeholder as UNUSED }

declare global {
  export type TODO<Reason extends string = 'unknown'> = Placeholder<Reason>
  export type UNUSED<Reason extends string = 'unknown'> = Placeholder<Reason>

  interface ImportMeta {
    main: boolean
  }
}
