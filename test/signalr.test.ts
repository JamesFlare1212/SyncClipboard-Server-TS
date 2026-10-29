import { describe, expect, test } from "bun:test";
import { HubConnectionBuilder, HttpTransportType, HubConnectionState, LogLevel } from "@microsoft/signalr";
import { auth, fixture, textHistory } from "./helpers";
import { createServer } from "../src/server";

function deferred<T>(timeout = 3000) {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const timer = setTimeout(() => reject(new Error("SignalR event timeout")), timeout);
  return { promise: promise.finally(() => clearTimeout(timer)), resolve, reject };
}

async function rawConnection(url: string) {
  const BunWebSocket = WebSocket as unknown as { new (url: string, options: Bun.WebSocketOptions): WebSocket };
  const ws = new BunWebSocket(`${url.replace("http:", "ws:")}/SyncClipboardHub`, {
    headers: { Authorization: auth },
  });
  const opened = deferred<void>();
  const queue: string[] = [];
  let pending: ReturnType<typeof deferred<string>> | undefined;
  ws.addEventListener("open", () => opened.resolve());
  ws.addEventListener("error", () => opened.reject(new Error("WebSocket connection failed")));
  ws.addEventListener("message", (event) => {
    if (pending) {
      pending.resolve(String(event.data));
      pending = undefined;
    } else {
      queue.push(String(event.data));
    }
  });
  try {
    await opened.promise;
  } catch (error) {
    ws.close();
    throw error;
  }
  return {
    ws,
    next(timeout = 3000) {
      if (queue.length) {
        return Promise.resolve(queue.shift()!);
      }
      const result = deferred<string>(timeout);
      pending = result;
      return result.promise.finally(() => {
        if (pending === result) {
          pending = undefined;
        }
      });
    },
    async closed() {
      if (ws.readyState !== WebSocket.CLOSED) {
        const result = deferred<void>();
        ws.addEventListener("close", () => result.resolve(), { once: true });
        await result.promise;
      }
    },
  };
}

describe("SignalR JSON protocol interoperability", () => {
  test.concurrent(
    "LongPolling stays connected beyond the client timeout using transport keepalive",
    async () => {
      await using f = await fixture();
      const connection = new HubConnectionBuilder()
        .configureLogging(LogLevel.None)
        .withUrl(`${f.url}/SyncClipboardHub`, {
          transport: HttpTransportType.LongPolling,
          headers: { Authorization: auth },
        })
        .build();
      await connection.start();
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 32_000));
        expect(connection.state).toBe(HubConnectionState.Connected);
        const received = deferred<any>();
        connection.on("RemoteProfileChanged", received.resolve);
        await f.json("/SyncClipboard.json", "PUT", { text: "after idle" });
        expect((await received.promise).text).toBe("after idle");
      } finally {
        await connection.stop();
      }
    },
    40_000,
  );
  for (const ready of [false, true]) {
    test.concurrent(
      `inactive WebSocket expires after ${ready ? "handshake" : "connection"}`,
      async () => {
        await using f = await fixture();
        const socket = await rawConnection(f.url);
        try {
          if (ready) {
            socket.ws.send('{"protocol":"json","version":1}\x1e');
            expect(await socket.next()).toBe("{}\x1e");
          }
          const deadline = Date.now() + 40_000;
          let error;
          do {
            error = JSON.parse((await socket.next(Math.max(1, deadline - Date.now()))).replace(/\x1e$/, ""));
          } while (ready && error.type === 6);
          expect(error.error).toBe("Connection timed out.");
          if (ready) {
            expect(error.type).toBe(7);
          }
          await socket.closed();
        } finally {
          socket.ws.close();
        }
      },
      45_000,
    );
  }
  for (const transport of [
    HttpTransportType.WebSockets,
    HttpTransportType.ServerSentEvents,
    HttpTransportType.LongPolling,
  ]) {
    test(`official Microsoft client receives both events over ${HttpTransportType[transport]}`, async () => {
      await using f = await fixture();
      const connection = new HubConnectionBuilder()
        .configureLogging(LogLevel.None)
        .withUrl(`${f.url}/SyncClipboardHub`, { transport, headers: { Authorization: auth } })
        .build();
      const profiles: unknown[] = [];
      const history: unknown[] = [];
      connection.on("RemoteProfileChanged", (value) => profiles.push(value));
      connection.on("RemoteHistoryChanged", (value) => history.push(value));
      await connection.start();
      try {
        const changed = deferred<any>();
        connection.on("RemoteProfileChanged", changed.resolve);
        expect((await f.json("/SyncClipboard.json", "PUT", { text: "live notification" })).status).toBe(200);
        const profile = await changed.promise;
        expect(profile.text).toBe("live notification");
        expect(profile.syncedAt).toBeDefined();
        expect(history).toHaveLength(1);
        const historyChanged = deferred<any>();
        connection.on("RemoteHistoryChanged", historyChanged.resolve);
        await f.upload(textHistory("history notification"));
        expect((await historyChanged.promise).text).toBe("history notification");
        expect(profiles).toHaveLength(1);
        await expect(connection.invoke("UnknownMethod")).rejects.toThrow("Unknown hub method");
      } finally {
        await connection.stop();
      }
    });
  }

  test("multiple connections receive broadcast, reconnect and rejected updates emit nothing", async () => {
    await using f = await fixture();
    const make = () =>
      new HubConnectionBuilder()
        .configureLogging(LogLevel.None)
        .withUrl(`${f.url}/SyncClipboardHub`, { headers: { Authorization: auth } })
        .build();
    const a = make();
    const b = make();
    await Promise.all([a.start(), b.start()]);
    try {
      const nextA = deferred<any>();
      const nextB = deferred<any>();
      a.on("RemoteProfileChanged", nextA.resolve);
      b.on("RemoteProfileChanged", nextB.resolve);
      await f.json("/SyncClipboard.json", "PUT", { text: "broadcast" });
      expect(await nextA.promise).toEqual(await nextB.promise);
      await a.stop();
      await a.start();
      const received: unknown[] = [];
      a.on("RemoteProfileChanged", (value) => received.push(value));
      expect((await f.json("/SyncClipboard.json", "PUT", { text: "bad", hash: "A".repeat(64) })).status).toBe(400);
      const again = deferred<any>();
      a.on("RemoteProfileChanged", again.resolve);
      await f.json("/SyncClipboard.json", "PUT", { text: "after reconnect" });
      expect((await again.promise).text).toBe("after reconnect");
      expect(received).toHaveLength(1);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  test("negotiation v0/v1, unknown tokens and no-auth are handled", async () => {
    await using f = await fixture();
    for (const version of [0, 1]) {
      const response = await f.request(`/SyncClipboardHub/negotiate?negotiateVersion=${version}`, { method: "POST" });
      const info = await response.json();
      expect(info.negotiateVersion).toBe(version);
      expect(info.connectionId).toBeString();
      expect(!!info.connectionToken).toBe(version === 1);
      const token = info.connectionToken ?? info.connectionId;
      expect((await f.request(`/SyncClipboardHub?id=${token}`)).status).toBe(200);
      expect((await f.request(`/SyncClipboardHub?id=${token}`, { method: "DELETE" })).status).toBe(202);
      expect((await f.request(`/SyncClipboardHub?id=${token}`)).status).toBe(404);
    }
    expect((await f.request("/SyncClipboardHub?id=bad")).status).toBe(404);
    expect((await f.request("/SyncClipboardHub")).status).toBe(400);
    const unauthenticated = new HubConnectionBuilder()
      .configureLogging(LogLevel.None)
      .withUrl(`${f.url}/SyncClipboardHub`)
      .build();
    await expect(unauthenticated.start()).rejects.toThrow("401");
  });

  test("invalid negotiation and transport reuse are rejected without invalidating a working session", async () => {
    await using f = await fixture();
    expect((await f.request("/SyncClipboardHub/negotiate")).status).toBe(405);
    for (const version of ["-1", "1.5", "invalid"]) {
      expect(
        (await f.request(`/SyncClipboardHub/negotiate?negotiateVersion=${version}`, { method: "POST" })).status,
      ).toBe(400);
    }
    const info = await (await f.request("/SyncClipboardHub/negotiate?negotiateVersion=1", { method: "POST" })).json();
    const path = `/SyncClipboardHub?id=${info.connectionToken}`;
    expect((await f.request(path, { method: "POST", body: "{}\x1e" })).status).toBe(400);
    expect((await f.request(path)).status).toBe(200);
    expect((await f.request(path, { method: "PATCH" })).status).toBe(405);
    expect((await f.request(path, { headers: { accept: "text/event-stream" } })).status).toBe(409);
    expect((await f.request(path, { method: "POST", body: '{"protocol":"json","version":1}\x1e' })).status).toBe(200);
    expect(await (await f.request(path)).text()).toBe("{}\x1e");
    expect((await f.request(path, { method: "DELETE" })).status).toBe(202);
  });

  test("overlapping long polls reject one request and aborted polls do not prevent subsequent notifications", async () => {
    await using f = await fixture();
    const info = await (await f.request("/SyncClipboardHub/negotiate?negotiateVersion=1", { method: "POST" })).json();
    const path = `/SyncClipboardHub?id=${info.connectionToken}`;
    expect((await f.request(path)).status).toBe(200);
    await f.request(path, { method: "POST", body: '{"protocol":"json","version":1}\x1e' });
    expect(await (await f.request(path)).text()).toBe("{}\x1e");
    const controllers = [new AbortController(), new AbortController()];
    const polls = controllers.map((controller) => f.request(path, { signal: controller.signal }));
    try {
      expect((await Promise.race(polls)).status).toBe(409);
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.allSettled(polls);
    }
    expect((await f.json("/SyncClipboard.json", "PUT", { text: "after canceled polling" })).status).toBe(200);
    const response = await f.request(path);
    expect(response.status).toBe(200);
    const events = (await response.text())
      .split("\x1e")
      .filter(Boolean)
      .map((frame) => JSON.parse(frame));
    expect(events.find((event) => event.target === "RemoteProfileChanged")?.arguments[0].text).toBe(
      "after canceled polling",
    );
    await f.request(path, { method: "DELETE" });
  });

  test("official client automatically reconnects after a server restart and receives new notifications", async () => {
    await using f = await fixture();
    const config = { ...f.config, port: f.server.port! };
    const connection = new HubConnectionBuilder()
      .configureLogging(LogLevel.None)
      .withUrl(`${f.url}/SyncClipboardHub`, { headers: { Authorization: auth } })
      .withAutomaticReconnect([0, 50, 100, 250, 500])
      .build();
    let restarted: ReturnType<typeof createServer> | undefined;
    try {
      await connection.start();
      const reconnecting = deferred<void>();
      const reconnected = deferred<void>();
      connection.onreconnecting(() => reconnecting.resolve());
      connection.onreconnected(() => reconnected.resolve());
      await f.stop();
      await reconnecting.promise;
      restarted = createServer(config, { cleanup: false });
      await reconnected.promise;
      expect(connection.state).toBe(HubConnectionState.Connected);
      const received = deferred<any>();
      connection.on("RemoteProfileChanged", received.resolve);
      expect((await f.json("/SyncClipboard.json", "PUT", { text: "after automatic reconnect" })).status).toBe(200);
      expect((await received.promise).text).toBe("after automatic reconnect");
    } finally {
      await connection.stop();
      await restarted?.stop();
    }
  });

  for (const [ready, body] of [
    [false, "{broken}\x1e"],
    [false, "null\x1e"],
    [false, '{"protocol":"json","version":2}\x1e'],
    [true, "{broken}\x1e"],
    [true, "42\x1e"],
    [true, '{"type":99}\x1e'],
  ] as const) {
    test(`invalid ${ready ? "hub message" : "handshake"} closes the connection: ${JSON.stringify(body)}`, async () => {
      await using f = await fixture();
      const socket = await rawConnection(f.url);
      try {
        if (ready) {
          socket.ws.send('{"protocol":"json","version":1}\x1e');
          expect(await socket.next()).toBe("{}\x1e");
        }
        socket.ws.send(body);
        const error = JSON.parse((await socket.next()).replace(/\x1e$/, ""));
        expect(error.error).toBeString();
        if (ready) {
          expect(error.type).toBe(7);
        }
        await socket.closed();
        expect((await f.json("/SyncClipboard.json", "PUT", { text: "server still available" })).status).toBe(200);
      } finally {
        socket.ws.close();
      }
    });
  }

  test("fragmented messages enforce the UTF-8 byte limit even when each WebSocket message is below it", async () => {
    await using f = await fixture();
    const socket = await rawConnection(f.url);
    try {
      socket.ws.send('{"protocol":"json","version":1}\x1e');
      expect(await socket.next()).toBe("{}\x1e");
      socket.ws.send('"' + "中".repeat(6000));
      socket.ws.send("中".repeat(6000) + '"\x1e');
      const error = JSON.parse((await socket.next()).replace(/\x1e$/, ""));
      expect(error).toEqual({ type: 7, error: "Message exceeds the size limit." });
      await socket.closed();
    } finally {
      socket.ws.close();
    }
  });

  test("multiple JSON frames in one WebSocket message are processed in order", async () => {
    await using f = await fixture();
    const socket = await rawConnection(f.url);
    try {
      socket.ws.send(
        '{"protocol":"json","version":1}\x1e{"type":6}\x1e{"type":1,"invocationId":"first","target":"Unknown"}\x1e{"type":1,"invocationId":"second","target":"Unknown"}\x1e',
      );
      expect(await socket.next()).toBe("{}\x1e");
      for (const invocationId of ["first", "second"]) {
        expect(JSON.parse((await socket.next()).replace(/\x1e$/, ""))).toEqual({
          type: 3,
          invocationId,
          error: "Unknown hub method.",
        });
      }
    } finally {
      socket.ws.close();
    }
  });

  test("direct WebSocket handshake accepts fragmented frames and rejects unsupported protocol", async () => {
    await using f = await fixture();
    for (const protocol of ["json", "messagepack"]) {
      const socket = await rawConnection(f.url);
      try {
        socket.ws.send(`{"protocol":"${protocol}",`);
        socket.ws.send('"version":1}\x1e');
        const response = await socket.next();
        if (protocol === "json") {
          expect(response).toBe("{}\x1e");
        } else {
          expect(response).toContain("error");
          await socket.closed();
        }
      } finally {
        socket.ws.close();
      }
    }
  });
});
