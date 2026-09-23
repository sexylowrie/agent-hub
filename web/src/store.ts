import { useEffect, useReducer } from 'preact/hooks'

export interface Store<T> {
  get(): T
  set(v: T): void
  subscribe(fn: () => void): () => void
}

export function createStore<T>(init: T): Store<T> {
  let v = init
  const subs = new Set<() => void>()
  return {
    get: () => v,
    set(n) {
      v = n
      for (const f of subs) f()
    },
    subscribe(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

export function useStore<T>(s: Store<T>): T {
  const [, force] = useReducer((x: number, _: void) => x + 1, 0)
  useEffect(() => s.subscribe(() => force()), [s])
  return s.get()
}
