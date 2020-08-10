import { Serializable } from 'child_process'

type OptionalSerializable = Serializable | null | undefined

interface KvStorageBackend {
  get(key: string): Promise<OptionalSerializable>
  set(key: string, value: OptionalSerializable): Promise<void>
}

class KvBackendCache {
  protected readonly cache: { [key: string]: Serializable } = {}
  constructor(protected readonly origin: KvStorageBackend) {}
  get(key: string): Promise<OptionalSerializable> {
    return (
      (this.cache[key] && Promise.resolve(this.cache[key])) ||
      this.origin.get(key)
    )
  }
  async set(key: string, value: OptionalSerializable): Promise<void> {
    await this.origin.set(key, value)
    if (value === undefined || value === null) {
      delete this.cache[key]
    } else {
      this.cache[key] = value
    }
  }
}

export { OptionalSerializable, KvStorageBackend, KvBackendCache }
