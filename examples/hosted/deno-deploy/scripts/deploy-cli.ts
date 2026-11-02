// Entry point that `deno deploy` runs in place of the Deno Deploy CLI, through
// the DENO_DEPLOY_CLI_SPECIFIER hook (see scripts/deno.mjs). Running inside
// `deno deploy` gives the CLI the operations that keep its sign-in in the
// system keyring (Windows Credential Manager, macOS Keychain, Secret Service),
// so it signs in through the browser once instead of on every run.
//
// Two things happen before the pinned CLI loads:
//
// 1. Deno 2.9.6 hands the CLI its arguments twice (`--prod . --prod .`), and
//    the CLI rejects every repeated option. When the second half repeats the
//    first, only one copy is kept.
// 2. With METAPLATE_DEPLOY_TRACE=1, every request to *.deno.com is logged to
//    stderr: method, path, status, and content type, and for the revision
//    event stream each update's status, step names, and label keys. Headers,
//    bodies, and label values other than deno.diffsync are never printed, so
//    the sign-in token stays out of the log. The CLI waits on that stream after
//    creating a revision, and tRPC reports stream failures only as reconnect
//    states, which the CLI ignores; this shows what the stream receives.
const cli = Deno.env.get("METAPLATE_DEPLOY_CLI");
if (!cli) throw new Error("METAPLATE_DEPLOY_CLI must name the Deno Deploy CLI module.");

const args = [...Deno.args];
const half = args.length / 2;
if (half > 0 && Number.isInteger(half) && args.slice(0, half).every((arg, i) => arg === args[half + i])) {
  Object.defineProperty(Deno, "args", { value: args.slice(0, half), configurable: true, enumerable: true });
}

if (Deno.env.get("METAPLATE_DEPLOY_TRACE") === "1") traceRequests();

function traceRequests() {
  const realFetch = globalThis.fetch;
  const started = Date.now();
  const log = (line: string) => console.error(`[trace +${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`);

  // Summarizes one revision update: status, step names, and label keys, never
  // label values. The payload is decoded the way the CLI's own tRPC transformer
  // decodes it.
  function describe(data: string): string {
    try {
      const revision = (0, eval)(`(${JSON.parse(data)})`);
      const steps = (revision?.steps ?? []).map((step: { step?: string; status?: string }) =>
        `${step.step}:${step.status ?? "?"}`
      );
      const labels = Object.keys(revision?.labels ?? {}).join(",");
      // The upload handshake lives under the deno.diffsync labels; print those.
      const diffsync = Object.entries(revision?.labels ?? {})
        .filter(([key]) => key.startsWith("deno.diffsync"))
        .map(([key, value]) => `${key}=${String(value).slice(0, 400)}`);
      return `status=${revision?.status} steps=[${steps.join(",")}] labels=[${labels}] ${diffsync.join(" ")}`;
    } catch (error) {
      return `undecodable (${error})`;
    }
  }

  async function watchEvents(label: string, body: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: ?(.*)$/m.exec(block)?.[1] ?? "message";
          const data = block.split("\n").filter((line) => line.startsWith("data:"))
            .map((line) => line.replace(/^data: ?/, "")).join("\n");
          log(`   ${label} event=${name} bytes=${data.length} ${name === "message" ? describe(data) : ""}`);
        }
      }
      log(`   ${label} stream ended`);
    } catch (error) {
      log(`   ${label} stream failed: ${error}`);
    }
  }

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.hostname.endsWith("deno.com")) return realFetch(input, init);
    const label = `${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url.pathname}`;
    log(`-> ${label}`);
    let response: Response;
    try {
      response = await realFetch(input, init);
    } catch (error) {
      log(`!! ${label} rejected: ${error}`);
      throw error;
    }
    const type = response.headers.get("content-type") ?? "";
    log(`<- ${label} ${response.status} ${type}`);
    if (!type.includes("text/event-stream") || !response.body) return response;
    const [forCli, forTrace] = response.body.tee();
    watchEvents(label, forTrace);
    return new Response(forCli, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

// METAPLATE_DEPLOY_LOGIN=1 signs in and saves the token to the keyring with
// the CLI's own sign-in code, then exits. The CLI has no login command, and
// its `whoami` gives up before showing a sign-in page when nobody is signed in.
if (Deno.env.get("METAPLATE_DEPLOY_LOGIN") === "1") {
  const auth = Deno.env.get("METAPLATE_DEPLOY_AUTH");
  if (!auth) throw new Error("METAPLATE_DEPLOY_AUTH must name the CLI's auth module.");
  const { getAuth, tokenStorage } = await import(auth);
  if (!tokenStorage.get()) {
    await getAuth({ debug: false, endpoint: "https://console.deno.com" });
  }
  console.error("Signed in to Deno Deploy; the sign-in is saved in the system keyring.");
  Deno.exit(0);
}

await import(cli);
