import * as rpc from 'rpcchannel'
import * as loglvl from 'loglevel'
import * as mx from 'matrix-js-sdk/lib/matrix'
import { ValidationError, ValidateFunction } from 'ajv'
import { sha256 } from 'js-sha256'

import EventTypes from './eventtypes'

import MainWorker from '../../index'

import {
  Service,
  ServiceDescriptor,
  SemverVersion,
  prefixServiceRpc
} from '../service'

import * as AccountsService from '../accounts'
import * as AppsService from '../apps'
import {
  GeneratorListener,
  MapGeneratorListener
} from '../../generatorlistener'
import { OptionalSerializable } from '../../storage'
import { Serializable } from 'child_process'
import { App, AppDetails } from '../apps'
import { onGenerate } from '../../utils'

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
 * * `UNAUTHENTICATED` - This account is not tied to a Matrix account.
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
const getRoomType = (r: mx.Room): string | undefined => {
  const type = r
    .getLiveTimeline()
    .getState('f')
    .getStateEvents(EventTypes.state_room_type, '')?.event?.content?.type
  return typeof type === 'string' ? type : undefined
}

type RoomDetailOpts = { avatar?: { width: number; height: number } }
const mapToAppDetails = (
  r: mx.Room,
  instance: MatrixInstance,
  opts: RoomDetailOpts
): RoomInfo => ({
  id: r.roomId,
  name: r.name,
  canon_alias: r.getCanonicalAlias() || undefined,
  avatar_url:
    r.getAvatarUrl(
      // Can't be undefined since room list is made blank when there's no
      // client set up
      (instance.client as mx.MatrixClient).getHomeserverUrl(),
      opts.avatar?.width || 256,
      opts.avatar?.height || 256,
      'scale',
      false
    ) || undefined,
  type: getRoomType(r) || undefined
})

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

type AccountDataType = { [k: string]: OptionalSerializable }
type AccountDataEntry = undefined | AccountDataType

interface AppGenSet {
  detailgen: AsyncGenerator<AppDetails | undefined, void, void>
  permgen: AsyncGenerator<string[], void, void>
}

class MatrixInstance {
  client: mx.MatrixClient | undefined
  /**
   * List of user's rooms
   */
  readonly room_list = new MapGeneratorListener<mx.Room>()
  /**
   * User account data
   */
  readonly user_ad = new MapGeneratorListener<AccountDataEntry>()

  protected app_list_gen?: AsyncGenerator<string[], void, void>
  protected readonly app_gens: { [key: string]: AppGenSet } = {}

  constructor(
    public readonly parent: ServiceClass,
    public readonly account_id: string
  ) {}

  get active(): boolean {
    return Boolean(this.client)
  }

  getAdGenerator(type: string): AsyncGenerator<AccountDataEntry, void, void> {
    return this.user_ad.generate(type)
  }

  _processAppConfig(id: string, obj: Serializable): void {
    try {
      this.parent.validateAppConfig(obj)
      if (this.parent.validateAppConfig.errors?.length) {
        const error = new ValidationError([
          ...this.parent.validateAppConfig.errors
        ])
        this.parent.validateAppConfig.errors.length = 0
        throw error
      }
    } catch (e) {
      this.parent.log.warn(`Error processing app config ${e}`)
      return
    }

    const config = obj as App.JSON
    const hash = sha256(config.manifest_url)
    if (id !== hash.toLowerCase()) {
      this.parent.log.warn('App ID had invalid hash for manifest URL')
      return
    }

    const app = new App(config.manifest_url, config.cached_manifest)
    app.permissions.value = [...config.permissions]
    this.parent.log.info(
      `Matrix updated app ${config.manifest_url} on account ${this.account_id}`
    )
    // this.parent.log.info('APP', JSON.stringify(app))
    this.parent.apps_svc.pushApp(this.account_id, app)
  }

  _setupRoomList(): void {
    if (!this.client) {
      throw new TypeError('Client undefined')
    }
    const updateRooms = (): void => {
      const rooms = (this.client as mx.MatrixClient).getRooms()
      const ids = new Set<string>()
      rooms.forEach((room) => {
        if (this.room_list.value[room.roomId] === room) {
          this.room_list.pushUpdate(room.roomId)
        } else {
          this.room_list.value[room.roomId] = room
        }
        ids.add(room.roomId)
      })
      Object.keys(this.room_list.value).forEach((id) => {
        if (!ids.has(id)) {
          delete this.room_list.value[id]
        }
      })
    }
    this.client.on('Room', updateRooms)
    this.client.on('Room.name', updateRooms)
    this.client.on('RoomState.events', updateRooms)
    this.client.on('deleteRoom', updateRooms)
  }
  onAppUpdate(url: string, doUndef: boolean): void {
    if (!this.client) {
      return
    }
    const app = this.parent.apps_svc.getAccount(this.account_id).value[url]
    if (!app && !doUndef) {
      return
    }
    this.client.setAccountData(
      `net.kb1rd.app.v0.${sha256(url).toLowerCase()}`,
      app ? app.toJSON() : {}
    )
    this.parent.log.info(
      `Updated account data for app ${url} on account ${this.account_id}`
    )
  }
  _setupAppAdUpdater(): void {
    this.app_list_gen = this.parent.apps_svc.listenApps(this.account_id)
    onGenerate(this.app_list_gen, (apps: string[]) => {
      Object.keys(this.app_gens).forEach((old: string) => {
        if (!apps.includes(old)) {
          this.app_gens[old].detailgen.return()
          this.app_gens[old].permgen.return()
          delete this.app_gens[old]
          this.onAppUpdate(old, true)
        }
      })
      apps.forEach((app) => {
        if (!this.app_gens[app]) {
          this.app_gens[app] = {
            detailgen: this.parent.apps_svc.listenAppDetails(
              this.account_id,
              app
            ),
            permgen: this.parent.apps_svc.listenPermissions(
              this.account_id,
              app
            )
          }
          onGenerate(this.app_gens[app].detailgen, () =>
            this.onAppUpdate(app, false)
          )
          onGenerate(this.app_gens[app].permgen, () =>
            this.onAppUpdate(app, false)
          )
        }
      })
    })
  }
  _setupAccountData(): void {
    if (!this.client) {
      throw new TypeError('Client undefined')
    }
    this.client.on('accountData', (event: mx.MatrixEvent) => {
      const type = event.getType()
      this.user_ad.value[type] = event.event.content

      // Process app AD
      /* if (type.startsWith('net.kb1rd.app.v0.')) {
        this._processAppConfig(type.substr(17), event.event.content)
      } */
    })

    // This is blocked on getting a reasonable way in the Matrix JS SDK to tell
    // if an event is a local echo
    // this._setupAppAdUpdater()
  }
  createClient(opts: mx.CreateClientOption): mx.MatrixClient {
    this.client = mx.createClient(opts)
    this._setupRoomList()
    this._setupAccountData()
    return this.client
  }
  stopClient(): void {
    if (this.client) {
      this.client.stopClient()
      delete this.client
      Object.keys(this.room_list.value).forEach(
        (id) => delete this.room_list.value[id]
      )
    }

    if (this.app_list_gen) {
      this.app_list_gen.return()
    }
    Object.keys(this.app_gens).forEach((k) => {
      this.app_gens[k].detailgen.return()
      this.app_gens[k].permgen.return()
      delete this.app_gens[k]
    })
  }
}

class ServiceClass implements Service {
  protected readonly account_svc: AccountsService.ServiceClass
  readonly apps_svc: AppsService.ServiceClass

  protected readonly state_listeners: {
    [uid: string]: GeneratorListener<AccountState>
  } = {}

  protected readonly instances: { [uid: string]: MatrixInstance } = {}

  readonly validateAppConfig: ValidateFunction

  constructor(
    protected readonly parent: MainWorker,
    readonly log: loglvl.Logger
  ) {
    this.account_svc = parent.getServiceDependency(
      ['net', 'kb1rd', 'accounts'],
      [0, 1]
    ) as AccountsService.ServiceClass
    this.apps_svc = parent.getServiceDependency(
      ['net', 'kb1rd', 'apps'],
      [0, 1]
    ) as AppsService.ServiceClass
    mx.request(parent.request)
    log.warn(
      'Note: The Matrix service changed the global request function used by ' +
        'the JS SDK. This is because the SDK does not support custom ' +
        'request functions for .well-known resolution.'
    )
    this.validateAppConfig = this.apps_svc.validateAppConfig
  }

  getInstance(uid: string): MatrixInstance {
    if (!this.instances[uid]) {
      this.instances[uid] = new MatrixInstance(this, uid)
    }
    return this.instances[uid]
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
    const key = await this.account_svc.createAccount()
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
    if (this.getInstance(account_id).active) {
      const val = this.state_listeners[account_id]?.value
      if (!val || val === 'INACTIVE' || val === 'UNAUTHENTICATED') {
        // The account state is corrupt; Try to recover gracefully
        this.log.warn(
          'Possible corrupt account state: Client is defined while state is' +
            'inactive'
        )
        this.stop(account_id)
      } else {
        // We're already signed in, do nothing
        return
      }
    }

    const account = this.account_svc.getAccount(account_id)
    if (!account) {
      throw new TypeError('Account does not exist')
    }
    await this.ensureAccountStateExists(account_id)

    let cred: AccountCredentialData
    try {
      cred = (await account.storageGetSchema(
        'net.kb1rd.mxbindings.credentials',
        accountCredentialSchema
      )) as AccountCredentialData
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
    const instance = this.getInstance(account_id)
    const client = instance.createClient({
      userId: cred.mxid,
      baseUrl: cred.hs,
      accessToken: cred.token,
      timelineSupport: true,
      useAuthorizationHeader: true,
      request: this.parent.request
    })

    // STATE LISTENER SETUP ---------------------------------------------------
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

    await client.startClient({
      initialSyncLimit: 10,
      lazyLoadMembers: true
    })
  }
  @rpc.RpcAddress(['v0', undefined, 'stop'])
  @rpc.RemapArguments(['drop', 'expand'])
  async stop(id: string): Promise<boolean> {
    await this.ensureAccountStateExists(id)
    const instance = this.instances[id]
    if (instance) {
      await instance.stopClient()
      this.state_listeners[id].value = 'INACTIVE'
      return true
    }
    return false
  }

  async ensureAccountStateExists(id: string): Promise<void> {
    if (!this.state_listeners[id]) {
      const account = this.account_svc.getAccount(id)

      let cred: AccountCredentialData | undefined = undefined
      try {
        cred = (await account.storageGetSchema(
          'net.kb1rd.mxbindings.credentials',
          accountCredentialSchema
        )) as { mxid: string; token: string; hs: string }
      } catch (e) {}

      if (!cred) {
        this.state_listeners[id] = new GeneratorListener('UNAUTHENTICATED')
      } else {
        this.state_listeners[id] = new GeneratorListener('INACTIVE')
      }
    }
  }
  async updateAccountState(id: string, state?: AccountState): Promise<void> {
    await this.ensureAccountStateExists(id)
    if (state) {
      this.state_listeners[id].value = state
    }
  }

  @rpc.RpcAddress(['v0', undefined, 'listenUserState'])
  @rpc.RemapArguments(['drop', 'expand'])
  async *listenUserState(id: string): AsyncGenerator<ClientState, void, void> {
    await this.ensureAccountStateExists(id)
    const account = this.account_svc.getAccount(id)
    if (!account) {
      throw new TypeError(`Account '${id}' does not exist`)
    }

    for await (const state of this.state_listeners[id].generate()) {
      let data: AccountCredentialData | undefined
      try {
        data = (await account.storageGetSchema(
          'net.kb1rd.mxbindings.credentials',
          accountCredentialSchema
        )) as AccountCredentialData
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
    const instance = this.getInstance(id)
    for await (const rooms of instance.room_list.generateMap()) {
      yield Object.keys(rooms)
        .map((k) => rooms[k])
        .map((room) => mapToAppDetails(room, instance, opts))
    }
  }
  @rpc.RpcAddress(['v0', undefined, 'room', undefined, 'listenDetails'])
  @rpc.RemapArguments(['drop', 'expand', 'expand'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [{ type: 'string' }, { type: 'string' }],
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
  async *listenRoomDetails(
    account: string,
    id: string,
    opts: RoomDetailOpts = {}
  ): AsyncGenerator<RoomInfo | undefined, void, void> {
    const instance = this.getInstance(account)
    for await (const room of instance.room_list.generate(id)) {
      yield room && mapToAppDetails(room, instance, opts)
    }
  }

  @rpc.RpcAddress(['v0', undefined, 'account_data', undefined, 'set'])
  @rpc.RemapArguments(['drop', 'expand', 'expand'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [{ type: 'string' }, { type: 'string' }],
    minItems: 3
  })
  async sendAccountData(
    id: string,
    type: string,
    data: AccountDataType
  ): Promise<void> {
    const { client } = this.getInstance(id)
    if (!client) {
      throw new TypeError('Client not set up')
    }
    await client.setAccountData(type, data)
  }
  @rpc.RpcAddress(['v0', undefined, 'account_data', 'listen'])
  @rpc.RemapArguments(['drop', 'expand'])
  listenAccountDataKeys(id: string): AsyncGenerator<string[], void, void> {
    return this.getInstance(id).user_ad.generateKeys()
  }
  @rpc.RpcAddress(['v0', undefined, 'account_data', undefined, 'listen'])
  @rpc.RemapArguments(['drop', 'expand', 'expand'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [{ type: 'string' }, { type: 'string' }]
  })
  listenAccountData(
    id: string,
    type: string
  ): AsyncGenerator<AccountDataEntry, void, void> {
    return this.getInstance(id).getAdGenerator(type)
  }
}

const MatrixService: ServiceDescriptor = prefixServiceRpc({
  id: ['net', 'kb1rd', 'mxbindings'],
  service: ServiceClass,
  versions: [{ version: [0, 3, 0] as SemverVersion }]
})

export default MatrixService
export { ServiceClass, Remote }
