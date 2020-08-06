import { MultistringAddress, RpcFunctionAddress } from 'rpcchannel'
import * as loglvl from 'loglevel'
import MainWorker from '../index'

/**
 * Semver version. Array of [major, minor, bug]
 */
type SemverVersion = [number, number, number]
namespace SemverVersion {
  export const Schema = {
    type: 'array',
    items: { type: 'number' },
    minItems: 3,
    maxItems: 3
  }
  export const toString = (v: SemverVersion): string =>
    `v${v[0]}.${v[1]}.${v[2]}`
}
/**
 * A type for minimum semver requirements. Array of [major, minor]
 */
type MinimumSemver = [number, number]
namespace MinimumSemver {
  export const Schema = {
    type: 'array',
    items: { type: 'number' },
    minItems: 2,
    // Allow a full semver
    maxItems: 3
  }
  export const toString = (v: MinimumSemver): string => `v${v[0]}.${v[1]}.*`
}

interface ServiceRequest {
  id: MultistringAddress
  versions: MinimumSemver[]
}
namespace ServiceRequest {
  export const Schema = {
    type: 'object',
    properties: {
      id: { type: 'array', items: { type: 'string' } },
      versions: { type: 'array', items: MinimumSemver.Schema }
    },
    required: ['id', 'versions']
  }
}
interface ServiceResponse {
  id: MultistringAddress
  version: SemverVersion
}

/**
 * Base interface for all services
 */
// eslint-disable-next-line
interface Service {}

interface ServiceOpts {
  createChildLogger(name: string): loglvl.Logger
}

type ServiceConstructor = {
  new (worker: MainWorker, log: loglvl.Logger, opts: ServiceOpts): Service
  // eslint-disable-next-line
  [key: string]: any
}

interface ServiceVersionDescriptor {
  readonly version: SemverVersion
}

/**
 * Metadata used in automatic service registry
 */
interface ServiceDescriptor {
  readonly id: MultistringAddress
  readonly service: ServiceConstructor
  readonly versions: ServiceVersionDescriptor[]
}

function prefixServiceRpc(service: ServiceDescriptor): ServiceDescriptor {
  let obj = service.service.prototype
  // Based on https://stackoverflow.com/a/31055217/7853604
  do {
    for (const k of Object.getOwnPropertyNames(obj)) {
      const func = obj[k]
      if (func && func[RpcFunctionAddress] && typeof func === 'function') {
        func[RpcFunctionAddress] = [...service.id, ...func[RpcFunctionAddress]]
      }
    }
  } while ((obj = Object.getPrototypeOf(obj)))
  return service
}

export {
  SemverVersion,
  MinimumSemver,
  Service,
  ServiceOpts,
  ServiceConstructor,
  ServiceDescriptor,
  ServiceVersionDescriptor,
  ServiceRequest,
  ServiceResponse,
  prefixServiceRpc
}
