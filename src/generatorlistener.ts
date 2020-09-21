class GeneratorListener<T> {
  callbacks = new Set<() => void>()
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
    const setKey = (key: string, val: V | undefined): void => {
      const prev = self.map[key]
      if (val) {
        self.map[key] = val
      } else {
        delete self.map[key]
      }
      if (val !== prev) {
        if (val ? !prev : prev) {
          self.pushKeyUpdate()
        }
        self.pushUpdate(key)
      }
    }
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
      deleteProperty(target: { [key: string]: V }, key: string): boolean {
        setKey(key, undefined)
        return true
      },
      set(target: { [key: string]: V }, key: string, val: V): boolean {
        setKey(key, val)
        return true
      }
    })
  }
}

type ValuePusher<T, R = T> = {
  gen: AsyncGenerator<T, R | undefined, void>
  yield: (v: T) => void
  return: (v: R) => void
}

function createValuePusher<T, R = T>(): ValuePusher<T, R> {
  let _push: () => void
  let promise: Promise<unknown>
  const outbound_value_queue: IteratorResult<T, R>[] = []
  const nextPromise = () => {
    promise = new Promise(
      (r) =>
        (_push = () => {
          nextPromise()
          r()
        })
    )
  }
  nextPromise()

  let isdone = false

  const push = (v: IteratorResult<T, R>) => {
    outbound_value_queue.push(v)
    _push()
  }
  const yld = (value: T) => push({ value, done: false })
  const ret = (value: R) => {
    push({ value, done: true })
    isdone = true
  }

  const gen: AsyncGenerator<T, R | undefined, void> = {
    async next(): Promise<IteratorResult<T, R | undefined>> {
      do {
        if (outbound_value_queue.length) {
          return outbound_value_queue.shift() as IteratorResult<
            T,
            R | undefined
          >
        } else if (isdone) {
          return { done: true, value: undefined }
        }
        await promise
      } while (true)
    },
    async return(val: R) {
      isdone = true
      return { done: true, value: val }
    },
    async throw(e: Error) {
      isdone = true
      throw e
    },
    [Symbol.asyncIterator]() {
      return this
    }
  }

  return { gen, yield: yld, return: ret }
}

function chainGen<T>(
  genin: AsyncGenerator<AsyncGenerator<T, unknown, void>, void, void>
): AsyncGenerator<T, void, void> {
  const genout = createValuePusher<T, undefined>()

  let pub_gen: AsyncGenerator<T, unknown, void> | undefined
  async function startChaining() {
    if (!pub_gen) {
      return
    }
    const gen = pub_gen
    for await (const val of gen) {
      if (gen !== pub_gen) {
        break
      }
      genout.yield(val)
    }
  }

  ;(async function () {
    for await (const nextgen of genin) {
      if (pub_gen) {
        // Ensure that the generator is stopped
        pub_gen.return(undefined)
      }
      pub_gen = nextgen
      startChaining()
    }
    genout.return(undefined)
  })()

  return genout.gen
}

async function* mapGen<T1, R1, T2, R2, MR extends ((v: R1) => R2) | undefined>(
  genin: AsyncGenerator<T1, R1, void>,
  mapT: (v: T1) => T2,
  mapR: MR
): AsyncGenerator<T2, MR extends undefined ? undefined : R2, void> {
  let done, value
  while (({ done, value } = await genin.next()) && !done) {
    // This cannot run if `done` is true
    yield mapT(value as T1)
  }
  // Likewise, this cannot run unless `done` is true
  if (mapR) {
    return mapR(value as R1) as MR extends undefined ? undefined : R2
  } else {
    return undefined as MR extends undefined ? undefined : R2
  }
}

function chainMapGen<T1, T2>(
  genin: AsyncGenerator<T1, unknown, void>,
  mapT: (v: T1) => AsyncGenerator<T2>
): AsyncGenerator<T2> {
  return chainGen(mapGen(genin, mapT, undefined))
}

async function* yieldSingle<T>(v: T): AsyncGenerator<T, void, void> {
  yield v
  // This promise will never resolve
  await new Promise(() => undefined)
}

/* type ChainedGeneratorResult<T, R> = AsyncGenerator<T, R, void> & () => ChainedGeneratorResult<T, R> */

/* type AnyChainedGeneratorResult = ChainedGeneratorResult<unknown, unknown, AnyChainedGeneratorResult>

interface ChainedGeneratorResult<T, R, F extends AnyChainedGeneratorResult> extends AsyncGenerator<T, R, void> {
  T?: T
  R?: R
  F?: F
  (chain: (v: T) => AsyncGenerator<NonNullable<F['T']>, NonNullable<F['R']>, void>): ChainedGeneratorResult<NonNullable<F['T']>, NonNullable<F['R']>, NonNullable<F['F']>>
}

function chain<T, R, F extends AnyChainedGeneratorResult>(gen: AsyncGenerator<T, R, void>): ChainedGeneratorResult<T, R, F> {
  return Object.assign((chain: ))
} */

export {
  GeneratorListener,
  MapGeneratorListener,
  chainGen,
  mapGen,
  chainMapGen,
  yieldSingle
}
