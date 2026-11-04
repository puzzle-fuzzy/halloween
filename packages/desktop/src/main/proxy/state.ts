/** shared mutable runtime state — plain object, mutated in place */
export interface RuntimeState {
  running: boolean
  busy: boolean
  sysProxy: boolean
  mixedPort: number
  ctrlPort: number
  lastError: string
  tunReady: boolean
}

export const state: RuntimeState = {
  running: false,
  busy: false,
  sysProxy: false,
  mixedPort: 0,
  ctrlPort: 0,
  lastError: '',
  tunReady: false,
}
