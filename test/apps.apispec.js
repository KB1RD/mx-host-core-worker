const { expect } = require('chai')

const MockHttpBackend = require('matrix-mock-request')

const { MessageChannel } = require('worker_threads')
const { RpcChannel } = require('rpcchannel')

const setupWorker = require('./worker-setup')

const expectAsyncThrow = async function (promise, ...args) {
  let error = undefined
  await promise.then(
    () => undefined,
    (e) => ((error = e) && undefined)
  )
  expect(() => { throw error }).to.throw(...args)
}

describe('[apps v0] matrix/index.ts', () => {
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
    aapi = rpc.call_obj.net.kb1rd.apps.v0
    generate = (...addr) => {
      return rpc.generate(['net', 'kb1rd', 'apps', 'v0', ...addr])
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
      const promise = aapi.app
        ['https://example.com/example/manifest/url.json']
        .fetchAndVerifyManifest()
      await http.flushAllExpected()
      expect(await promise).to.be.deep.equal({
        manifest,
        known_permissions: {},
        unknown_permissions: []
      })
    })
    it('throws error with invalid manifest', async () => {
      const manifest = { manifest_version: -1 }
      http
        .when(
          'GET',
          '/example/manifest/url.json'
        )
        .respond(200, manifest)
      const promise = aapi.app
        ['https://example.com/example/manifest/url.json']
        .fetchAndVerifyManifest()
      await http.flushAllExpected()
      await expectAsyncThrow(promise, 'validation failed')
    })
    it('properly sorts requested permissions', async () => {
      const manifest = {
        manifest_version: 0,
        title: { en: 'Test App!' },
        version: [0, 1, 0],
        entry_points: {},
        request_permissions: ['not.a.real.permission', 'a.openroom.state.set']
      }
      http
        .when(
          'GET',
          '/example/manifest/url.json'
        )
        .respond(200, manifest)
      const promise = aapi.app
        ['https://example.com/example/manifest/url.json']
        .fetchAndVerifyManifest()
      await http.flushAllExpected()
      expect(await promise).to.be.deep.equal({
        manifest,
        known_permissions: {
          ['a.openroom.state.set']: { inherits: ['a.openroom.state.get'] },
          ['a.openroom.state.get']: { inherits: [] }
        },
        unknown_permissions: ['not.a.real.permission']
      })
    })
  })
  const addTestApp = async () => {
    await aapi['abc123'].userapp['https://example.com/app.json'].setup({
      manifest_version: 0,
      title: { en: 'Hello World App' },
      version: [0, 1, 0],
      entry_points: {},
      request_permissions: []
    })
  }
  describe('app setup/listening', () => {
    it('`setup` throws error with invalid manifest', async () => {
      await expectAsyncThrow(
        aapi['abc123'].userapp['https://example.com/app.json'].setup({
          manifest_version: -1
        }),
        'validation failed'
      )
    })
    it('list responds to new app additions', async () => {
      const apps = generate('abc123', 'userapp', 'listen')
      expect((await apps.next()).value).to.be.deep.equal([])
      await addTestApp()
      expect((await apps.next()).value).to.be.deep.equal([
        'https://example.com/app.json'
      ])
    })
    describe('app details', () => {
      it('app details responds to new app additions', async () => {
        const apps = generate(
          'abc123', 'userapp', 'https://example.com/app.json', 'listen'
        )
        expect((await apps.next()).value).to.be.deep.equal(undefined)
        await aapi['abc123'].userapp['https://example.com/app.json'].setup({
          manifest_version: 0,
          title: { en: 'Hello World App' },
          description: { en: 'Just a test ;)' },
          version: [0, 1, 0],
          entry_points: {},
          request_permissions: []
        })
        expect((await apps.next()).value).to.be.deep.equal({
          version: [0, 1, 0],
          title: 'Hello World App',
          description: 'Just a test ;)'
        })
      })
      it('app details defaults to `en-US`', async () => {
        await aapi['abc123'].userapp['https://example.com/app.json'].setup({
          manifest_version: 0,
          title: { ['en-US']: 'a', en: 'b' },
          version: [0, 1, 0],
          entry_points: {},
          request_permissions: []
        })
        const apps = generate(
          'abc123', 'userapp', 'https://example.com/app.json', 'listen'
        )
        expect((await apps.next()).value).to.be.deep.equal({
          version: [0, 1, 0],
          title: 'a',
          description: undefined
        })
      })
      it('app details falls back to similar language', async () => {
        await aapi['abc123'].userapp['https://example.com/app.json'].setup({
          manifest_version: 0,
          title: { ['en-GB']: 'a', ['??']: 'b' },
          version: [0, 1, 0],
          entry_points: {},
          request_permissions: []
        })
        const apps = generate(
          'abc123', 'userapp', 'https://example.com/app.json', 'listen'
        )
        expect((await apps.next()).value).to.be.deep.equal({
          version: [0, 1, 0],
          title: 'a',
          description: undefined
        })
      })
      it('app details uses any available language if no others', async () => {
        await aapi['abc123'].userapp['https://example.com/app.json'].setup({
          manifest_version: 0,
          title: { ['??']: 'b' },
          version: [0, 1, 0],
          entry_points: {},
          request_permissions: []
        })
        const apps = generate(
          'abc123', 'userapp', 'https://example.com/app.json', 'listen'
        )
        expect((await apps.next()).value).to.be.deep.equal({
          version: [0, 1, 0],
          title: 'b',
          description: undefined
        })
      })
    })
  })

  describe('permissions', () => {
    it('set fails if app not set up', async () => {
      await expectAsyncThrow(
        aapi['abc123'].userapp['https://example.com/app.json'].perms.set({}),
        'App not registered on account'
      )
    })
    it('listen returns empty if not set up', async () => {
      const promise = aapi['abc123']
        .userapp['https://example.com/app.json']
        .perms
        .listen()
      expect(await promise).to.be.deep.equal([])
    })
    it('basic set/get assigns `true` permissions', async () => {
      await addTestApp()
      await aapi['abc123'].userapp['https://example.com/app.json'].perms.set({
        ['example.permission']: true,
        ['disabled.permission']: false,
        ['another.permission']: true
      })
      const promise = aapi['abc123']
        .userapp['https://example.com/app.json']
        .perms
        .listen()
      expect(await promise).to.be.deep.equal([
        'example.permission',
        'another.permission'
      ])
    })
    it('set/get to false', async () => {
      await addTestApp()
      await aapi['abc123'].userapp['https://example.com/app.json'].perms.set({
        ['example.permission']: true,
        ['disabled.permission']: true,
        ['another.permission']: true
      })
      const gen = generate(
        'abc123', 'userapp', 'https://example.com/app.json', 'perms', 'listen'
      )
      expect((await gen.next()).value).to.be.deep.equal([
        'example.permission',
        'disabled.permission',
        'another.permission'
      ])
      await aapi['abc123'].userapp['https://example.com/app.json'].perms.set({
        ['disabled.permission']: false
      })
      expect((await gen.next()).value).to.be.deep.equal([
        'example.permission',
        'another.permission'
      ])
    })
  })

  describe('associations', () => {
    it('listen defaults to undefined', async () => {
      const promise = aapi['abc123']
        .assoc['net.kb1rd.plaintext']
        .listen()
      expect(await promise).to.be.equal(undefined)
    })
    it('get/set single association', async () => {
      await aapi['abc123'].assoc['net.kb1rd.plaintext'].set('https://url')
      const promise = aapi['abc123']
        .assoc['net.kb1rd.plaintext']
        .listen()
      expect(await promise).to.be.deep.equal({ to: 'https://url' })
    })
    it('listen returns whole association list', async () => {
      const gen = generate('abc123', 'assoc', 'listen')
      expect((await gen.next()).value).to.be.deep.equal({})

      await aapi['abc123'].assoc['net.kb1rd.plaintext'].set('https://url')
      expect((await gen.next()).value).to.be.deep.equal({
        ['net.kb1rd.plaintext']: { to: 'https://url' }
      })

      await aapi['abc123'].assoc['net.kb1rd.richtext'].set('https://url2')
      expect((await gen.next()).value).to.be.deep.equal({
        ['net.kb1rd.plaintext']: { to: 'https://url' },
        ['net.kb1rd.richtext']: { to: 'https://url2' }
      })
    })
    it('listen returns updates to same association', async () => {
      const gen = generate('abc123', 'assoc', 'listen')
      expect((await gen.next()).value).to.be.deep.equal({})

      await aapi['abc123'].assoc['net.kb1rd.plaintext'].set('https://url')
      expect((await gen.next()).value).to.be.deep.equal({
        ['net.kb1rd.plaintext']: { to: 'https://url' }
      })

      await aapi['abc123'].assoc['net.kb1rd.plaintext'].set('https://url2')
      expect((await gen.next()).value).to.be.deep.equal({
        ['net.kb1rd.plaintext']: { to: 'https://url2' }
      })
    })
  })
})