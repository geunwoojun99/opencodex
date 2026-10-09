/** Auth owner projects a loaded store; JEV never imports the auth-store reader. */
import { createHash } from "node:crypto";
import { publishDecisionQuotaRoster } from "../providers/quota-decision-snapshot";
import type { AuthStore } from "./store";
/** Publish the secret-free Anthropic pool roster; the generation is a one-way digest of the credential, never the credential itself. */
export function publishAuthDecisionQuotaRoster(store: AuthStore): void {
  publishDecisionQuotaRoster("anthropic", (store.anthropic?.accounts ?? []).map(row => ({
    id: row.id,
    generation: createHash("sha256").update(JSON.stringify([row.credential.refresh, row.credential.access, row.credential.expires])).digest("hex"),
    usable: row.paused !== true && row.needsReauth !== true && Boolean(row.credential.access || row.credential.refresh),
  })));
}
