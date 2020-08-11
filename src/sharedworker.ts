import { worker } from './baseworker'

// eslint-disable-next-line prefer-const
declare let onconnect: undefined | null | ((e: MessageEvent) => void)

// For some unknown reason, ESLint is ignoring the disable comment above and,
// IMO, saving 16 characters is not the effort.
onconnect = null
onconnect = (e: MessageEvent) => {
  if (!e.ports || !e.ports[0]) {
    return
  }
  worker.onconnect(e.ports[0])
}

export { worker }
