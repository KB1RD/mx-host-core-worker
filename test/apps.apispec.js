const { expect } = require('chai')

const MockHttpBackend = require('matrix-mock-request')

const { MessageChannel } = require('worker_threads')
const { RpcChannel } = require('rpcchannel')

const setupWorker = require('./worker-setup')

const expectAsyncThrow = async function (promise, ...args) {
  let error = undefined
  await promise.then(
    () => undefined,
    (e) => (error = e)
  )
  expect(() => { throw error }).to.throw(...args)
}

describe('[matrix v0] matrix/index.ts', () => {
  let worker, logentries, vstore, testlog, rpc, aapi, shutdown, generate, http
  let oldlog
  beforeEach(async function () {
    http = new MockHttpBackend()
    const opts = { request: http.requestFn }
    ;({ worker, logentries, vstore, testlog } = setupWorker(opts))

    const channel = new MessageChannel()
    worker.onconnect(channel.port1)
    rpc = new RpcChannel((msg, xfer) => channel.port2.postMessage(msg, xfer))
    channel.port2.onmessage = (msg) => rpc.receive(msg.data)
    aapi = rpc.call_obj.net.kb1rd.mxbindings.v0
    generate = (...addr) => {
      return rpc.generate(['net', 'kb1rd', 'mxbindings', 'v0', ...addr])
    }

    await rpc.call_obj.net.kb1rd.services.requestServices(
      { id: ['net', 'kb1rd', 'apps'], versions: [[0, 1]]}
    )

    oldlog = console.log
    console.log = (...args) => {
      testlog.log(args.join(' '))
    }

    shutdown = () => {
      channel.port1.close()
      channel.port2.close()
    }
  })
  afterEach(function () {
    console.log = oldlog
    if (this.currentTest.state !== 'passed') {
      testlog.error(
        `Test '${this.currentTest.title}' failed. Printing to log...`
      )
      logentries.forEach((s) => console.log(s))
    }
    shutdown()
  })

  const mxClientStart = async function (
    id,
    intermediate = () => undefined,
    sync_response = {
      next_batch: 'batch_token',
      rooms: {},
      presence: {}
    }
  ) {
    const promise = aapi[id].start()
    // Polling push rules is assumed to signal that the Matrix client has
    // started successfully. These tests also assume that the Matrix JS SDK
    // has no bugs.
    http
      .when('GET', '/_matrix/client/r0/pushrules/')
      .check((req) => {
        expect(req.opts.uri).to.be.equal(
          'https://matrix.example.com/_matrix/client/r0/pushrules/'
        )
        expect(req.opts.headers.Authorization).to.be.equal('Bearer abc123')
      })
      .respond(200, {
        global: {
          content: [],
          override: [],
          room: [],
          sender: [],
          underride: []
        }
      })
    http
      .when('GET', '/_matrix/client/versions')
      .check((req) => {
        expect(req.opts.uri).to.be.equal(
          'https://matrix.example.com/_matrix/client/versions'
        )
      })
      .respond(200, {
        versions: ['r0.0.1']
      })
    await http.flushAllExpected()

    await intermediate()

    http
      .when('POST', '/_matrix/client/r0/user/%40alice%3Aexample.com/filter')
      .respond(200, { filter_id: 'abc123' })
    http.when('GET', '/_matrix/client/r0/sync').respond(200, sync_response)
    await http.flushAllExpected()
    await promise
  }

  const setCredentials = (id, cred) => {
    vstore[
      `accounts/${id}/net.kb1rd.mxbindings.credentials`
    ] = JSON.stringify(cred)
  }
  const basicClientTest = (cb) => async () => {
    const id = await rpc.call_obj.net.kb1rd.accounts.v0.createAccount()
    setCredentials(id, {
      mxid: '@alice:example.com',
      token: 'abc123',          
      hs: 'https://matrix.example.com'
    })
    await mxClientStart(id)
    await cb(id)
    await aapi[id].stop()
  }

  describe('fetchAndVerifyManifest', () => {
    let apps
    beforeEach(() => {
      ;({ apps } = rpc.call_obj.net.kb1rd)
    })
    it('fetches valid manifest', async () => {
      const manifest = {
        manifest_version: 0,
        title: { en: 'Test App!' },
        version: [0, 1, 0],
        entry_points: {},
        request_permissions: []
      }
      http
        .when(
          'GET',
          '/example/manifest/url.json'
        )
        .respond(200, manifest)
      const promise = apps.v0.app
        ['https://example.com/example/manifest/url.json']
        .fetchAndVerifyManifest()
      await http.flushAllExpected()
      expect(await promise).to.be.deep.equal(manifest)
    })
    it('throws error with invalid manifest', async () => {
      const manifest = { manifest_version: -1 }
      http
        .when(
          'GET',
          '/example/manifest/url.json'
        )
        .respond(200, manifest)
      const promise = apps.v0.app
        ['https://example.com/example/manifest/url.json']
        .fetchAndVerifyManifest()
      await http.flushAllExpected()
      await expectAsyncThrow(promise, 'validation failed')
    })
  })
})