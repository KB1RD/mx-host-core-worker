import { worker } from './baseworker'

// eslint-disable-next-line
declare let onconnect: (e: MessageEvent) => void

onconnect = (e: MessageEvent) => {
  if (!e.ports || !e.ports[0]) {
    return
  }
  worker.onconnect(e.ports[0])
}

export { worker }
