import { worker } from './baseworker'

onmessage = (e: MessageEvent) => worker.onmessage(e)
onmessageerror = (e: MessageEvent) => worker.onmessageerror(e)

export { worker }
