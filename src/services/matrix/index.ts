import * as rpc from 'rpcchannel'
import * as loglvl from 'loglevel'
import * as mx from 'matrix-js-sdk/lib/matrix'
import { ValidationError } from 'ajv'

import EventTypes from './eventtypes'

import MainWorker from '../../index'

import {
  Service,
  ServiceDescriptor,
  SemverVersion,
  prefixServiceRpc
} from '../service'

import * as AccountsService from '../accounts'
import { GeneratorListener } from '../../generatorlistener'

const accountCredentialSchema = {
  type: 'object',
  properties: {
    mxid: { type: 'string' },
    token: { type: 'string' },
    hs: { type: 'string' },
    display_name: { type: 'string' },
    avatar_base64: { type: 'string' }
  },
  required: ['mxid', 'token', 'hs']
}

type AccountCredentialData = {
  mxid: string
  token: string
  hs: string
  display_name?: string
  avatar_base64?: string
}

/**
 * State of an account. This is distinct from the Matrix JS SDK's state, though
 * it is determined by SDK state. The possibilities are as follows:
 * * `UNAUTHENTICATED` - Credentials are missing and a login flow should be
 * started.
 * * `INACTIVE` - Has not yet been started, but credentials are present.
 * * `STARTING` - Is initial syncing or reconnecting after offline. The user's
 * input should be blocked, but a loading indicator should be shown.
 * * `ACTIVE` - The client is started and is running. The user can completely
 * interact with the application.
 * * `OFFLINE` - The homeserver connection has been broken. The user should not
 * be able to interact with the application.
 *
 * **Important:** Note that only for the first two states is presence of login
 * credentials specified. Unless in `INACTIVE`, do not assume that login
 * credentials (MXID, token, HS URL) are stored.
 */
type AccountState =
  | 'UNAUTHENTICATED'
  | 'INACTIVE'
  | 'STARTING'
  | 'ACTIVE'
  | 'OFFLINE'

type MxState =
  | 'PREPARED'
  | 'ERROR'
  | 'SYNCING'
  | 'RECONNECTING'
  | 'CATCHUP'
  | 'STOPPED'

type ClientState =
  | {
      id: string
      mxid: string
      display_name: string
      avatar?: ArrayBuffer
      state: AccountState
    }
  | { state: 'UNAUTHENTICATED' }

type RoomInfo = {
  id: string
  name: string
  canon_alias?: string
  avatar_url?: string
  type?: string
}

interface RemoteV0 {
  getHsUrl: { [mxid: string]: () => Promise<string> }
  fromToken: {
    [mxid: string]: () => (token: string, hs?: string) => Promise<string>
  }
  fromPass: {
    [mxid: string]: () => (pw: string, hs?: string) => Promise<string>
  }

  [account: string]:
    | {
        start(): Promise<void>
        stop(): Promise<boolean>

        listenUserState(): AsyncGenerator<ClientState, void, void>
        listenRoomList(opts: {
          avatar?: { width: number; height: number }
        }): AsyncGenerator<RoomInfo[], void, void>
      }
    | RemoteV0['getHsUrl']
    | RemoteV0['fromToken']
    | RemoteV0['fromPass']
}

interface Remote {
  v0: RemoteV0
}

class ServiceClass implements Service {
  protected readonly account_svc: AccountsService.ServiceClass
  protected readonly clients: { [uid: string]: mx.MatrixClient } = {}

  protected readonly state_listeners: {
    [uid: string]: GeneratorListener<AccountState>
  } = {}

  protected readonly room_list_listeners: {
    [uid: string]: GeneratorListener<mx.Room[]>
  } = {}

  constructor(
    protected readonly parent: MainWorker,
    protected readonly log: loglvl.Logger
  ) {
    this.account_svc = parent.getServiceDependency(
      ['net', 'kb1rd', 'accounts'],
      [0, 1]
    ) as AccountsService.ServiceClass
    mx.request(parent.request)
    log.warn(
      'Note: The Matrix service changed the global request function used by ' +
        'the JS SDK. This is because the SDK does not support custom ' +
        'request functions for .well-known resolution.'
    )
  }

  @rpc.RpcAddress(['v0', 'getHsUrl', undefined])
  @rpc.RemapArguments(['drop', 'expand'])
  async getHsUrl(mxid: string): Promise<string> {
    const parts = mxid.split(':')
    // Shift away the user's localpart -- Not relevant
    parts.shift()
    // If we can't make anything of this MXID, throw an error
    if (!mxid.startsWith('@') || parts.length !== 1) {
      throw new TypeError('Invald mxid')
    }

    const config = await mx.AutoDiscovery.findClientConfig(parts.join(':'))
    let url = config['m.homeserver']?.base_url
    if (!url) {
      url = `https://${parts.join(':')}`
    }

    switch (config['m.homeserver']?.state) {
      case mx.AutoDiscovery.PROMPT:
        this.log.info(
          `Well-known lookup for MXID ${mxid} did not return HS URL. ` +
            `The returned domain will be the default (${url})`
        )
        // TODO: make a way to warn user
        break
      case mx.AutoDiscovery.FAIL_PROMPT:
        this.log.warn(
          `Well-known lookup for MXID ${mxid} failed. The returned domain ` +
            `will be the default (${url})`
        )
        // TODO: make a way to warn user
        break
      case mx.AutoDiscovery.FAIL_ERROR:
        this.log.error(
          `Well-known lookup for MXID ${mxid} critically failed. Error thrown`
        )
        if (config['m.homeserver'].error) {
          throw new Error('Matrix error: ' + config['m.homeserver'].error)
        }
        throw new Error('Unknown fatal error in .well-known discovery')
    }
    return url
  }

  @rpc.RpcAddress(['v0', 'fromToken', undefined])
  @rpc.RemapArguments(['drop', 'expand', 'pass' /*, optional*/])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [{ type: 'string' }, { type: 'string' }],
    additionalItems: { type: 'string' }
  })
  async fromToken(mxid: string, token: string, hs?: string): Promise<string> {
    if (!hs) {
      hs = await this.getHsUrl(mxid)
    }
    const key = this.account_svc.createAccount()
    const account = this.account_svc.getAccount(key)
    account.storageSet('net.kb1rd.mxbindings.credentials', { mxid, token, hs })
    return key
  }

  @rpc.RpcAddress(['v0', 'fromPass', undefined])
  @rpc.RemapArguments(['drop', 'expand', 'pass' /*, optional*/])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [{ type: 'string' }, { type: 'string' }],
    additionalItems: { type: 'string' }
  })
  async fromPass(user: string, pw: string, hs?: string): Promise<string> {
    if (!hs) {
      hs = await this.getHsUrl(user)
    }
    const { access_token, well_known } = await mx
      .createClient(hs)
      .login('m.login.password', { user, password: pw })
    if (!access_token) {
      throw new Error('Response did not return access token')
    }
    if (
      well_known &&
      well_known['m.homeserver'] &&
      well_known['m.homeserver'].base_url
    ) {
      hs = well_known['m.homeserver'].base_url
    }
    return await this.fromToken(user, access_token, hs)
  }

  @rpc.RpcAddress(['v0', undefined, 'start'])
  @rpc.RemapArguments(['drop', 'expand'])
  async start(account_id: string): Promise<void> {
    const account = this.account_svc.getAccount(account_id)
    if (!account) {
      throw new TypeError('Account does not exist')
    }
    this.ensureAccountStateExists(account_id)

    let cred: AccountCredentialData
    try {
      cred = account.storageGetSchema(
        'net.kb1rd.mxbindings.credentials',
        accountCredentialSchema
      ) as AccountCredentialData
    } catch (e) {
      if (e instanceof ValidationError) {
        throw new TypeError(
          'User has no/corrupt credentials. Log the user in first'
        )
      } else {
        throw e
      }
    }

    this.state_listeners[account_id].value = 'STARTING'
    const client = (this.clients[account_id] = mx.createClient({
      userId: cred.mxid,
      baseUrl: cred.hs,
      accessToken: cred.token,
      timelineSupport: true,
      useAuthorizationHeader: true,
      request: this.parent.request
    }))
    client.on('sync', (state: MxState) => {
      switch (state) {
        case 'PREPARED':
        case 'SYNCING':
          this.state_listeners[account_id].value = 'ACTIVE'
          return
        case 'ERROR':
        case 'RECONNECTING':
          this.state_listeners[account_id].value = 'OFFLINE'
          return
        case 'CATCHUP':
          this.state_listeners[account_id].value = 'STARTING'
          return
        case 'STOPPED':
          this.state_listeners[account_id].value = 'INACTIVE'
          return
      }
    })

    if (!this.room_list_listeners[account_id]) {
      this.room_list_listeners[account_id] = new GeneratorListener([])
    }
    const updateRooms = (): void => {
      this.room_list_listeners[account_id].value = client.getRooms()
    }
    client.on('Room', updateRooms)
    client.on('Room.name', updateRooms)
    client.on('RoomState.events', updateRooms)
    client.on('deleteRoom', updateRooms)

    await client.startClient({
      initialSyncLimit: 10,
      lazyLoadMembers: true
    })
  }
  @rpc.RpcAddress(['v0', undefined, 'stop'])
  @rpc.RemapArguments(['drop', 'expand'])
  async stop(id: string): Promise<boolean> {
    const client = this.clients[id]
    if (client) {
      await client.stopClient()
      this.state_listeners[id].value = 'INACTIVE'
      return true
    }
    return false
  }

  ensureAccountStateExists(id: string): void {
    if (!this.state_listeners[id]) {
      const account = this.account_svc.getAccount(id)
      let cred: AccountCredentialData
      try {
        cred = account.storageGetSchema(
          'net.kb1rd.mxbindings.credentials',
          accountCredentialSchema
        ) as { mxid: string; token: string; hs: string }
      } catch (e) {
        this.state_listeners[id] = new GeneratorListener('UNAUTHENTICATED')
        return
      }
      if (!cred) {
        this.state_listeners[id] = new GeneratorListener('UNAUTHENTICATED')
      } else {
        this.state_listeners[id] = new GeneratorListener('INACTIVE')
      }
    }
  }
  updateAccountState(id: string, state?: AccountState): void {
    this.ensureAccountStateExists(id)
    if (state) {
      this.state_listeners[id].value = state
    }
    this.state_listeners[id].pushUpdate()
  }

  @rpc.RpcAddress(['v0', undefined, 'listenUserState'])
  @rpc.RemapArguments(['drop', 'expand'])
  async *listenUserState(id: string): AsyncGenerator<ClientState, void, void> {
    this.ensureAccountStateExists(id)
    const account = this.account_svc.getAccount(id)
    if (!account) {
      throw new TypeError('Account does not exist')
    }

    for await (const state of this.state_listeners[id].generate()) {
      let data: AccountCredentialData | undefined
      try {
        data = account.storageGetSchema(
          'net.kb1rd.mxbindings.credentials',
          accountCredentialSchema
        ) as AccountCredentialData
      } catch (e) {
        if (e instanceof ValidationError) {
          data = undefined
        } else {
          throw e
        }
      }
      if (!data) {
        yield { state: 'UNAUTHENTICATED' }
      } else {
        yield {
          id,
          mxid: data.mxid,
          // TODO: Implement display name cache
          display_name: data.display_name || data.mxid,
          // TODO: Implement avatar cache
          avatar: undefined,
          state
        }
      }
    }
  }

  @rpc.RpcAddress(['v0', undefined, 'listenRoomList'])
  @rpc.RemapArguments(['drop', 'expand'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [{ type: 'string' }],
    maxItems: 2,
    additionalItems: {
      type: 'object',
      properties: {
        avatar: {
          type: 'object',
          properties: {
            width: { type: 'number', minimum: 1, maximum: 4096 },
            height: { type: 'number', minimum: 1, maximum: 4096 }
          },
          required: ['width', 'height']
        }
      }
    }
  })
  async *listenRoomList(
    id: string,
    opts: { avatar?: { width: number; height: number } } = {}
  ): AsyncGenerator<RoomInfo[], void, void> {
    if (!this.room_list_listeners[id]) {
      this.room_list_listeners[id] = new GeneratorListener([])
    }
    for await (const rooms of this.room_list_listeners[id].generate()) {
      const client = this.clients[id]
      const getType = (r: mx.Room): string | undefined => {
        const type = r
          .getLiveTimeline()
          .getState('f')
          .getStateEvents(EventTypes.state_room_type, '')?.event?.content?.type
        return typeof type === 'string' ? type : undefined
      }
      yield rooms.map((r) => ({
        id: r.roomId,
        name: r.name,
        canon_alias: r.getCanonicalAlias() || undefined,
        avatar_url:
          r.getAvatarUrl(
            client.getHomeserverUrl(),
            opts.avatar?.width || 256,
            opts.avatar?.height || 256,
            'scale',
            false
          ) || undefined,
        type: getType(r) || undefined
      }))
    }
  }
}

const MatrixService: ServiceDescriptor = prefixServiceRpc({
  id: ['net', 'kb1rd', 'mxbindings'],
  service: ServiceClass,
  versions: [{ version: [0, 1, 0] as SemverVersion }]
})

export default MatrixService
export { ServiceClass, Remote }
