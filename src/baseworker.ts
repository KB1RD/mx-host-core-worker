import loglvl from 'loglevel'
import prefix from 'loglevel-plugin-prefix'
import chalk from 'chalk'
import { OptionalSerializable } from './storage'

// Import the browser matrix-js-sdk
import mx from 'matrix-js-sdk/lib/browser-index'
import * as LocalForage from 'localforage'

import * as core from './index'

type Level = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
const colors = {
  TRACE: chalk.magenta,
  DEBUG: chalk.cyan,
  INFO: chalk.blue,
  WARN: chalk.yellow,
  ERROR: chalk.red
}
function setupLoggerPrefix(logger: loglvl.Logger) {
  prefix.apply(logger, {
    format(level, name, timestamp) {
      return (
        chalk.gray('[' + timestamp + '] ') +
        chalk.green(name) +
        ' ' +
        colors[level.toUpperCase() as Level](level) +
        ':'
      )
    }
  })
}
prefix.reg(loglvl)

function createLog(name: string) {
  const logger = loglvl.getLogger(name)
  logger.setLevel('INFO')

  setupLoggerPrefix(logger)

  return logger
}

const storage_backend = {
  get(key: string): Promise<OptionalSerializable> {
    return LocalForage.getItem(key)
  },
  set(key: string, value: OptionalSerializable): Promise<void> {
    return LocalForage.setItem(key, value).then()
  }
}
const worker = new core.default({
  createLog,
  storage_backend,
  request: mx.getRequest()
})

worker.ononline()
onoffline = () => {
  worker.onoffline()
}
ononline = () => {
  worker.ononline()
}

export { worker }
