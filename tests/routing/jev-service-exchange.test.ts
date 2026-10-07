import { describe, expect, test } from "bun:test";
import { parseJevDecision, resolveJevDecision, type JevCandidate } from "../../src/combos/jev";
import {
  exchangeJevDecision,
  JEV_API_URL,
  type JevDecisionEndpointShape,
  type JevServiceExchangeOptions,
} from "../../src/combos/jev-service-exchange";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

type Post = NonNullable<JevServiceExchangeOptions["post"]>;
const row: OcxProviderConfig = {
  adapter: "jev-decision", baseUrl: "https://decider.example/v1/systemone/",
  defaultModel: "tev1:4b", apiKey: "fixture-own-key",
};
const config = (name = "decider", provider = row): OcxConfig => ({
  port: 0, defaultProvider: "a", providers: { [name]: provider },
});
const options = (extra: Partial<JevServiceExchangeOptions> = {}): JevServiceExchangeOptions => ({
  config: config(), decisionProvider: "decider", ...extra,
});
const prepare = (endpoint: JevDecisionEndpointShape) => ({ body: JSON.stringify({
  model: endpoint.model, state: { task: "A synthetic question." },
  questions: { test: { type: "choice", criteria: { yes: "Yes", no: "No" } } },
}) });
const parse = (payload: unknown) => payload;
const okPost: Post = async () => Response.json({ answers: { test: { choice: "yes" } } });

// Exercise the seam directly so future question builders cannot bypass the transport contract.
describe("bounded JEV service exchange", () => {
  for (const name of ["jev", "decider"]) {
    test(`${name}: destination denial precedes credential access and request-state extraction`, async () => {
      const seen: string[] = [];
      const provider: OcxProviderConfig = {
        ...row, baseUrl: name === "jev" ? JEV_API_URL : row.baseUrl,
        get apiKey(): string { throw new Error("credential must not be read"); },
      };
      let prepared = false;
      let sends = 0;
      const opts = options({ config: config(name, provider), decisionProvider: name,
        isDestinationAllowed(providerName, model) { seen.push(`${providerName}/${model}`); return false; },
        post: async () => { sends++; return okPost("", row, "", { body: "" }); },
      });
      expect(await exchangeJevDecision(opts, () => { prepared = true; throw new Error("state must not be read"); }, parse))
        .toEqual({ gate: "invalid" });
      expect(prepared).toBe(false);
      expect(seen).toEqual([name === "jev" ? "jev/jev-latest" : "decider/tev1:4b"]);
      expect(sends).toBe(0);

      const body = { get input(): string { throw new Error("state must not be read"); } };
      expect(await resolveJevDecision({ ...opts, body, candidates, fallback }))
        .toMatchObject({ ...fallback, gate: "invalid" });
    });
  }

  test("builders see only model/criteria shape; another question uses the same outbound guard", async () => {
    const shapes: JevDecisionEndpointShape[] = [];
    const result = await exchangeJevDecision(options({ post: async (name, provider, url, init, deps) => {
      expect(name).toBe("decider");
      expect(provider).toBe(row);
      expect(url).toBe("https://decider.example/v1/systemone");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-own-key");
      expect(new Headers(init.headers).get("content-type")).toBe("application/json");
      expect(init.body).toBe(prepare({ model: "tev1:4b", descriptiveCriteria: true }).body);
      expect(deps?.isCanonicalUrl?.(name, url)).toBe(false);
      expect(deps?.isCanonicalUrl?.("jev", JEV_API_URL)).toBe(true);
      expect(deps?.allowLocalCleartextPost).toBe(true);
      return Response.json({ answers: { test: { choice: "yes" } } });
    } }), endpoint => { shapes.push(endpoint); return prepare(endpoint); }, parse);
    expect(shapes).toEqual([{ model: "tev1:4b", descriptiveCriteria: true }]);
    expect(result).toEqual({ value: { answers: { test: { choice: "yes" } } } });
  });

  test("keyless self-hosted requests never borrow canonical environment keys", async () => {
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "fixture-typesafe-key";
    try {
      expect(await exchangeJevDecision(options({ config: config("decider", { ...row, apiKey: undefined }),
        post: async (_name, _provider, _url, init) => {
          expect(new Headers(init.headers).has("authorization")).toBe(false);
          expect(String(init.body)).not.toContain("fixture-typesafe-key");
          return Response.json({});
        },
      }), prepare, parse)).toEqual({ value: {} });
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });

  for (const apiKey of ["$TYPESAFE_API_KEY", "${TYPESAFE_API_KEY}", "$JEV_API_KEY", "${JEV_API_KEY}", "keychain:jev"]) {
    test(`refuses foreign credential reference ${apiKey} before preparation or POST`, async () => {
      expect(await exchangeJevDecision(options({ config: config("decider", { ...row, apiKey }),
        post: async () => { throw new Error("unexpected send"); },
      }), () => { throw new Error("unexpected preparation"); }, parse)).toEqual({ gate: "missing_key" });
    });
  }

  // The 64 KiB caps are pinned as literals, not through the exported constants, so changing a cap fails here.
  test("enforces serialized UTF-8 request byte cap, including its exact boundary", async () => {
    let sends = 0;
    const opts = options({ post: async () => { sends++; return Response.json({}); } });
    const boundary = "é".repeat(32_768); // 2 bytes each: exactly 65_536 bytes
    expect(await exchangeJevDecision(opts, () => ({ body: boundary }), parse)).toEqual({ value: {} });
    expect(await exchangeJevDecision(opts, () => ({ body: `${boundary}x` }), parse)).toEqual({ gate: "invalid" });
    expect(sends).toBe(1);
  });

  test("redirect/HTTP responses are canceled without parsing or retaining upstream detail", async () => {
    for (const [status, gate] of [[302, "redirect"], [307, "redirect"], [402, "http"]] as const) {
      let canceled = false;
      let parsed = false;
      const stream = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
      expect(await exchangeJevDecision(options({ post: async () => new Response(stream, {
        status, headers: { location: "https://other.example/" },
      }) }), prepare, () => { parsed = true; })).toEqual({ gate });
      expect(canceled).toBe(true);
      expect(parsed).toBe(false);
    }
  });

  test("bounds response bytes at 64 KiB and rejects malformed JSON and UTF-8", async () => {
    const boundary = `"${"x".repeat(65_534)}"`; // exactly 65_536 bytes
    expect(new TextEncoder().encode(boundary).byteLength).toBe(65_536);
    expect(await exchangeJevDecision(options({ post: async () => new Response(boundary) }), prepare, parse))
      .toEqual({ value: "x".repeat(65_534) });
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(65_537)); },
      cancel() { canceled = true; },
    });
    expect(await exchangeJevDecision(options({ post: async () => new Response(stream) }), prepare, parse))
      .toEqual({ gate: "malformed" });
    expect(canceled).toBe(true);
    for (const body of ["not-json", new Uint8Array([0x22, 0xc3, 0x28, 0x22])]) {
      expect(await exchangeJevDecision(options({ post: async () => new Response(body) }), prepare, parse))
        .toEqual({ gate: "malformed" });
    }
  });

  test("local preparation and answer validation retain their existing gates", async () => {
    for (const gate of ["no_choices", "no_state", "invalid"] as const) {
      expect(await exchangeJevDecision(options(), () => gate, parse)).toEqual({ gate });
    }
    expect(await exchangeJevDecision(options(), () => { throw new Error("private preparation detail"); }, parse))
      .toEqual({ gate: "invalid" });
    expect(await exchangeJevDecision(options({ post: okPost }), prepare, () => { throw new Error("private parser detail"); }))
      .toEqual({ gate: "invalid" });
    expect(await exchangeJevDecision(options({ post: async () => { throw new TypeError("private network detail"); } }), prepare, parse))
      .toEqual({ gate: "network" });
  });

  test("route parser still refuses malformed probabilities through the shared exchange", async () => {
    for (const probabilities of [null, { "a/m1:low": 1 }, { "a/m1:low": 0.4, "a/m2:low": 0.2 },
      { "a/m1:low": 0.2, "a/m2:low": 0.8 }, { "a/m1:low": -0.1, "a/m2:low": 1.1 }]) {
      const payload = { answers: { route: { choice: "a/m1:low", probabilities } } };
      expect(await exchangeJevDecision(options({ post: async () => Response.json(payload) }), prepare,
        answer => parseJevDecision(answer, candidates))).toEqual({ gate: "invalid" });
    }
  });

  test("caller cancellation wins by identity when already aborted, after POST, during read and parsing", async () => {
    const reason = { caller: "stopped" };
    for (const phase of ["pre", "post", "read", "parse"] as const) {
      const caller = new AbortController();
      if (phase === "pre") caller.abort(reason);
      let canceled = false;
      const post: Post = async () => {
        if (phase === "post") caller.abort(reason);
        if (phase === "read") return new Response(new ReadableStream<Uint8Array>({
          pull() { caller.abort(reason); }, cancel() { canceled = true; },
        }, { highWaterMark: 0 }));
        return Response.json({});
      };
      await expect(exchangeJevDecision(options({ signal: caller.signal, post }), prepare, payload => {
        if (phase === "parse") caller.abort(reason);
        return payload;
      })).rejects.toBe(reason);
      if (phase === "read") expect(canceled).toBe(true);
    }
  });

  test("caller abort reaches the in-flight POST signal and settles long before the deadline", async () => {
    const caller = new AbortController();
    const reason = { caller: "stopped in flight" };
    const release = new AbortController(); // lets a regressed build unwind instead of leaking a pending POST
    let posted: AbortSignal | undefined;
    let started!: () => void;
    const postStarted = new Promise<void>(resolve => { started = resolve; });
    const post: Post = (_name, _provider, _url, init) => {
      posted = init.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        release.signal.addEventListener("abort", () => reject(new Error("test released")), { once: true });
        started();
      });
    };
    const startedAt = performance.now();
    const pending = exchangeJevDecision(options({ signal: caller.signal, timeoutMs: 120_000, post }), prepare, parse);
    await postStarted;
    expect(posted?.aborted).toBe(false);
    caller.abort(reason);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(() => "resolved", error => (error === reason ? "reason" : "other")),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("still pending"), 1_000); }),
    ]);
    clearTimeout(timer);
    release.abort();
    await pending.catch(() => undefined);
    expect(outcome).toBe("reason");
    expect(posted?.aborted).toBe(true);
    expect(posted?.reason).toBe(reason);
    expect(performance.now() - startedAt).toBeLessThan(1_000); // the configured deadline is 120_000 ms
  });

  test("deadline normalization and expiry apply to both POST and body read", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")!;
    const deadlines: number[] = [];
    let deadline = new AbortController();
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value(ms: number) {
      deadlines.push(ms); return deadline.signal;
    } });
    try {
      for (const timeoutMs of [undefined, 999, 1_000, 120_000, 120_001, 1_500.5]) {
        expect(await exchangeJevDecision(options({ timeoutMs, post: okPost }), prepare, parse)).toHaveProperty("value");
      }
      expect(deadlines).toEqual([4_000, 4_000, 1_000, 120_000, 4_000, 4_000]);
      const reason = new DOMException("deadline", "TimeoutError");
      expect(await exchangeJevDecision(options({ post: async () => { deadline.abort(reason); throw reason; } }), prepare, parse))
        .toEqual({ gate: "timeout" });
      deadline = new AbortController();
      let canceled = false;
      expect(await exchangeJevDecision(options({ post: async () => new Response(new ReadableStream<Uint8Array>({
        pull() { deadline.abort(reason); }, cancel() { canceled = true; },
      }, { highWaterMark: 0 })) }), prepare, parse)).toEqual({ gate: "timeout" });
      expect(canceled).toBe(true);
    } finally { Object.defineProperty(AbortSignal, "timeout", descriptor); }
  });
});

const candidates: JevCandidate[] = [
  { key: "a/m1", provider: "a", model: "m1", reasoningEfforts: ["low"] },
  { key: "a/m2", provider: "a", model: "m2", reasoningEfforts: ["low"] },
];
const fallback = { targetKey: "a/m1", effort: "low" as const };
