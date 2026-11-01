import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type RecordedRequest = { url: string; headers: IncomingHttpHeaders };

export type LocalServer = {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  port: number;
  /** Every request the server received, in order. */
  requests: RecordedRequest[];
};

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const closers: Array<() => Promise<void>> = [];

/** Starts an HTTP server bound to 127.0.0.1 on an ephemeral port. */
export async function localServer(handler: Handler): Promise<LocalServer> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", headers: request.headers });
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Hung handlers (timeout tests) would otherwise keep close() waiting.
        server.closeAllConnections();
      }),
  );
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, port, requests };
}

/** Closes every server started since the last call; use in `afterEach`. */
export async function closeLocalServers(): Promise<void> {
  await Promise.all(closers.splice(0).map((close) => close()));
}

/** A handler that serves fixed bytes with the given media type. */
export function serveBytes(bytes: Uint8Array, contentType: string | undefined): Handler {
  return (_request, response) => {
    response.writeHead(200, {
      ...(contentType === undefined ? {} : { "Content-Type": contentType }),
      "Content-Length": String(bytes.byteLength),
    });
    response.end(bytes);
  };
}

/** A handler that answers with a redirect to `location`. */
export function redirectTo(location: string, status = 302): Handler {
  return (_request, response) => {
    response.writeHead(status, { Location: location, "Set-Cookie": "session=leak; Path=/" });
    response.end();
  };
}

/** Dispatches by request path; anything unrouted is a 404. */
export function routes(table: Record<string, Handler>): Handler {
  // A Map keeps request paths such as "/constructor" from reaching
  // Object.prototype members.
  const handlers = new Map(Object.entries(table));
  return (request, response) => {
    const handler = handlers.get(request.url ?? "");
    if (handler) {
      handler(request, response);
      return;
    }
    response.writeHead(404);
    response.end();
  };
}
