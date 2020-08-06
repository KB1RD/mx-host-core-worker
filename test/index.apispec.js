const { expect } = require('chai')

const { MessageChannel } = require('worker_threads')

const setupWorker = require('./worker-setup')

describe('[CORE] index.ts', () => {
  let worker, logentries, testlog
  beforeEach(function () {
    ;({ worker, logentries, testlog } = setupWorker())
  })
  afterEach(function () {
    if (this.currentTest.state !== 'passed') {
      testlog.error(
        `Test '${this.currentTest.title}' failed. Printing to log...`
      )
      logentries.forEach((s) => console.log(s))
    }
  })

  describe('onconnect', () => {
    let channel
    beforeEach(() => {
     channel = new MessageChannel()
    })
    afterEach(() => {
      channel.port1.close()
      channel.port2.close()
    })
    it('sets up rpc channel with registry', function () {
      worker.onconnect(channel.port1)
      const channels = [...worker.channels]
      expect(channels.length).to.be.equal(1)
      expect(channels[0].reg).to.be.equal(worker.registry)
      channel.port1.close()
      channel.port2.close()
    })
    it('sets up rpc channel to send to other port', async function () {
      const messages = []
      channel.port2.onmessage = (m) => {
        messages.push(m.data)
      }
      worker.onconnect(channel.port1)

      const data = 'sdfsdfdfsdfsdfdsfs'

      const channels = [...worker.channels]
      channels[0].send([], [data])
      await new Promise((r) => setTimeout(r, 5))

      expect(messages).to.be.deep.equal([{
        to: [],
        args: [data],
        return_addr: undefined,
        return_type: 'promise'
      }])
    })
  })
})