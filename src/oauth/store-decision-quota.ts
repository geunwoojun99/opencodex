/** Auth owner projects a loaded store; JEV never imports the auth-store reader. */
import { createHash } from "node:crypto";
import { publishDecisionQuotaRoster } from "../providers/quota-decision-snapshot";
import type { AuthStore } from "./store";
export function publishAuthDecisionQuotaRoster(store: AuthStore): void {
  publishDecisionQuotaRoster("anthropic", (store.anthropic?.accounts ?? []).map(row => ({
    id: row.id,
    generation: createHash("sha256").update(JSON.stringify([row.credential.refresh, row.credential.access, row.credential.expires])).digest("hex"),
    usable: row.paused !== true && row.needsReauth !== true && Boolean(row.credential.access || row.credential.refresh),
  })));
}
