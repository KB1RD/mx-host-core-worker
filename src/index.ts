/**
 * @author Nathan Pennie <kb1rd@kb1rd.net>
 */
/** */

import * as rpc from 'rpcchannel'
import Ajv from 'ajv'
import * as loglvl from 'loglevel'
import * as request from 'request'

import {
  ServiceConstructor,
  ServiceDescriptor,
  ServiceVersionDescriptor,
  SemverVersion,
  ServiceRequest,
  ServiceResponse,
  MinimumSemver,
  Service
} from './services/service'
import AccountsService from './services/accounts'
import * as AccountsServiceExports from './services/accounts'
import MatrixService from './services/matrix'
import * as MatrixServiceExports from './services/matrix'
import AppsService from './services/apps'
import * as AppsServiceExports from './services/apps'

import { KvStorageBackend, KvBackendCache } from './storage'

type RequestFunc = request.RequestAPI<
  request.Request,
  request.CoreOptions,
  request.RequiredUriUrl
>

const addrToString = (addr: rpc.MultistringAddress) =>
  addr
    .map((s) => {
      if (s.includes('.') || s.includes('[') || s.includes(']')) {
        return `[${s}]`
      }
      return s
    })
    .join('.')

function addrsEqual(
  a: rpc.MultistringAddress,
  b: rpc.MultistringAddress
): boolean {
  return a.length === b.length && a.every((p, i) => b[i] === p)
}

interface BaseWorker {
  /**
   * Called when there's a new local connection. This is mainly used for shared
   * workers.
   * @param port Port to connect to
   */
  onconnect(port: MessagePort): void
  onmessage(e: MessageEvent): void
  onmessageerror(e: MessageEvent): void
  onoffline(): void
  ononline(): void
}

interface ServicesRemote {
  requestServices(...requests: ServiceRequest[]): Promise<ServiceResponse[]>
}

class MainWorker implements BaseWorker {
  /**
   * Schema validation instance
   */
  ajv = new Ajv()

  /**
   * Logger used by the worker
   */
  protected readonly log: loglvl.Logger

  /**
   * Registry of handlers
   */
  protected readonly registry = new rpc.RpcHandlerRegistry()
  /**
   * Set of active RPC channels
   * @todo Deallocate channels. **This is a memory leak**
   */
  protected readonly channels = new Set<rpc.RpcChannel>()

  readonly services = new Set<ServiceDescriptor>()
  readonly services_active = new Set<ServiceVersionDescriptor>()
  readonly service_instaces = new Map<ServiceConstructor, Service>()

  protected readonly createLog: (name: string) => loglvl.Logger

  readonly storage_backend: KvStorageBackend
  readonly request: RequestFunc

  readonly validateMsg: Ajv.ValidateFunction

  constructor({
    createLog = (name: string) => loglvl.getLogger(name),
    storage_backend,
    request
  }: {
    createLog: (name: string) => loglvl.Logger
    storage_backend: KvStorageBackend
    request: RequestFunc
  }) {
    this.request = request
    this.createLog = createLog
    this.storage_backend = new KvBackendCache(storage_backend)
    this.log = createLog('CORE')
    this.log.info('Starting worker core...')

    this.log.debug('Compiling schemas...')
    try {
      this.validateMsg = this.ajv.compile(rpc.RpcMessage.Schema)
    } catch (e) {
      this.log.error('Failed to compile schema:', e)
      throw e
    }
    this.log.debug('Done compiling schemas')

    this.log.debug('Registering services...')
    // See https://stackoverflow.com/a/37006179/7853604
    // No way to fix, must force TS to eat it
    // eslint-disable-next-line
    this.registry.registerAll(this as {})
    this.registerService(AccountsService)
    this.registerService(MatrixService)
    this.registerService(AppsService)
    this.log.debug('Done registering services')

    this.log.info('Done starting worker core')
  }

  getRpcChannel(port: MessagePort, policy?: rpc.AccessPolicy): rpc.RpcChannel {
    const chan = new rpc.RpcChannel(
      (msg, xfer) => {
        port.postMessage(msg, xfer)
        this.log.debug(`Sent message to handler ${addrToString(msg.to)}`)
      },
      // Contexts that can directly connect are trusted
      policy,
      this.registry
    )
    port.onmessage = (event: MessageEvent): void => {
      this.validateMsg(event.data)
      if (this.validateMsg.errors?.length) {
        const error = new Ajv.ValidationError([...this.validateMsg.errors])
        this.validateMsg.errors.length = 0
        this.log.warn('Received invalid message. Schema error:', error)
        return
      }
      const msg = event.data as rpc.RpcMessage
      this.log.debug(`Received message to handler ${addrToString(msg.to)}`)
      chan.receive(msg)
    }
    this.channels.add(chan)
    return chan
  }
  onconnect(port: MessagePort): void {
    // Contexts that can directly connect are trusted
    this.getRpcChannel(port, rpc.AccessPolicy.ALLOW)
  }
  onmessage(e: MessageEvent): void {
    if (e.data instanceof MessagePort) {
      this.onconnect(e.data)
      if (e.origin) {
        this.log.info(`Connected to MessagePort provided by '${e.origin}'`)
      } else {
        this.log.info(`Connected to MessagePort provided by unknown origin`)
      }
    } else {
      if (e.origin) {
        this.log.info(`Invalid port addition message from '${e.origin}'`)
      } else {
        this.log.info(`Invalid port addition message from unknown origin`)
      }
    }
  }
  onmessageerror(e: MessageEvent): void {
    this.log.warn(`Message error from ${e.origin}`)
  }
  onoffline(): void {
    this.log.info(`Browser reports network offline`)
  }
  ononline(): void {
    this.log.info(`Browser reports network online`)
  }

  /**
   * Registers an available service by its ServiceDescriptor. This does not
   * call the service's constructor.
   * @param service Service to register
   */
  registerService(service: ServiceDescriptor): void {
    this.services.forEach(({ id }) => {
      if (addrsEqual(id, service.id)) {
        throw new TypeError(
          `Service ${addrToString(service.id)} already registered`
        )
      }
    })
    const used_major = new Set<number>()
    service.versions.forEach(({ version }) => {
      if (used_major.has(version[0])) {
        throw new TypeError(
          `Service ${addrToString(service.id)} has duplicate major versions`
        )
      }
    })
    this.services.add(service)
    this.log.debug(`Registered service with ID ${addrToString(service.id)}`)
  }

  /**
   * By default, service constructors are **not** called. This sets them up as
   * needed.
   * @param service Service to set up. If not already added, it is added
   * @param req Version to request. If not found, an error is thrown
   * @returns The `SemverVersion` that was set up, or `undefined` if there was
   * no applicable version.
   * @throws A TypeError if no applicable semantic version is found. Applicable
   * versions must have the same major ID and a greater minor ID.
   */
  setupServiceVersion(
    service: ServiceDescriptor,
    req: SemverVersion | MinimumSemver
  ): SemverVersion | undefined {
    if (!this.services.has(service)) {
      this.registerService(service)
    }
    let version: ServiceVersionDescriptor | undefined = undefined
    for (const v of service.versions) {
      if (v.version[0] === req[0] && v.version[1] >= req[1]) {
        version = v
      }
    }
    if (!version) {
      return undefined
    }
    if (this.services_active.has(version)) {
      // Already set up
      return version.version
    }
    if (!this.service_instaces.has(service.service)) {
      // eslint-disable-next-line
      const self = this
      const instance = new service.service(
        this,
        this.createLog(addrToString(service.id)),
        {
          createChildLogger(name: string): loglvl.Logger {
            return self.createLog(addrToString(service.id) + '.' + name)
          }
        }
      )
      this.service_instaces.set(service.service, instance)
      // eslint-disable-next-line
      this.registry.registerAll(instance as {})
      // ${SemverVersion.toString(version.version)}
      this.log.info(`Set up service ${addrToString(service.id)}`)
    }

    this.log.info(
      `Set up service version ${SemverVersion.toString(version.version)}`
    )
    this.services_active.add(version)
    return version.version
  }

  /**
   * Gets a service by ID from currently registered services. Call infrequently
   * since it's fairly slow.
   * @param id Service to get
   * @returns The `ServiceDescriptor` of that service or `undefined`
   */
  getService(id: rpc.MultistringAddress): ServiceDescriptor | undefined {
    let service: ServiceDescriptor | undefined = undefined
    this.services.forEach((s) => {
      if (addrsEqual(id, s.id)) {
        service = s
      }
    })
    return service
  }

  getServiceDependency(
    id: rpc.MultistringAddress,
    req: SemverVersion | MinimumSemver
  ): Service {
    const service = this.getService(id)
    if (!service) {
      throw new TypeError(
        `Service ${addrToString(id)} requested, but not found`
      )
    }
    if (!this.setupServiceVersion(service, req)) {
      function v2s(v: SemverVersion | MinimumSemver) {
        return v.length === 3
          ? SemverVersion.toString(v)
          : MinimumSemver.toString(v)
      }
      throw new TypeError(
        `Version ${v2s(req)} or applicable for ${addrToString(service.id)} ` +
          `not found`
      )
    }
    let instance: Service | undefined
    if (!service || !(instance = this.service_instaces.get(service.service))) {
      throw new TypeError(`Service ${addrToString(id)} set up, but not found`)
    }
    return instance
  }

  @rpc.RpcAddress(['net', 'kb1rd', 'services', 'requestServices'])
  @rpc.RemapArguments(['drop', 'drop'])
  @rpc.EnforceMethodArgSchema({
    type: 'array',
    items: ServiceRequest.Schema
  })
  requestServices(...requests: ServiceRequest[]): ServiceResponse[] {
    function v2s(v: SemverVersion | MinimumSemver) {
      return v.length === 3
        ? SemverVersion.toString(v)
        : MinimumSemver.toString(v)
    }
    this.log.info(
      'Recieved request for services ' +
        requests
          .map(({ id, versions }) => {
            return (
              `${addrToString(id)} version (` +
              versions.map((v) => v2s(v)).join(' or ') +
              ')'
            )
          })
          .join(', ')
    )
    return requests.map(({ id, versions }) => {
      const service = this.getService(id)
      if (!service) {
        throw new TypeError(`Service ${addrToString(id)} not registered`)
      }
      let version: SemverVersion | undefined = undefined
      versions.some((ver) => {
        version = this.setupServiceVersion(service, ver)
      })
      if (!version) {
        throw new TypeError(
          `Unable to find suitable version for ${addrToString(id)}`
        )
      }
      return { id, version }
    })
  }
}

export default MainWorker

interface Remote {
  net: {
    kb1rd: {
      services: ServicesRemote
      accounts: AccountsServiceExports.Remote
      mxbindings: MatrixServiceExports.Remote
      apps: AppsServiceExports.Remote
    }
  }
}

export { BaseWorker, Remote }
