import * as rpc from 'rpcchannel'
import * as loglvl from 'loglevel'
import { ValidationError, ValidateFunction } from 'ajv'

import * as utils from '../../utils'

import {
  GeneratorListener,
  MapGeneratorListener
} from '../../generatorlistener'

import MainWorker from '../../index'

import {
  Service,
  ServiceDescriptor,
  SemverVersion,
  prefixServiceRpc
} from '../service'

import * as Permissions from './permissions'
import Manifest from './manifest'

/**
 * @todo Move constants to a central location
 */
const APP_TOKEN_TIMEOUT = 30000

class App {
  public readonly permissions = new GeneratorListener<string[]>([])
  constructor(
    public readonly manifest_url: string,
    public readonly cached_manifest: Manifest.Known
  ) {}

  /**
   * Gets the appropriate translation from a list.
   * @param obj Localized translation set
   */
  getLocalized(obj: Manifest.LocalizedObject): string {
    const default_locale = this.cached_manifest.default_locale
    const locales = []
    if (default_locale) {
      locales.push(default_locale)
    }
    locales.push('en-US')
    return (
      Manifest.LocalizedObject.getLocalized(obj, ...locales) ||
      'APP MANIFEST MISSING TRANSLATION'
    )
  }

  getTitle(): string {
    return this.getLocalized(this.cached_manifest.title)
  }
  getDescription(): string | undefined {
    const desc = this.cached_manifest.description
    return desc && this.getLocalized(desc)
  }
  getVersion(): SemverVersion {
    return this.cached_manifest.version
  }

  copyTo(other: App): void {
    other.permissions.value = this.permissions.value.slice()
  }

  toJSON(): App.JSON {
    const { manifest_url, cached_manifest } = this
    const permissions = this.permissions.value
    return { permissions, manifest_url, cached_manifest }
  }
}
namespace App {
  export type JSON = {
    permissions: string[]
    manifest_url: string
    cached_manifest: Manifest.Known
  }
  export const Schema = {
    type: 'object',
    properties: {
      permissions: { type: 'array', items: { type: 'string' } },
      manifest_url: { type: 'string' },
      cached_manifest: Manifest.Known.Schema
    },
    required: ['permissions', 'manifest_url', 'cached_manifest']
  }
}

interface Association {
  /**
   * App manifest URL associated with this type
   */
  to: string
}

interface AppDetails {
  version: SemverVersion
  title: string
  description?: string
}

interface ManifestResponse {
  manifest: Manifest.Known
  known_permissions: { [key: string]: { inherits: string[] } }
  unknown_permissions: string[]
}

interface TokenContext {
  port: MessagePort
  context: Permissions.Context
  clear: () => void
}

interface RemoteV0 {
  placeholder: string
}

interface Remote {
  v0: RemoteV0
}

class ServiceClass implements Service {
  readonly validateManifest: ValidateFunction
  readonly validateAppConfig: ValidateFunction
  readonly known_apps: { [account: string]: MapGeneratorListener<App> } = {}
  readonly associations: {
    [account: string]: MapGeneratorListener<Association>
  } = {}

  readonly app_tokens = new Map<string, TokenContext>()

  constructor(
    protected readonly parent: MainWorker,
    protected readonly log: loglvl.Logger
  ) {
    this.validateManifest = parent.ajv.compile(Manifest.Known.Schema)
    this.validateAppConfig = parent.ajv.compile(App.Schema)
  }

  getAccount(id: string): MapGeneratorListener<App> {
    if (!this.known_apps[id]) {
      this.known_apps[id] = new MapGeneratorListener()
    }
    return this.known_apps[id]
  }
  getAssocTable(id: string): MapGeneratorListener<Association> {
    if (!this.associations[id]) {
      this.associations[id] = new MapGeneratorListener()
    }
    return this.associations[id]
  }

  pushApp(id: string, app: App): void {
    this.getAccount(id).value[app.manifest_url] = app
  }

  @rpc.RpcAddress(['v0', 'app', undefined, 'fetchAndVerifyManifest'])
  @rpc.RemapArguments(['drop', 'expand'])
  fetchAndVerifyManifest(url: string): Promise<ManifestResponse> {
    return new Promise((resolve, reject) => {
      this.parent.request(
        { method: 'GET', uri: url, timeout: 5000 },
        (error, resp, body) => {
          if (error) {
            reject(error)
          } else {
            try {
              const object = JSON.parse(body)
              this.validateManifest(object)
              if (this.validateManifest.errors?.length) {
                const error = new ValidationError([
                  ...this.validateManifest.errors
                ])
                this.validateManifest.errors.length = 0
                throw error
              }

              const resp: ManifestResponse = {
                manifest: object as Manifest.Known,
                known_permissions: {},
                unknown_permissions: []
              }

              // Ensure that all permissions are identified
              const resolvePermission = (name: string) => {
                const data = Permissions.default[name]
                if (!data) {
                  resp.unknown_permissions.push(name)
                } else if (!resp.known_permissions[name]) {
                  resp.known_permissions[name] = { inherits: data.inherits }
                  data.inherits.forEach(resolvePermission)
                }
              }
              resp.manifest.request_permissions.forEach(resolvePermission)

              resolve(resp)
            } catch (e) {
              reject(e)
            }
          }
        }
      )
    })
  }

  @rpc.RpcAddress(['v0', undefined, 'userapp', undefined, 'setup'])
  @rpc.RemapArguments(['drop', 'expand', 'expand', 'pass'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [{ type: 'string' }, { type: 'string' }, Manifest.Known.Schema]
  })
  async setupApp(
    ac_id: string,
    url: string,
    manifest: Manifest.Known
  ): Promise<void> {
    const account = this.getAccount(ac_id)
    const app = new App(url, manifest)

    if (account.value[url]) {
      // Copy over old permissions and settings
      account.value[url].copyTo(app)
    }

    account.value[url] = app
  }

  @rpc.RpcAddress(['v0', undefined, 'userapp', 'listen'])
  @rpc.RemapArguments(['drop', 'expand'])
  listenApps(ac_id: string): AsyncGenerator<string[], void, void> {
    return this.getAccount(ac_id).generateKeys()
  }

  @rpc.RpcAddress(['v0', undefined, 'userapp', undefined, 'manifest', 'listen'])
  @rpc.RemapArguments(['drop', 'expand', 'expand'])
  async *listenAppManifest(
    ac_id: string,
    url: string
  ): AsyncGenerator<Manifest.Known | undefined, void, void> {
    const account = this.getAccount(ac_id)
    for await (const app of account.generate(url)) {
      if (!app) {
        yield undefined
      } else {
        yield app.cached_manifest
      }
    }
  }

  @rpc.RpcAddress(['v0', undefined, 'userapp', undefined, 'listen'])
  @rpc.RemapArguments(['drop', 'expand', 'expand'])
  async *listenAppDetails(
    ac_id: string,
    url: string
  ): AsyncGenerator<AppDetails | undefined, void, void> {
    const account = this.getAccount(ac_id)
    for await (const app of account.generate(url)) {
      if (!app) {
        yield undefined
      } else {
        yield {
          version: app.getVersion(),
          title: app.getTitle(),
          description: app.getDescription()
        }
      }
    }
  }

  @rpc.RpcAddress(['v0', undefined, 'userapp', undefined, 'perms', 'set'])
  @rpc.RemapArguments(['drop', 'expand', 'expand', 'pass'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [
      { type: 'string' },
      { type: 'string' },
      { type: 'object', additionalProperties: { type: 'boolean' } }
    ]
  })
  setPermissions(
    ac_id: string,
    url: string,
    permissions: { [key: string]: boolean }
  ): void {
    if (!this.getAccount(ac_id).value[url]) {
      throw new TypeError('App not registered on account')
    }
    const app = this.known_apps[ac_id].value[url]
    Object.keys(permissions).forEach((perm) => {
      if (permissions[perm]) {
        if (!app.permissions.value.includes(perm)) {
          app.permissions.value.push(perm)
        }
        app.permissions.pushUpdate()
      } else if (app.permissions.value.includes(perm)) {
        app.permissions.value.splice(app.permissions.value.indexOf(perm), 1)
        app.permissions.pushUpdate()
      }
    })
  }
  @rpc.RpcAddress(['v0', undefined, 'userapp', undefined, 'perms', 'listen'])
  @rpc.RemapArguments(['drop', 'expand', 'expand'])
  async *listenPermissions(
    ac_id: string,
    url: string
  ): AsyncGenerator<string[], void, void> {
    const account = this.getAccount(ac_id)
    while (true) {
      const perms = account.value[url]?.permissions

      // Get the new promises before yielding so that it's impossible for
      // additional events to sneak in the queue before we've gotten the next
      // promise
      const accountgen = account.generate(url)
      const permgen = perms && perms.generate()
      // Flush out the initial value so we're not constantly looping
      accountgen.next()
      perms && permgen.next()

      if (perms) {
        yield perms.value
      } else {
        yield []
      }
      await Promise.race([accountgen.next(), permgen.next()])
    }
  }

  @rpc.RpcAddress(['v0', undefined, 'assoc', undefined, 'set'])
  @rpc.RemapArguments(['drop', 'expand', 'expand'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    additionalItems: { type: 'string' },
    minItems: 2,
    maxItems: 3
  })
  setAssociation(ac_id: string, id: string, to: string | undefined): void {
    const assoc = this.getAssocTable(ac_id)
    if (to) {
      assoc.value[id] = { to }
    } else {
      delete assoc.value[id]
    }
  }
  @rpc.RpcAddress(['v0', undefined, 'assoc', undefined, 'listen'])
  @rpc.RemapArguments(['drop', 'expand', 'expand'])
  listenAssociation(
    ac_id: string,
    id: string
  ): AsyncGenerator<Association | undefined, void, void> {
    return this.getAssocTable(ac_id).generate(id)
  }
  @rpc.RpcAddress(['v0', undefined, 'assoc', 'listen'])
  @rpc.RemapArguments(['drop', 'expand'])
  listenAssociations(
    ac_id: string
  ): AsyncGenerator<{ [key: string]: Association }, void, void> {
    return this.getAssocTable(ac_id).generateMap()
  }

  @rpc.RpcAddress([
    'v0',
    undefined,
    'userapp',
    undefined,
    'entry',
    undefined,
    'setupGet'
  ])
  @rpc.RemapArguments(['drop', 'expand', 'expand', 'expand', 'pass'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [
      { type: 'string' },
      { type: 'string' },
      { type: 'string' },
      Permissions.Context.Base.Schema
    ]
  })
  setupAndGetEntryChannel(
    account_id: string,
    app_url: string,
    entry: string,
    provided_ctx: Permissions.Context.Base
  ): { port: MessagePort; context: Permissions.Context } {
    const app = this.getAccount(account_id).value[app_url]
    if (!app) {
      throw new TypeError('App has not been registered')
    }
    this.log.info(
      `Entering app ${app_url} under account ${account_id} via point ${entry}`
    )

    const context = { account_id, app_url, ...provided_ctx }
    const channel: MessageChannel = new MessageChannel()

    // Apps are untrusted; Deny by default to RPC resources
    const ch = this.parent.getRpcChannel(channel.port1, rpc.AccessPolicy.DENY)

    // Keep track of permissions that have already been applied
    const granted: Set<Permissions.Permission> = new Set()
    const addPermission = (perm: string) => {
      const perm_obj = Permissions.default[perm]
      if (!perm_obj) {
        this.log.warn(
          `Permission ${perm} not known, but added to app ${app_url}`
        )
      } else if (!granted.has(perm_obj)) {
        granted.add(perm_obj)
        // TODO: Define behavior when two permissions directly conflict
        perm_obj.inherits.forEach(addPermission)
        try {
          perm_obj.grantOn(ch.access, context)
        } catch (e) {
          this.log.warn(`Failed to grant permission ${perm}`, e)
        }
      }
    }
    app.permissions.value.forEach(addPermission)
    // Apps need to be able to request services to work
    addPermission('a.services.request')

    return { port: channel.port2, context }
  }

  @rpc.RpcAddress([
    'v0',
    undefined,
    'userapp',
    undefined,
    'entry',
    undefined,
    'setup'
  ])
  @rpc.RemapArguments(['drop', 'expand', 'expand', 'expand', 'pass'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [
      { type: 'string' },
      { type: 'string' },
      { type: 'string' },
      Permissions.Context.Base.Schema
    ]
  })
  setupEntryChannel(
    account_id: string,
    app_url: string,
    entry: string,
    provided_ctx: Permissions.Context.Base
  ): { token: string; timeout: number } {
    const { port, context } = this.setupAndGetEntryChannel(
      account_id,
      app_url,
      entry,
      provided_ctx
    )

    const token = utils.generateUniqueKey(32, (k) => this.app_tokens.has(k))

    // This ensures that app tokens are cleaned up once used or are garbage
    // collected if not used
    const timeout = APP_TOKEN_TIMEOUT
    // eslint-disable-next-line prefer-const
    let timer: NodeJS.Timeout
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this
    const clear = (): void => {
      self.app_tokens.delete(token)
      clearTimeout(timer)
    }
    timer = setTimeout(clear, timeout)

    this.app_tokens.set(token, { port, context, clear })
    return { token, timeout }
  }

  @rpc.RpcAddress(['v0', 'redeemToken', undefined])
  @rpc.RemapArguments(['drop', 'expand'])
  redeemEntryToken(
    token: string
  ): { port: MessagePort; context: Permissions.Context } {
    const tokenctx = this.app_tokens.get(token)
    if (!tokenctx) {
      throw new TypeError('Token does not exist or has expired')
    }
    tokenctx.clear()
    return { port: tokenctx.port, context: tokenctx.context }
  }
}

const AppsService: ServiceDescriptor = prefixServiceRpc({
  id: ['net', 'kb1rd', 'apps'],
  service: ServiceClass,
  versions: [{ version: [0, 2, 0] as SemverVersion }]
})

export default AppsService
export { ServiceClass, Remote, App, AppDetails }
