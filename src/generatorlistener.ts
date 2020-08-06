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
    this._value = v
    this.pushUpdate()
  }
}

export { GeneratorListener }
