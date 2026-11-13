import WebSocket from 'ws';

const MAX_COMMAND_MS = 30_000;

export class BiDiError extends Error {
  constructor(
    method: string,
    readonly code: string,
    message: string,
  ) {
    super(`${method}: ${message || code}`);
  }
}

interface PendingCommand {
  method: string;
  timer: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

type EventListener = (params: unknown) => void;

function remainingMs(deadline: number | undefined, maximum = MAX_COMMAND_MS): number {
  return deadline === undefined ? maximum : Math.min(maximum, deadline - Date.now());
}

export class BiDiConnection {
  private nextId = 0;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Set<EventListener>>();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', data => {
      let message: {
        id?: number;
        type?: string;
        method?: string;
        params?: unknown;
        result?: unknown;
        error?: string;
        message?: string;
      } | null;
      try {
        message = JSON.parse(data.toString());
      } catch {
        socket.terminate();
        return;
      }
      if (message?.type === 'event' && typeof message.method === 'string') {
        for (const listener of this.listeners.get(message.method) ?? []) {
          try {
            listener(message.params);
          } catch {
            // One observer cannot tear down the session.
          }
        }
        return;
      }
      if (typeof message?.id !== 'number') return;
      const command = this.pending.get(message.id);
      if (!command) return;
      this.pending.delete(message.id);
      clearTimeout(command.timer);
      if (message.type === 'success') command.resolve(message.result);
      else {
        command.reject(
          new BiDiError(command.method, message.error ?? 'unknown error', message.message ?? ''),
        );
      }
    });
    const rejectPending = (error: Error) => {
      for (const command of this.pending.values()) {
        clearTimeout(command.timer);
        command.reject(error);
      }
      this.pending.clear();
    };
    socket.on('error', rejectPending);
    socket.once('close', () => rejectPending(new Error('Firefox BiDi connection closed')));
  }

  static async connect(port: number, deadline?: number): Promise<BiDiConnection> {
    const timeout = remainingMs(deadline, 5_000);
    if (timeout <= 0) throw new Error('Firefox attach deadline exceeded');
    const socket = new WebSocket(`ws://127.0.0.1:${port}/session`, {
      handshakeTimeout: timeout,
      maxPayload: 64 * 1024 * 1024,
      perMessageDeflate: false,
    });
    const connection = new BiDiConnection(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      return connection;
    } catch (cause) {
      socket.terminate();
      throw new Error(
        `Cannot connect to Firefox on 127.0.0.1:${port}. Start it with --remote-debugging-port ${port}.`,
        { cause },
      );
    }
  }

  get connected(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  onClose(listener: () => void): void {
    this.socket.once('close', listener);
  }

  on(method: string, listener: EventListener): void {
    const listeners = this.listeners.get(method) ?? new Set<EventListener>();
    listeners.add(listener);
    this.listeners.set(method, listeners);
  }

  send<T = unknown>(method: string, params: object = {}, deadline?: number): Promise<T> {
    const timeout = remainingMs(deadline);
    if (timeout <= 0) return Promise.reject(new Error(`${method}: request deadline exceeded`));
    if (!this.connected) return Promise.reject(new Error('Firefox BiDi connection is closed'));

    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: request timed out`));
      }, timeout);
      this.pending.set(id, { method, timer, resolve: result => resolve(result as T), reject });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error || !this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async end(): Promise<void> {
    try {
      // Firefox can keep a BiDi session active after its WebSocket drops.
      await this.send('session.end', {}, Date.now() + 5_000);
    } finally {
      this.socket.terminate();
    }
  }

  disconnect(): void {
    this.socket.terminate();
  }
}
