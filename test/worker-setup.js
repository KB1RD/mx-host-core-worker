const loglvl = require('loglevel')
const core = require('../dist/mx-host-core-worker')
const chalk = require('chalk')
const prefix = require('loglevel-plugin-prefix')

const colors = {
  TRACE: chalk.magenta,
  DEBUG: chalk.cyan,
  INFO: chalk.blue,
  WARN: chalk.yellow,
  ERROR: chalk.red
}
function setupLoggerPrefix(logger) {
  prefix.apply(logger, {
    format(level, name, timestamp) {
      return chalk.gray('[' + timestamp + '] ') +
        chalk.green(name) +
        ' ' +
        colors[level.toUpperCase()](level) +
        ':'
    }
  })
}
prefix.reg(loglvl)

function setup({ request } = {}) {
  const logentries = []
  function createLog(name) {
    const logger = loglvl.getLogger(name)
    logger.setLevel('DEBUG')

    logger.methodFactory = function () {
      return function (message) {
        logentries.push(message)
      }
    }
    logger.setLevel(logger.getLevel())

    setupLoggerPrefix(logger)

    return logger
  }

  const tl = createLog('TESTLOG')

  const vstore = {}
  
  // Simulate localstorage
  const storage_backend = {
    get(k) {
      return vstore[k] && JSON.parse(vstore[k])
    },
    set(k, v) {
      tl.info('SET', k, v)
      vstore[k] = JSON.stringify(v)
    }
  }

  const worker = new core.default({
    createLog,
    storage_backend,
    request: (data, ...other) => {
      tl.info(`Request to ${data.uri}`)
      return request(data, ...other)
    }
  })

  const onmessage = (m) => {
    if (m.data === 'online') {
      worker.ononline()
    } else if (m.data === 'offline') {
      worker.onoffline()
    } else {
      worker.onmessage(m)
    }
  }
  const onmessageerror = (m) => worker.onmessageerror(m)
  
  return { vstore, worker, testlog: tl, logentries, onmessage, onmessageerror }
}

module.exports = setup