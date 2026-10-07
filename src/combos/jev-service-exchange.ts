import { readBoundedResponseBytes } from "../lib/bounded-body";
import {
  providerOutboundPost,
  providerRedirectError,
} from "../lib/provider-outbound";
import {
  isKeychainReference,
  keychainReferenceBelongsToProvider,
  resolveProviderApiKey,
} from "../providers/api-key-resolve";
import { providerMatchesRegistryTransport } from "../providers/registry";
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { JevDecision, ResolveJevDecisionOptions } from "./jev";
import {
  isSystemOneEndpoint,
  JEV_DECISION_TIMEOUT_DEFAULT_MS,
  JEV_DECISION_TIMEOUT_MAX_MS,
  JEV_DECISION_TIMEOUT_MIN_MS,
} from "./jev-decision-contract";

export const JEV_PROVIDER_ID = "jev";
export const JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

/** Environment names that hold TypeSafe credentials; a self-hosted row may never reference them. */
const TYPESAFE_ENV_KEYS = new Set(["TYPESAFE_API_KEY", "JEV_API_KEY"]);
export const JEV_MAX_REQUEST_BYTES = 65_536;
export const JEV_MAX_RESPONSE_BYTES = 65_536;
const JEV_OUTBOUND_DEPENDENCIES = {
  isCanonicalUrl: (name: string, url: string) => name === JEV_PROVIDER_ID && url === JEV_API_URL,
  // Self-hosted decision models (Ollama tev1) listen on plain HTTP loopback. The outbound wrapper
  // still requires the row's own allowPrivateNetwork and a literal local address for that.
  allowLocalCleartextPost: true,
};

export type JevDecisionFailureGate = Exclude<JevDecision["gate"], "apply">;

export type JevServiceExchangeOptions = Pick<ResolveJevDecisionOptions,
  "config" | "decisionProvider" | "isDestinationAllowed" | "timeoutMs" | "signal" | "post">;

/** Request shape only: question builders never receive the destination or credential. */
export interface JevDecisionEndpointShape {
  model: string;
  descriptiveCriteria: boolean;
}

/** The decision deadline: the configured value when in bounds, otherwise the four-second default. */
export function jevDecisionTimeoutMs(value: number | undefined): number {
  return value !== undefined
    && Number.isInteger(value)
    && value >= JEV_DECISION_TIMEOUT_MIN_MS
    && value <= JEV_DECISION_TIMEOUT_MAX_MS
    ? value
    : JEV_DECISION_TIMEOUT_DEFAULT_MS;
}

function canonicalJevProvider(config: OcxConfig): OcxProviderConfig {
  const configured = config.providers[JEV_PROVIDER_ID];
  if (configured && providerMatchesRegistryTransport(JEV_PROVIDER_ID, configured)) return configured;
  return {
    adapter: "jev-decision",
    baseUrl: JEV_API_URL,
    authMode: "key",
    liveModels: false,
  };
}

interface JevDecisionEndpoint {
  name: string;
  provider: OcxProviderConfig;
  url: string;
  model: string;
  apiKey: string | undefined;
  /** Self-hosted System One services accept only string option descriptions. */
  descriptiveCriteria: boolean;
}

function envReferenceName(value: string): string | undefined {
  const braced = /^\$\{(\w+)\}$/.exec(value);
  if (braced) return braced[1];
  return value.startsWith("$") ? value.slice(1) : undefined;
}

/**
 * A self-hosted row may carry only its own secret: never a reference to the TypeSafe environment
 * keys, and never a keychain entry that belongs to another provider. `null` means refused.
 */
function selfHostedApiKey(name: string, apiKey: string | undefined): string | undefined | null {
  if (!apiKey) return undefined;
  const envName = envReferenceName(apiKey);
  if (envName !== undefined && TYPESAFE_ENV_KEYS.has(envName)) return null;
  if (isKeychainReference(apiKey) && !keychainReferenceBelongsToProvider(apiKey, name)) return null;
  return resolveProviderApiKey(apiKey)?.trim() || undefined;
}

/**
 * Resolve where one decision request goes and which credential it may carry.
 *
 * The `jev` id stays pinned to the canonical TypeSafe URL and `jev-latest`: its row key is used
 * only while the row still matches the registry transport, and the environment fallbacks exist
 * only for that URL. A retargeted `jev` row therefore keeps today's behavior instead of becoming a
 * custom destination. Any other id must be an enabled `jev-decision` row whose baseUrl is a
 * `/systemone` endpoint and which names its own model; only its own key may accompany it, so no
 * TypeSafe credential can reach a self-hosted service. `undefined` means no usable decision
 * service (reported through the existing `missing_key` gate); `null` means the request's
 * destination scope refused it before any credential access.
 */
function jevDecisionEndpoint(
  config: OcxConfig,
  decisionProvider: string,
  isDestinationAllowed?: ResolveJevDecisionOptions["isDestinationAllowed"],
): JevDecisionEndpoint | undefined | null {
  const configured = Object.hasOwn(config.providers, decisionProvider)
    ? config.providers[decisionProvider]
    : undefined;
  if (configured?.disabled === true) return undefined;
  if (decisionProvider === JEV_PROVIDER_ID) {
    if (isDestinationAllowed?.(JEV_PROVIDER_ID, JEV_MODEL) === false) return null;
    const configuredOwnsJev = configured
      && providerMatchesRegistryTransport(JEV_PROVIDER_ID, configured);
    const apiKey = (
      configuredOwnsJev ? resolveProviderApiKey(configured.apiKey)?.trim() : undefined
    ) || process.env.TYPESAFE_API_KEY?.trim()
      || process.env.JEV_API_KEY?.trim();
    if (!apiKey) return undefined;
    return {
      name: JEV_PROVIDER_ID,
      provider: canonicalJevProvider(config),
      url: JEV_API_URL,
      model: JEV_MODEL,
      apiKey,
      descriptiveCriteria: false,
    };
  }
  if (configured?.adapter !== "jev-decision" || typeof configured.baseUrl !== "string") return undefined;
  const url = configured.baseUrl.trim().replace(/\/+$/, "");
  if (!url || !isSystemOneEndpoint(url)) return undefined;
  // `jev-latest` is TypeSafe's model name; a self-hosted host must name its own.
  const model = configured.defaultModel?.trim() || configured.models?.[0]?.trim();
  if (!model) return undefined;
  if (isDestinationAllowed?.(decisionProvider, model) === false) return null;
  const apiKey = selfHostedApiKey(decisionProvider, configured.apiKey);
  if (apiKey === null) return undefined;
  return {
    name: decisionProvider,
    provider: configured,
    url,
    model,
    apiKey,
    descriptiveCriteria: true,
  };
}

/**
 * One bounded System One round-trip, independent of the decision question and its choice policy.
 * Destination authorization precedes credential access and `prepare`; request bytes, deadline,
 * redirects and UTF-8 JSON are bounded here. `parse` validates the question's answer inside the
 * cancellation boundary. Local preparation/parser failures are `invalid`; caller aborts retain
 * their reason by identity rather than becoming a fail-open gate.
 */
export async function exchangeJevDecision<T>(
  options: JevServiceExchangeOptions,
  prepare: (endpoint: JevDecisionEndpointShape) => { body: string } | JevDecisionFailureGate,
  parse: (payload: unknown) => T,
): Promise<{ value: T } | { gate: JevDecisionFailureGate }> {
  const endpoint = jevDecisionEndpoint(options.config, options.decisionProvider ?? JEV_PROVIDER_ID, options.isDestinationAllowed);
  if (endpoint === null) return { gate: "invalid" };
  if (!endpoint) return { gate: "missing_key" };

  let requestBody: string;
  try {
    const prepared = prepare({ model: endpoint.model, descriptiveCriteria: endpoint.descriptiveCriteria });
    if (typeof prepared === "string") return { gate: prepared };
    requestBody = prepared.body;
    if (new TextEncoder().encode(requestBody).byteLength > JEV_MAX_REQUEST_BYTES) return { gate: "invalid" };
  } catch {
    return { gate: "invalid" };
  }

  const timeoutMs = jevDecisionTimeoutMs(options.timeoutMs);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;
  const post = options.post ?? providerOutboundPost;

  try {
    const response = await post(
      endpoint.name,
      endpoint.provider,
      endpoint.url,
      {
        headers: {
          ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
          "Content-Type": "application/json",
        },
        body: requestBody,
        signal,
      },
      JEV_OUTBOUND_DEPENDENCIES,
    );
    if (options.signal?.aborted) throw options.signal.reason;

    const redirectError = await providerRedirectError(response, endpoint.url);
    if (redirectError) return { gate: "redirect" };
    if (!response.ok) {
      try { void response.body?.cancel().catch(() => undefined); } catch { /* best effort */ }
      return { gate: "http" };
    }

    const bounded = await readBoundedResponseBytes(response, {
      maxBytes: JEV_MAX_RESPONSE_BYTES,
      signal,
    });
    if (options.signal?.aborted) throw options.signal.reason;
    if (bounded.oversized) return { gate: "malformed" };

    let payload: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes);
      payload = JSON.parse(text);
    } catch {
      return { gate: "malformed" };
    }

    let parsed: T;
    try {
      parsed = parse(payload);
    } catch {
      return { gate: "invalid" };
    }
    if (options.signal?.aborted) throw options.signal.reason;
    return { value: parsed };
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (timeoutSignal.aborted
      || (error instanceof DOMException && error.name === "TimeoutError")) {
      return { gate: "timeout" };
    }
    return { gate: "network" };
  }
}
