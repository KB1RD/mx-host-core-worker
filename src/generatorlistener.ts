class GeneratorListener<T> {
  protected callbacks = new Set<() => void>()
  constructor(protected _value: T) {}
  pushUpdate(): void {
    this.callbacks.forEach((c) => c())
    this.callbacks.clear()
  }
  async *generate(): AsyncGenerator<T, void, void> {
    let promise: Promise<void>
    while (true) {
      promise = new Promise((r) => this.callbacks.add(() => r()))
      yield this._value
      await promise
    }
  }

  get value(): T {
    return this._value
  }
  set value(v: T) {
    const update = this._value !== v
    this._value = v
    if (update) {
      this.pushUpdate()
    }
  }
}

class MapGeneratorListener<V> {
  readonly map: { [key: string]: V } = {}
  protected readonly callbacks = new Set<() => void>()
  protected readonly key_callbacks: { [key: string]: Set<() => void> } = {}
  protected readonly map_callbacks = new Set<() => void>()

  pushKeyUpdate(): void {
    this.callbacks.forEach((c) => c())
    this.callbacks.clear()
  }
  pushUpdate(key: string): void {
    if (this.key_callbacks[key]) {
      this.key_callbacks[key].forEach((c) => c())
      delete this.key_callbacks[key]
    }
    this.map_callbacks.forEach((c) => c())
    this.map_callbacks.clear()
  }
  async *generateKeys(): AsyncGenerator<string[], void, void> {
    let promise: Promise<void>
    while (true) {
      promise = new Promise((r) => this.callbacks.add(() => r()))
      yield Object.keys(this.map)
      await promise
    }
  }
  async *generateMap(): AsyncGenerator<{ [key: string]: V }, void, void> {
    let promise: Promise<void>
    while (true) {
      promise = new Promise((r) => this.map_callbacks.add(() => r()))
      yield this.value
      await promise
    }
  }
  async *generate(k: string): AsyncGenerator<V | undefined, void, void> {
    let promise: Promise<void>
    while (true) {
      if (!this.key_callbacks[k]) {
        this.key_callbacks[k] = new Set()
      }
      promise = new Promise((r) => this.key_callbacks[k].add(() => r()))
      yield this.map[k]
      await promise
    }
  }

  get value(): { [key: string]: V } {
    // eslint-disable-next-line
    const self = this
    return new Proxy(self.map, {
      ownKeys(): string[] {
        return Object.keys(self.map)
      },
      has(target: { [key: string]: V }, key: string): boolean {
        return key in self.map
      },
      get(target: { [key: string]: V }, key: string): V | undefined {
        return self.map[key]
      },
      set(target: { [key: string]: V }, key: string, val: V): boolean {
        const prev = self.map[key]
        if (val) {
          self.map[key] = val
        } else {
          delete self.map[key]
        }
        if (val ? !prev : prev) {
          self.pushKeyUpdate()
        }
        self.pushUpdate(key)
        return true
      }
    })
  }
}

export { GeneratorListener, MapGeneratorListener }
