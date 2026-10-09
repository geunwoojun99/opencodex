/** Credential owner publishes only loaded, secret-free pool eligibility generations. */
import { publishDecisionQuotaRoster } from "../providers/quota-decision-snapshot";
import type { CodexAccountCredentialRecord } from "../types";
/** Publish the secret-free Codex pool roster (id, credential generation, usability) that advisory decision evidence is bound to. */
export function publishCodexDecisionQuotaRoster(store: Record<string, CodexAccountCredentialRecord>): void {
  publishDecisionQuotaRoster("codex", Object.entries(store).map(([id, row]) => ({
    id, generation: row.generation,
    usable: !!row.credential && row.deletedAt == null && !row.codexValidationPending && !row.lastCodexValidationTerminal,
  })));
}
