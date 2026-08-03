type Listener = (event: MessageEvent) => void;

/**
 * Deterministic EventSource stand-in. Mirrors the pieces of the browser API
 * the app uses: constructor(url, {withCredentials}), addEventListener,
 * close(). Tests emit named events and error events manually. A browser
 * EventSource keeps the connection object alive across transport errors and
 * reconnects with the Last-Event-ID header; the tests assert the app never
 * closes or recreates the object on error, which is what preserves that
 * native resume behaviour.
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  static reset(): void {
    FakeEventSource.instances = [];
  }

  readonly url: string;
  readonly withCredentials: boolean;
  closed = false;

  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials === true;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type) ?? new Set<Listener>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    const event = {
      type,
      data: data === undefined ? "" : JSON.stringify(data),
    } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

export function installFakeEventSource(): void {
  (globalThis as { EventSource?: unknown }).EventSource =
    FakeEventSource as unknown as typeof EventSource;
}
