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
      { id: ['net', 'kb1rd', 'mxbindings'], versions: [[0, 2]]}
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

  describe('getHsUrl', () => {
    it('throws TypeError with non-parsable MXIDs', async function () {
      await expectAsyncThrow(aapi.getHsUrl['@alice'](), 'Invald mxid')
      await expectAsyncThrow(aapi.getHsUrl[':example.com'](), 'Invald mxid')
      await expectAsyncThrow(
        aapi.getHsUrl['@alice:hello:example.com'](),
        'Invald mxid'
      )
      await expectAsyncThrow(aapi.getHsUrl['fsdfsd'](), 'Invald mxid')
    })
    it('returns data from `.well-known`', async function () {
      http
        .when('GET', '/_matrix/client/versions')
        .check((req) => {
          expect(req.opts.uri).to.be.equal(
            'https://example2.org/_matrix/client/versions'
          )
        })
        .respond(200, {
            versions: ['r0.0.1']
        })
      http.when('GET', '/.well-known/matrix/client').respond(200, {
        'm.homeserver': {
          base_url: 'https://example2.org/'
        }
      })
      const promise = aapi.getHsUrl['@alice:example.com']()
      await http.flushAllExpected()
      expect(await promise).to.be.equal('https://example2.org')
    })
  })

  describe('fromToken', () => {
    it('stores data', async function () {
      const key = await aapi.fromToken['@alice:example.com'](
        'abc123',
        'https://matrix.example.com'
      )
      const store_value = JSON.parse(
        vstore[`accounts/${key}/net.kb1rd.mxbindings.credentials`]
      )
      expect(store_value).to.be.deep.equal({
        mxid: '@alice:example.com',
        token: 'abc123',
        hs: 'https://matrix.example.com'
      })
    })
    it('resolves HS URL if not provided', async function () {
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
      http.when('GET', '/.well-known/matrix/client').respond(200, {
        'm.homeserver': {
          base_url: 'https://matrix.example.com/'
        }
      })

      const key = aapi.fromToken['@alice:example.com']('abc123')
      await http.flushAllExpected()
      const store_value = JSON.parse(
        vstore[`accounts/${await key}/net.kb1rd.mxbindings.credentials`]
      )
      expect(store_value).to.be.deep.equal({
        mxid: '@alice:example.com',
        token: 'abc123',
        hs: 'https://matrix.example.com'
      })
    })
  })

  describe('fromPass', () => {
    it('stores data', async function () {
      http
        .when('POST', '/_matrix/client/r0/login')
        .check((req) => {
          expect(req.opts.uri).to.be.equal(
            'https://matrix.example.com/_matrix/client/r0/login'
          )
          const body = JSON.parse(req.opts.body)
          expect(body.type).to.be.equal('m.login.password')
          expect(body.user).to.be.equal('@alice:example.com')
          expect(body.password).to.be.equal('p@ssw0rd')
        })
        .respond(200, {
          user_id: '@alice:example.com',
          access_token: 'abc123',
          device_id: 'GHTYAJCE',
          well_known: {
            'm.homeserver': {
              base_url: 'https://matrix.example.com'
            }
          }
        })
      const promise = aapi.fromPass['@alice:example.com'](
        'p@ssw0rd',
        'https://matrix.example.com'
      )
      await http.flushAllExpected()
      const store_value = JSON.parse(
        vstore[`accounts/${await promise}/net.kb1rd.mxbindings.credentials`]
      )
      expect(store_value).to.be.deep.equal({
        mxid: '@alice:example.com',
        token: 'abc123',
        hs: 'https://matrix.example.com'
      })
    })
    it('stores different HS URL if provided', async function () {
      http
        .when('POST', '/_matrix/client/r0/login')
        .check((req) => {
          expect(req.opts.uri).to.be.equal(
            'https://matrix.example.com/_matrix/client/r0/login'
          )
          const body = JSON.parse(req.opts.body)
          expect(body.type).to.be.equal('m.login.password')
          expect(body.user).to.be.equal('@alice:example.com')
          expect(body.password).to.be.equal('p@ssw0rd')
        })
        .respond(200, {
          user_id: '@alice:example.com',
          access_token: 'abc123',
          device_id: 'GHTYAJCE',
          well_known: {
            'm.homeserver': {
              base_url: 'https://matrix2.example.com'
            }
          }
        })
      const promise = aapi.fromPass['@alice:example.com'](
        'p@ssw0rd',
        'https://matrix.example.com'
      )
      await http.flushAllExpected()
      const store_value = JSON.parse(
        vstore[`accounts/${await promise}/net.kb1rd.mxbindings.credentials`]
      )
      expect(store_value).to.be.deep.equal({
        mxid: '@alice:example.com',
        token: 'abc123',
        hs: 'https://matrix2.example.com'
      })
    })
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
  describe('start/stop', () => {
    const setCredentials = (id, cred) => {
      vstore[
        `accounts/${id}/net.kb1rd.mxbindings.credentials`
      ] = JSON.stringify(cred)
    }
    it('throws error if user does not exist', async function () {
      await expectAsyncThrow(aapi['abc123'].start(), 'Account does not exist')
    })
    it('throws error if credentials corrupt', async function () {
      const id = await rpc.call_obj.net.kb1rd.accounts.v0.createAccount()
      setCredentials(id, { yeet: 'hi' })
      await expectAsyncThrow(
        aapi[id].start(),
        'User has no/corrupt credentials. Log the user in first'
      )
    })
    it('starts and stops client if everything is correct', async function () {
      const id = await rpc.call_obj.net.kb1rd.accounts.v0.createAccount()
      setCredentials(id, {
        mxid: '@alice:example.com',
        token: 'abc123',
        hs: 'https://matrix.example.com'
      })
      await mxClientStart(id)
      expect(await aapi[id].stop()).to.be.true
    })
    it('stop returns false if no client set up', async function () {
      expect(await aapi['dsfjdsfkjdsk'].stop()).to.be.false
    })
  })

  describe('listenUserState', () => {
    it('throws error if account does not exist', async function () {
      await expectAsyncThrow(
        aapi['dfsdf'].listenUserState(),
        `Account 'dfsdf' does not exist`
      )
    })
    it('defaults to UNAUTHENTICATED if not in storage', async function () {
      const id = await rpc.call_obj.net.kb1rd.accounts.v0.createAccount()
      expect(
        (await aapi[id].listenUserState()).state
      ).to.be.equal('UNAUTHENTICATED')
    })
    it('defaults to INACTIVE if signed in', async function () {
      const id = await aapi.fromToken['@alice:example.com'](
        'abc123',
        'https://matrix.example.com'
      )
      expect(
        (await aapi[id].listenUserState()).state
      ).to.be.equal('INACTIVE')
    })
    it('changes to STARTING during startup', async function () {
      const id = await aapi.fromToken['@alice:example.com'](
        'abc123',
        'https://matrix.example.com'
      )
      await mxClientStart(id, async function () {
        expect(
          (await aapi[id].listenUserState()).state
        ).to.be.equal('STARTING')
      })
      await aapi[id].stop()
    })
    it('defaults to ACTIVE if client started', async function () {
      const id = await aapi.fromToken['@alice:example.com'](
        'abc123',
        'https://matrix.example.com'
      )
      await mxClientStart(id)
      expect(
        (await aapi[id].listenUserState()).state
      ).to.be.equal('ACTIVE')
      await aapi[id].stop()
    })
    it('defaults to INACTIVE if client stopped', async function () {
      const id = await aapi.fromToken['@alice:example.com'](
        'abc123',
        'https://matrix.example.com'
      )
      await mxClientStart(id)
      await aapi[id].stop()
      expect(
        (await aapi[id].listenUserState()).state
      ).to.be.equal('INACTIVE')
    })
    it('generator transitions during startup', async function () {
      const id = await aapi.fromToken['@alice:example.com'](
        'abc123',
        'https://matrix.example.com'
      )
      const state = generate(id, 'listenUserState')
      expect((await state.next()).value.state).to.be.equal('INACTIVE')
      await mxClientStart(id, async function () {
        expect((await state.next()).value.state).to.be.equal('STARTING')
      })
      expect((await state.next()).value.state).to.be.equal('ACTIVE')
      await aapi[id].stop()
      expect((await state.next()).value.state).to.be.equal('INACTIVE')
      state.return()
    })
  })

  const setCredentials = (id, cred) => {
    vstore[
      `accounts/${id}/net.kb1rd.mxbindings.credentials`
    ] = JSON.stringify(cred)
  }
  describe('listenRoomList', () => {
    const mxClientStartWithState = (id) => mxClientStart(id, () => undefined, {
      next_batch: 'batch_token',
      rooms: {
        join: {
          '!726s6s6q:example.com': {
            summary: {
              'm.heroes': ['@alice:example.com', '@bob:example.com'],
              'm.joined_member_count': 2,
              'm.invited_member_count': 0
            },
            state: {
              events: [
                {
                  content: {
                    type: 'net.kb1rd.plaintext'
                  },
                  type: 'org.matrix.msc1840',
                  event_id: '$143273582443PhrSa:example.org',
                  room_id: '!726s6s6q:example.com',
                  sender: '@bob:example.org',
                  origin_server_ts: 1432735824653,
                  unsigned: { age: 1234 },
                  state_key: ''
                },
                {
                  content: {
                    alias: '#abc:example.com',
                    alt_aliases: ['#123:example.com']
                  },
                  type: 'm.room.canonical_alias',
                  event_id: '$143273582443PhrSb:example.org',
                  room_id: '!726s6s6q:example.com',
                  sender: '@bob:example.org',
                  origin_server_ts: 1432735824653,
                  unsigned: { age: 1234 },
                  state_key: ''
                },
                {
                  content: { name: 'Test!' },
                  type: 'm.room.name',
                  event_id: '$143273582443PhrSc:example.org',
                  room_id: '!726s6s6q:example.com',
                  sender: '@bob:example.org',
                  origin_server_ts: 1432735824653,
                  unsigned: { age: 1234 },
                  state_key: ''
                },
                {
                  content: {
                    info: {
                      w: 394,
                      h: 398,
                      size: 31037,
                      mimetype: 'image/jpeg'
                    },
                    url: 'mxc://example.com/JWEIFJgwEIhweiWJE'
                  },
                  type: 'm.room.avatar',
                  event_id: '$143273582443PhrSd:example.org',
                  room_id: '!726s6s6q:example.com',
                  sender: '@bob:example.org',
                  origin_server_ts: 1432735824653,
                  unsigned: { age: 1234 },
                  state_key: ''
                }
              ]
            },
            timeline: {
              events: [],
              limited: false,
              prev_batch: 't34-23535_0_0'
            },
            ephemeral: { events: [] },
            account_data: { events: [] }
          }
        },
        invite: {},
        leave: {}
      },
      presence: {}
    })
    it('returns complete information', async function () {
      const id = await rpc.call_obj.net.kb1rd.accounts.v0.createAccount()
      setCredentials(id, {
        mxid: '@alice:example.com',
        token: 'abc123',
        hs: 'https://matrix.example.com'
      })
      await mxClientStartWithState(id)
      const roomlist = await aapi[id].listenRoomList()
      expect(roomlist).to.be.deep.equal([
        {
          id: '!726s6s6q:example.com',
          name: 'Test!',
          canon_alias: '#abc:example.com',
          avatar_url: 'https://matrix.example.com/_matrix/media/r0/thumbnail/example.com/JWEIFJgwEIhweiWJE?width=256&height=256&method=scale',
          type: 'net.kb1rd.plaintext'
        }
      ])
      expect(await aapi[id].stop()).to.be.true
    })
    it('overrides avatar size', async function () {
      const id = await rpc.call_obj.net.kb1rd.accounts.v0.createAccount()
      setCredentials(id, {
        mxid: '@alice:example.com',
        token: 'abc123',
        hs: 'https://matrix.example.com'
      })
      await mxClientStartWithState(id)
      const roomlist = await aapi[id].listenRoomList(
        { avatar: { width: 64, height: 64 }}
      )
      expect(roomlist).to.be.deep.equal([
        {
          id: '!726s6s6q:example.com',
          name: 'Test!',
          canon_alias: '#abc:example.com',
          avatar_url: 'https://matrix.example.com/_matrix/media/r0/thumbnail/example.com/JWEIFJgwEIhweiWJE?width=64&height=64&method=scale',
          type: 'net.kb1rd.plaintext'
        }
      ])
      expect(await aapi[id].stop()).to.be.true
    })
    it('pushes new update on state change', async function () {
      const id = await rpc.call_obj.net.kb1rd.accounts.v0.createAccount()
      setCredentials(id, {
        mxid: '@alice:example.com',
        token: 'abc123',
        hs: 'https://matrix.example.com'
      })
      await mxClientStartWithState(id)
      const gen = generate(id, 'listenRoomList')
      await gen.next()
      const sync_response = {
        next_batch: 'batch_token2',
        rooms: {
          join: {
            '!726s6s6q:example.com': {
              summary: {
                'm.heroes': ['@alice:example.com', '@bob:example.com'],
                'm.joined_member_count': 2,
                'm.invited_member_count': 0
              },
              state: {
                events: [
                  {
                    content: {
                      type: 'net.kb1rd.test'
                    },
                    type: 'org.matrix.msc1840',
                    event_id: '$143273582443PhrSa:example.org',
                    room_id: '!726s6s6q:example.com',
                    sender: '@bob:example.org',
                    origin_server_ts: 1432735824653,
                    unsigned: { age: 1234 },
                    state_key: ''
                  }
                ]
              },
              timeline: {
                events: [],
                limited: false,
                prev_batch: 't34-23535_0_1'
              },
              ephemeral: { events: [] },
              account_data: { events: [] }
            }
          },
          invite: {},
          leave: {}
        },
        presence: {}
      }
      http.when('GET', '/_matrix/client/r0/sync').respond(200, sync_response)
      await http.flushAllExpected()
      expect((await gen.next()).value).to.be.deep.equal([
        {
          id: '!726s6s6q:example.com',
          name: 'Test!',
          canon_alias: '#abc:example.com',
          avatar_url: 'https://matrix.example.com/_matrix/media/r0/thumbnail/example.com/JWEIFJgwEIhweiWJE?width=256&height=256&method=scale',
          type: 'net.kb1rd.test'
        }
      ])
      expect(await aapi[id].stop()).to.be.true
    })
  })

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
  describe('User Account Data', () => {
    let mxbindings
    beforeEach(() => {
      ;({ mxbindings } = rpc.call_obj.net.kb1rd)
    })
    it('send', basicClientTest(async (id) => {
      http
        .when(
          'PUT',
          '/_matrix/client/r0/user/%40alice%3Aexample.com/account_data/' +
            'net.kb1rd.test'
        )
        .check(({ opts }) => {
          expect(opts.body).to.be.equal('{"hello":"world"}')
        })
        .respond(200)
      const promise = mxbindings.v0[id].account_data['net.kb1rd.test'].set({
        hello: "world"
      })
      await http.flushAllExpected()
      await promise
    }))
    it('listen', basicClientTest(async (id) => {
      const sync_response = {
        next_batch: 'batch_token',
        rooms: { join: {}, invite: {}, leave: {} },
        presence: {},
        account_data: {
          events: [{ type: 'net.kb1rd.test', content: { hello: 'world' } }]
        }
      }
      http.when('GET', '/_matrix/client/r0/sync').respond(200, sync_response)
      await http.flushAllExpected()
      expect(await mxbindings.v0[id].account_data['net.kb1rd.test'].listen())
        .to.be.deep.equal({ hello: 'world' })
    }))
  })

  /* describe('App account data', () => {
    it('loads apps from AD', basicClientTest(async () => {
      const hash = '981DD5D40C77FE1A34247F5A2D0F359855B4B2E6AD8C670C2241390E6F4A5818'.toLowerCase()
      const content = {
        permissions: ['net.kb1rd.test'],
        manifest_url: 'https://url',
        cached_manifest: {
          manifest_version: 0,
          title: { en: 'Test App!' },
          version: [0, 1, 0],
          entry_points: {},
          request_permissions: []
        }
      }
      const sync_response = {
        next_batch: 'batch_token',
        rooms: { join: {}, invite: {}, leave: {} },
        presence: {},
        account_data: {
          events: [{ type: `net.kb1rd.app.v0.${hash}`, content }]
        }
      }
      http.when('GET', '/_matrix/client/r0/sync').respond(200, sync_response)
      await http.flushAllExpected()
      // TODO
    }))
  }) */
})