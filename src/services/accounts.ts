import * as rpc from 'rpcchannel'
import * as loglvl from 'loglevel'
import * as Ajv from 'ajv'

import * as utils from '../utils'

import { GeneratorListener } from '../generatorlistener'

import MainWorker from '../index'

import {
  Service,
  ServiceDescriptor,
  SemverVersion,
  prefixServiceRpc
} from './service'
import { OptionalSerializable } from '../storage'

// This really should be in Ajv
// eslint-disable-next-line
type AjvSchema = {}

class Account {
  constructor(
    public readonly uid: string,
    public readonly parent: ServiceClass
  ) {}

  storageGet(key: string): Promise<OptionalSerializable> {
    return this.parent.parent.storage_backend.get(`accounts/${this.uid}/${key}`)
  }
  storageSet(key: string, value: OptionalSerializable): Promise<void> {
    return this.parent.parent.storage_backend.set(
      `accounts/${this.uid}/${key}`,
      value
    )
  }
  async storageGetSchema<T>(
    key: string,
    schema: AjvSchema,
    def?: T
  ): Promise<T> {
    const value = await this.storageGet(key)
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
  has_lazy_loaded = false

  /**
   * Keeps track of schema objects that have been used to access data via the
   * storage APIs
   */
  known_data_schema_validators = new WeakMap<AjvSchema, Ajv.ValidateFunction>()

  constructor(
    public readonly parent: MainWorker,
    protected readonly log: loglvl.Logger
  ) {}

  @rpc.RpcAddress(['v0', 'lazyLoadAccounts'])
  @rpc.RemapArguments(['drop', 'drop'])
  async lazyLoadAccounts(force = false): Promise<void> {
    if (!this.has_lazy_loaded || force) {
      this.has_lazy_loaded = true
      this.log.info(`Loading accounts from storage...`)
      const list = await this.parent.storage_backend.get('accounts.list')
      // IMO manual validation is easier (and probably faster) than schema
      // validation here
      if (Array.isArray(list)) {
        this.log.info(`Found ${(list || 0) && list.length} accounts in storage`)
        for (const uid of list) {
          if (typeof uid === 'string' && !this.map.value[uid]) {
            this.map.value[uid] = new Account(uid, this)
          }
        }
        this.map.pushUpdate()
      } else {
        this.log.info(`Found empty or corrupt account list`)
      }
    }
  }

  @rpc.RpcAddress(['v0', 'saveAccountList'])
  async saveAccountList(): Promise<void> {
    this.log.info(`Saving account list to storage`)
    await this.parent.storage_backend.set(
      'accounts.list',
      Object.keys(this.map.value)
    )
  }

  @rpc.RpcAddress(['v0', 'createAccount'])
  async createAccount(): Promise<string> {
    // Even though its random, this should still be loaded to prevent potential
    // name collisions with shorter account UIDs
    await this.lazyLoadAccounts()
    const key = utils.generateUniqueKey(16, (k) => Boolean(this.map.value[k]))
    this.map.value[key] = new Account(key, this)
    this.map.pushUpdate()
    await this.saveAccountList()
    this.log.info(`Created new account UID ${key}`)
    return key
  }

  @rpc.RpcAddress(['v0', 'getAccounts'])
  async getAccounts(): Promise<string[]> {
    await this.lazyLoadAccounts()
    return Object.keys(this.map.value)
  }
  @rpc.RpcAddress(['v0', 'listenAccounts'])
  async *listenAccounts(): AsyncGenerator<string[], void, void> {
    await this.lazyLoadAccounts()
    for await (const map of this.map.generate()) {
      yield Object.keys(map)
    }
  }

  @rpc.RpcAddress(['v0', undefined, 'exists'])
  @rpc.RemapArguments(['drop', 'expand'])
  async exists(name: string): Promise<boolean> {
    await this.lazyLoadAccounts()
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
