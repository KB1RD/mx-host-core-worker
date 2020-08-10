import { worker } from './baseworker'

// TypeScript doesn't have this typed yet I guess
onconnect = (e: MessageEvent) => {
  if (!e.ports || !e.ports[0]) {
    return
  }
  worker.onconnect(e.ports[0])
}

export { worker }
