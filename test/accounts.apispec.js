const { expect } = require('chai')

const { MessageChannel } = require('worker_threads')
const { RpcChannel } = require('rpcchannel')

const setupWorker = require('./worker-setup')

describe('[accounts v0] accounts.ts', () => {
  let worker, logentries, testlog
  let rpc
  let aapi
  let shutdown
  let generate
  let vstore
  beforeEach(async function () {
    ;({ worker, logentries, testlog, vstore } = setupWorker())
    const channel = new MessageChannel()
    worker.onconnect(channel.port1)
    rpc = new RpcChannel((msg, xfer) => channel.port2.postMessage(msg, xfer))
    channel.port2.onmessage = (msg) => rpc.receive(msg.data)
    aapi = rpc.call_obj.net.kb1rd.accounts.v0
    generate = (...addr) => {
      return rpc.generate(['net', 'kb1rd', 'accounts', 'v0', ...addr])
    }

    await rpc.call_obj.net.kb1rd.services.requestServices(
      { id: ['net', 'kb1rd', 'accounts'], versions: [[0, 1]]}
    )

    shutdown = () => {
      channel.port1.close()
      channel.port2.close()
    }
  })
  afterEach(function () {
    if (this.currentTest.state !== 'passed') {
      testlog.error(
        `Test '${this.currentTest.title}' failed. Printing to log...`
      )
      logentries.forEach((s) => console.log(s))
    }
    shutdown()
  })

  describe('createAccount', () => {
    it('creates unique key', async function () {
      const accounts = new Set()
      for (let i = 0; i < 32; i++) {
        const key = await aapi.createAccount()
        expect(accounts).to.not.include(key)
        accounts.add(key)
      }
    })
    it('creates a 128-bit account ID string (32 nibbles)', async function () {
      expect((await aapi.createAccount()).length).to.be.equal(32)
    })
    it('stores new account list', async function () {
      const accounts = new Set()
      for (let i = 0; i < 32; i++) {
        const key = await aapi.createAccount()
        accounts.add(key)
      }
      const stored_list = JSON.parse(vstore['accounts.list'])
      for (const id of stored_list) {
        expect(accounts).to.include(id)
      }
    })
  })
  describe('getAccounts', () => {
    it('returns a list of all accounts', async function () {
      const accounts = []
      for (let i = 0; i < 32; i++) {
        accounts.push(await aapi.createAccount())
      }
      const fetched = await aapi.getAccounts()
      expect(fetched).to.have.deep.members(accounts)
      expect(accounts).to.have.deep.members(fetched)
    })
  })
  describe('doesHave', () => {
    it('returns true if account present', async function () {
      const key = await aapi.createAccount()
      expect(await aapi[key].exists()).to.be.true
    })
    it('returns false if account not present', async function () {
      await aapi.createAccount()
      expect(await aapi['notakey'].exists()).to.be.false
    })
  })
  describe('listenAccounts', () => {
    it('returns a list of all accounts', async function () {
      const accounts = []
      for (let i = 0; i < 32; i++) {
        accounts.push(await aapi.createAccount())
      }
      const { value } = await generate('listenAccounts').next()
      expect(value).to.have.deep.members(accounts)
      expect(accounts).to.have.deep.members(value)
    })
    it('pushes update when new account', async function () {
      const accounts = []
      for (let i = 0; i < 32; i++) {
        accounts.push(await aapi.createAccount())
      }
      const gen = generate('listenAccounts')
      let { value } = await gen.next()
      expect(value).to.have.deep.members(accounts)
      expect(accounts).to.have.deep.members(value)

      const next_promise = gen.next()
      accounts.push(await aapi.createAccount())
      ;({ value } = await next_promise)
      expect(value).to.have.deep.members(accounts)
      expect(accounts).to.have.deep.members(value)
    })
  })
})