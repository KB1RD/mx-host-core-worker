import * as rpc from 'rpcchannel'
import * as loglvl from 'loglevel'
import { ValidationError, ValidateFunction } from 'ajv'

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

import Manifest from './manifest'

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

  copyTo(other: App) {
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
    }
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

interface RemoteV0 {
  placeholder: string
}

interface Remote {
  v0: RemoteV0
}

class ServiceClass implements Service {
  readonly validateManifest: ValidateFunction
  readonly known_apps: { [account: string]: MapGeneratorListener<App> } = {}
  readonly associations: {
    [account: string]: MapGeneratorListener<Association>
  } = {}

  constructor(
    protected readonly parent: MainWorker,
    protected readonly log: loglvl.Logger
  ) {
    this.validateManifest = parent.ajv.compile(Manifest.Known.Schema)
  }

  getAccount(id: string): MapGeneratorListener<App> {
    if (!this.known_apps[id]) {
      this.known_apps[id] = new MapGeneratorListener()
    }
    return this.known_apps[id]
  }
  getAssocTable(id: string): MapGeneratorListener<Association> {
    if (this.associations[id]) {
      this.associations[id] = new MapGeneratorListener()
    }
    return this.associations[id]
  }

  @rpc.RpcAddress(['v0', 'app', undefined, 'fetchAndVerifyManifest'])
  @rpc.RemapArguments(['drop', 'expand'])
  fetchAndVerifyManifest(url: string): Promise<Manifest.Known> {
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
              resolve(object as Manifest.Known)
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

  @rpc.RpcAddress(['v0', undefined, 'userapp', undefined, 'listen'])
  @rpc.RemapArguments(['drop', 'expand', 'expand'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [{ type: 'string' }, { type: 'string' }]
  })
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
    if (!this.known_apps[ac_id]) {
      throw new TypeError('Account is not set up')
    }
    if (!this.known_apps[ac_id].value[url]) {
      throw new TypeError('App not registered on account')
    }
    const app = this.known_apps[ac_id].value[url]
    Object.keys(permissions).forEach((perm) => {
      if (perm) {
        if (!app.permissions.value.includes(perm)) {
          app.permissions.value.push(perm)
        }
      } else if (app.permissions.value.includes(perm)) {
        app.permissions.value.splice(app.permissions.value.indexOf(perm), 1)
      }
    })
  }
  @rpc.RpcAddress(['v0', undefined, 'userapp', undefined, 'perms', 'listen'])
  @rpc.RemapArguments(['drop', 'expand', 'expand'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [{ type: 'string' }, { type: 'string' }]
  })
  async *listenPermissions(
    ac_id: string,
    url: string
  ): AsyncGenerator<string[], void, void> {
    if (!this.known_apps[ac_id]) {
      throw new TypeError('Account is not set up')
    }
    while (true) {
      const account = this.known_apps[ac_id]
      const perms = account && account.value[url].permissions
      if (perms) {
        yield perms.value
      } else {
        yield []
      }
      await Promise.race([
        account.generate(url).next(),
        perms.generate().next()
      ])
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
    if (!this.known_apps[ac_id]) {
      throw new TypeError('Account is not set up')
    }
    const assoc = this.getAssocTable(ac_id)
    if (to) {
      assoc.value[id] = { to }
    } else {
      delete assoc.value[id]
    }
  }
  @rpc.RpcAddress(['v0', undefined, 'assoc', undefined, 'listen'])
  @rpc.RemapArguments(['drop', 'expand', 'expand'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [{ type: 'string' }, { type: 'string' }]
  })
  listenAssociation(
    ac_id: string,
    id: string
  ): AsyncGenerator<Association | undefined, void, void> {
    if (!this.known_apps[ac_id]) {
      throw new TypeError('Account is not set up')
    }
    return this.getAssocTable(ac_id).generate(id)
  }
  @rpc.RpcAddress(['v0', undefined, 'assoc', 'listen'])
  @rpc.RemapArguments(['drop', 'expand'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: [{ type: 'string' }, { type: 'string' }]
  })
  async *listenAssociations(
    ac_id: string
  ): AsyncGenerator<[string, Association][], void, void> {
    if (!this.known_apps[ac_id]) {
      throw new TypeError('Account is not set up')
    }
    const assoc = this.getAssocTable(ac_id)
    for await (const keys of assoc.generateKeys()) {
      yield keys.map((key) => [key, assoc.value[key]])
    }
  }
}

const AppsService: ServiceDescriptor = prefixServiceRpc({
  id: ['net', 'kb1rd', 'apps'],
  service: ServiceClass,
  versions: [{ version: [0, 1, 0] as SemverVersion }]
})

export default AppsService
export { ServiceClass, Remote }
