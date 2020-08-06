import * as rpc from 'rpcchannel'
import * as loglvl from 'loglevel'
import * as Ajv from 'ajv'

import { GeneratorListener } from '../generatorlistener'

import MainWorker from '../index'

import {
  Service,
  ServiceDescriptor,
  SemverVersion,
  prefixServiceRpc
} from './service'
import { Serializable } from 'child_process'

// This really should be in Ajv
// eslint-disable-next-line
type AjvSchema = {}

class Account {
  constructor(
    public readonly uid: string,
    public readonly parent: ServiceClass
  ) {}

  storageGet(key: string): Serializable {
    return this.parent.parent.storage_backend.get(`accounts/${this.uid}/${key}`)
  }
  storageSet(key: string, value: Serializable): void {
    this.parent.parent.storage_backend.set(`accounts/${this.uid}/${key}`, value)
  }
  storageGetSchema<T>(key: string, schema: AjvSchema, def?: T): T {
    const value = this.storageGet(key)
    const Validate =
      this.parent.known_data_schema_validators.get(schema) ||
      this.parent.parent.ajv.compile(schema)
    Validate(value)
    if (Validate.errors?.length) {
      const error = new Ajv.ValidationError([...Validate.errors])
      Validate.errors.length = 0
      if (def === undefined) {
        throw error
      } else {
        return def
      }
    }
    return (value as unknown) as T
  }
}

interface RemoteV0 {
  createAccount(): Promise<string>
  getAccounts(): Promise<string>
  listenAccounts(): AsyncGenerator<string[], void, void>

  [account: string]:
    | { exists(): Promise<boolean> }
    | RemoteV0['createAccount']
    | RemoteV0['getAccounts']
    | RemoteV0['listenAccounts']
}

interface Remote {
  v0: RemoteV0
}

class ServiceClass implements Service {
  map = new GeneratorListener<{ [uid: string]: Account }>({})

  /**
   * Keeps track of schema objects that have been used to access data via the
   * storage APIs
   */
  known_data_schema_validators = new WeakMap<AjvSchema, Ajv.ValidateFunction>()

  constructor(
    public readonly parent: MainWorker,
    protected readonly log: loglvl.Logger
  ) {}

  @rpc.RpcAddress(['v0', 'createAccount'])
  createAccount(): string {
    let key: string
    do {
      key = ''
      // Create a random unsigned 128 bit uint encoded as base16
      // (16 groups of 2 chars, 4 bits each)
      for (let i = 0; i < 16; i++) {
        key += Math.floor(Math.random() * 255)
          .toString(16)
          .padStart(2, '0')
      }
    } while (this.map.value[key])
    this.map.value[key] = new Account(key, this)
    this.map.pushUpdate()
    this.log.info(`Created new account UID ${key}`)
    return key
  }
  @rpc.RpcAddress(['v0', 'getAccounts'])
  getAccounts(): string[] {
    return Object.keys(this.map.value)
  }

  @rpc.RpcAddress(['v0', 'listenAccounts'])
  async *listenAccounts(): AsyncGenerator<string[], void, void> {
    for await (const map of this.map.generate()) {
      yield Object.keys(map)
    }
  }

  @rpc.RpcAddress(['v0', undefined, 'exists'])
  @rpc.RemapArguments(['drop', 'expand'])
  exists(name: string): boolean {
    return Boolean(this.map.value[name])
  }

  getAccount(name: string): Account {
    return this.map.value[name]
  }
}

const AccountsService: ServiceDescriptor = prefixServiceRpc({
  id: ['net', 'kb1rd', 'accounts'],
  service: ServiceClass,
  versions: [{ version: [0, 1, 0] as SemverVersion }]
})

export default AccountsService
export { ServiceClass, Remote }
