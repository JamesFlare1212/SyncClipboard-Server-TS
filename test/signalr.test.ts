import { describe, expect, test } from "bun:test";
import { HubConnectionBuilder, HttpTransportType, HubConnectionState, LogLevel } from "@microsoft/signalr";
import { auth, fixture, textHistory } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const timer = setTimeout(() => reject(new Error("Notification timeout")), 3000);
  return { promise: promise.finally(() => clearTimeout(timer)), resolve };
}

describe("SignalR JSON protocol interoperability", () => {
  test("LongPolling stays connected beyond the client timeout using transport keepalive", async () => {
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
  }, 40_000);
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

  test("direct WebSocket handshake accepts fragmented frames and rejects unsupported protocol", async () => {
    await using f = await fixture();
    async function connect(protocol: string) {
      const messages: string[] = [];
      const handshake = deferred<string>();
      const BunWebSocket = WebSocket as unknown as { new (url: string, options: Bun.WebSocketOptions): WebSocket };
      const ws = new BunWebSocket(`${f.url.replace("http:", "ws:")}/SyncClipboardHub`, {
        headers: { Authorization: auth },
      });
      ws.addEventListener("message", (event) => {
        messages.push(String(event.data));
        handshake.resolve(String(event.data));
      });
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", reject);
      });
      ws.send(`{"protocol":"${protocol}",`);
      ws.send('"version":1}\x1e');
      return { ws, messages, response: await handshake.promise };
    }
    const accepted = await connect("json");
    expect(accepted.response).toBe("{}\x1e");
    accepted.ws.close();
    const rejected = await connect("messagepack");
    expect(rejected.response).toContain("error");
    rejected.ws.close();
  });
});
