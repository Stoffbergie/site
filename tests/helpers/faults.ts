import net from "node:net";
import { baseUrl } from "./site";

export type Behavior =
  | { kind: "pass" }
  | { kind: "dropAfter"; bytes: number }
  | { kind: "stallAfter"; bytes: number }
  | { kind: "respond"; status: number; headers?: Record<string, string>; body?: string }
  | { kind: "dropResponse" }
  | { kind: "duplicate" }
  | { kind: "throttle"; bytesPerSecond: number }
  | { kind: "blackhole" };

export type FaultProxy = { url: string; connections: () => number; uploaded: () => number; close: () => void };

const target = new URL(baseUrl);

export async function faultProxy(plan: (connection: number) => Behavior): Promise<FaultProxy> {
  let connections = 0;
  let uploaded = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    connections += 1;
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => client.destroy());
    const behavior = plan(connections);
    handle(client, behavior, sockets, (count) => (uploaded += count));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    uploaded: () => uploaded,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  };
}

function upstreamSocket(sockets: Set<net.Socket>): net.Socket {
  const upstream = net.connect(Number(target.port), target.hostname);
  sockets.add(upstream);
  upstream.on("close", () => sockets.delete(upstream));
  upstream.on("error", () => upstream.destroy());
  return upstream;
}

function handle(client: net.Socket, behavior: Behavior, sockets: Set<net.Socket>, count: (bytes: number) => void): void {
  if (behavior.kind === "pass") {
    const upstream = upstreamSocket(sockets);
    client.on("data", (chunk: Buffer) => {
      count(chunk.byteLength);
      upstream.write(chunk);
    });
    upstream.pipe(client);
    client.on("end", () => upstream.end());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    return;
  }
  if (behavior.kind === "dropAfter" || behavior.kind === "stallAfter") {
    const upstream = upstreamSocket(sockets);
    let forwarded = 0;
    client.on("data", (chunk: Buffer) => {
      const room = behavior.bytes - forwarded;
      if (room <= 0) return;
      const part = chunk.subarray(0, room);
      forwarded += part.byteLength;
      count(part.byteLength);
      upstream.write(part);
      if (forwarded >= behavior.bytes && behavior.kind === "dropAfter") {
        client.resetAndDestroy();
        upstream.destroy();
      }
    });
    if (behavior.kind === "dropAfter") upstream.pipe(client);
    return;
  }
  if (behavior.kind === "blackhole") {
    client.on("data", (chunk: Buffer) => count(chunk.byteLength));
    return;
  }
  if (behavior.kind === "throttle") {
    const upstream = upstreamSocket(sockets);
    const queue: Buffer[] = [];
    client.on("data", (chunk: Buffer) => {
      queue.push(chunk);
      client.pause();
    });
    const tick = setInterval(() => {
      let budget = Math.ceil(behavior.bytesPerSecond / 10);
      while (budget > 0 && queue.length > 0) {
        const head = queue[0];
        const part = head.subarray(0, budget);
        upstream.write(part);
        count(part.byteLength);
        budget -= part.byteLength;
        if (part.byteLength === head.byteLength) queue.shift();
        else queue[0] = head.subarray(part.byteLength);
      }
      if (queue.length === 0) client.resume();
    }, 100);
    upstream.pipe(client);
    client.on("close", () => {
      clearInterval(tick);
      upstream.destroy();
    });
    upstream.on("close", () => {
      clearInterval(tick);
      client.destroy();
    });
    return;
  }
  readRequest(client, count, (request) => {
    if (behavior.kind === "respond") {
      const body = behavior.body ?? "";
      const headers = { "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(body)), connection: "close", ...behavior.headers };
      const lines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`);
      client.end(`HTTP/1.1 ${behavior.status} Injected\r\n${lines.join("\r\n")}\r\n\r\n${body}`);
      return;
    }
    if (behavior.kind === "dropResponse") {
      forward(request, sockets, () => client.resetAndDestroy());
      return;
    }
    forward(request, sockets, (first) => {
      forward(request, sockets, () => client.end(first));
    });
  });
}

function readRequest(client: net.Socket, count: (bytes: number) => void, done: (request: Buffer) => void): void {
  let received = Buffer.alloc(0);
  let finished = false;
  client.on("data", (chunk: Buffer) => {
    if (finished) return;
    count(chunk.byteLength);
    received = Buffer.concat([received, chunk]);
    const headerEnd = received.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const headerText = received.subarray(0, headerEnd).toString("latin1");
    const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(headerText)?.[1] ?? 0);
    if (received.byteLength < headerEnd + 4 + length) return;
    finished = true;
    done(received);
  });
}

function forward(request: Buffer, sockets: Set<net.Socket>, done: (response: Buffer) => void): void {
  const upstream = upstreamSocket(sockets);
  const chunks: Buffer[] = [];
  const withClose = request
    .toString("latin1")
    .replace(/\r\nconnection:[^\r]*/i, "")
    .replace("\r\n\r\n", "\r\nconnection: close\r\n\r\n");
  const headerEnd = request.indexOf("\r\n\r\n");
  upstream.write(Buffer.concat([Buffer.from(withClose.slice(0, withClose.indexOf("\r\n\r\n") + 4), "latin1"), request.subarray(headerEnd + 4)]));
  upstream.on("data", (chunk: Buffer) => chunks.push(chunk));
  upstream.on("end", () => done(Buffer.concat(chunks)));
}
