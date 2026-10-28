import type { Server, ServerWebSocket } from "bun";
import { HttpError } from "./errors";

const separator = "\x1e";
const frame = (value: unknown) => JSON.stringify(value) + separator;
const headers = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

interface Session {
  id: string;
  token: string;
  transport?: "WebSockets" | "ServerSentEvents" | "LongPolling";
  ready: boolean;
  created: number;
  received: number;
  sent: number;
  buffer: string;
  queue: string[];
  queuedBytes: number;
  socket?: ServerWebSocket<SocketData>;
  sse?: ReadableStreamDefaultController<Uint8Array>;
  poll?: (response: Response) => void;
}

export interface SocketData {
  session: Session;
}

export class SignalRHub {
  private sessions = new Map<string, Session>();
  private timer: ReturnType<typeof setInterval>;

  constructor() {
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }

  private create(): Session {
    if (this.sessions.size >= 10_000) {
      throw new HttpError(503, "Connection limit reached.");
    }
    const now = Date.now();
    const session: Session = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      ready: false,
      created: now,
      received: now,
      sent: now,
      buffer: "",
      queue: [],
      queuedBytes: 0,
    };
    this.sessions.set(session.token, session);
    return session;
  }

  negotiate(url: URL): Response {
    const version = url.searchParams.get("negotiateVersion") ?? "0";
    if (!/^\d+$/.test(version)) {
      throw new HttpError(400, "Invalid negotiate protocol version.");
    }
    const session = this.create();
    const negotiated = Math.min(1, Number(version));
    if (negotiated === 0) {
      this.sessions.delete(session.token);
      session.token = session.id;
      this.sessions.set(session.token, session);
    }
    return Response.json(
      {
        negotiateVersion: negotiated,
        connectionId: session.id,
        ...(negotiated ? { connectionToken: session.token } : {}),
        availableTransports: [
          { transport: "WebSockets", transferFormats: ["Text"] },
          { transport: "ServerSentEvents", transferFormats: ["Text"] },
          { transport: "LongPolling", transferFormats: ["Text"] },
        ],
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  async handle(request: Request, server: Server<SocketData>): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname.toLowerCase().endsWith("/negotiate")) {
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      return this.negotiate(url);
    }
    const token = url.searchParams.get("id");
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    const session = token ? this.sessions.get(token) : upgrade ? this.create() : undefined;
    if (!session) {
      return new Response("Connection not found.", { status: token ? 404 : 400 });
    }
    if (upgrade) {
      if (request.method !== "GET" || session.transport) {
        return new Response(null, { status: 409 });
      }
      session.transport = "WebSockets";
      if (server.upgrade(request, { data: { session } })) {
        return undefined;
      }
      this.close(session);
      return new Response("WebSocket upgrade failed.", { status: 400 });
    }
    if (request.method === "DELETE") {
      this.close(session);
      return new Response(null, { status: 202 });
    }
    if (request.method === "POST") {
      if (!session.transport || session.transport === "WebSockets") {
        return new Response(null, { status: 400 });
      }
      const body = await request.text();
      this.receive(session, body);
      return new Response(null, { status: 200 });
    }
    if (request.method !== "GET") {
      return new Response(null, { status: 405 });
    }
    // LongPolling has inherent keepalive: official clients do not send hub Ping frames on this transport.
    session.received = Date.now();
    if (request.headers.get("accept")?.includes("text/event-stream")) {
      if (session.transport) {
        return new Response(null, { status: 409 });
      }
      session.transport = "ServerSentEvents";
      const stream = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            session.sse = controller;
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          },
          cancel: () => this.close(session),
        },
        { highWaterMark: 16 * 1024 * 1024, size: (chunk) => chunk?.byteLength ?? 0 },
      );
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-store",
          "x-accel-buffering": "no",
        },
      });
    }
    if (!session.transport) {
      session.transport = "LongPolling";
      return new Response("", { headers });
    }
    if (session.transport !== "LongPolling" || session.poll) {
      return new Response(null, { status: 409 });
    }
    if (session.queue.length) {
      return this.flush(session);
    }
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => done(new Response("", { headers })), 20_000);
      const aborted = () => done(new Response(null, { status: 204 }));
      const done = (response: Response) => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", aborted);
        session.poll = undefined;
        resolve(response);
      };
      session.poll = done;
      request.signal.addEventListener("abort", aborted, { once: true });
      if (request.signal.aborted) {
        aborted();
      }
    });
  }

  readonly websocket = {
    maxPayloadLength: 32 * 1024,
    idleTimeout: 60,
    backpressureLimit: 16 * 1024 * 1024,
    closeOnBackpressureLimit: true,
    open: (socket: ServerWebSocket<SocketData>) => {
      socket.data.session.socket = socket;
    },
    message: (socket: ServerWebSocket<SocketData>, message: string | Buffer) => {
      this.receive(socket.data.session, typeof message === "string" ? message : message.toString("utf8"));
    },
    close: (socket: ServerWebSocket<SocketData>) => {
      this.close(socket.data.session);
    },
  };

  private receive(session: Session, body: string): void {
    session.received = Date.now();
    session.buffer += body;
    if (Buffer.byteLength(session.buffer) > 32 * 1024) {
      this.close(session, "Message exceeds the size limit.");
      return;
    }
    let index: number;
    while ((index = session.buffer.indexOf(separator)) >= 0) {
      const raw = session.buffer.slice(0, index);
      session.buffer = session.buffer.slice(index + 1);
      try {
        const message = JSON.parse(raw);
        if (!message || typeof message !== "object") {
          throw new Error("Invalid message.");
        }
        if (!session.ready) {
          if (message.protocol !== "json" || message.version !== 1) {
            this.send(session, frame({ error: "Only the JSON hub protocol version 1 is supported." }));
            this.close(session);
            return;
          }
          session.ready = true;
          this.send(session, frame({}));
        } else if (message.type === 1 || message.type === 4) {
          if (message.invocationId != null) {
            this.send(session, frame({ type: 3, invocationId: message.invocationId, error: "Unknown hub method." }));
          }
        } else if (message.type === 7) {
          this.close(session);
          return;
        } else if (![3, 5, 6].includes(message.type)) {
          throw new Error("Invalid message type.");
        }
      } catch {
        this.close(session, "Invalid hub protocol message.");
        return;
      }
    }
  }

  private flush(session: Session): Response {
    const text = session.queue.join("");
    session.queue = [];
    session.queuedBytes = 0;
    return new Response(text, { headers });
  }

  private send(session: Session, text: string): void {
    session.sent = Date.now();
    if (session.socket) {
      session.socket.send(text);
    } else if (session.sse) {
      if ((session.sse.desiredSize ?? 0) < Buffer.byteLength(text)) {
        this.close(session);
        return;
      }
      try {
        session.sse.enqueue(new TextEncoder().encode(`data: ${text}\n\n`));
      } catch {
        this.close(session);
      }
    } else {
      session.queue.push(text);
      session.queuedBytes += Buffer.byteLength(text);
      if (session.poll) {
        session.poll(this.flush(session));
      } else if (session.queuedBytes > 16 * 1024 * 1024) {
        this.close(session);
      }
    }
  }

  broadcast(target: string, value: unknown): void {
    const text = frame({ type: 1, target, arguments: [value] });
    for (const session of this.sessions.values()) {
      if (session.ready) {
        this.send(session, text);
      }
    }
  }

  private close(session: Session, error?: string): void {
    if (!this.sessions.delete(session.token)) {
      return;
    }
    if (error) {
      this.send(session, frame(session.ready ? { type: 7, error } : { error }));
    }
    session.socket?.close(1000);
    try {
      session.sse?.close();
    } catch {
      /* Transport already closed. */
    }
    session.poll?.(new Response(null, { status: 204 }));
  }

  private tick(): void {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if ((!session.ready && now - session.created > 15_000) || now - session.received > 30_000) {
        this.close(session, "Connection timed out.");
      } else if (session.ready && now - session.sent > 15_000) {
        this.send(session, frame({ type: 6 }));
      }
    }
  }

  stop(): void {
    clearInterval(this.timer);
    for (const session of this.sessions.values()) {
      this.close(session);
    }
  }
}
