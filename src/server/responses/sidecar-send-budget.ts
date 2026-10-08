import type { IncomingMeta, ProviderAdapter } from "../../adapters/base";
import type { HandleResponsesOptions } from "./core-options";
import type { ResponsesSendBudget } from "./request-send-budget";
import type { ProviderFetchOptions } from "./fetch-helpers";
import type { SingleUseDispatchPermit } from "../../lib/request-execution-budget";

/** Hosted inference consumes the same child-owned booking as ordinary dispatch. */
export function createSidecarSendBudget(
  options: HandleResponsesOptions,
  budget: Pick<ResponsesSendBudget, "adapterDispatchBudget" | "noteInitialDispatch" | "noteAdapterPhysicalSend" | "noteAdapterRecoveryWithheld" | "pendingHopPermit">,
  inputTokens: () => number | undefined,
) {
  const initial = options.comboInitialSend;
  let hopPermit: SingleUseDispatchPermit | undefined;
  return {
    ownCredentialHop(permit?: SingleUseDispatchPermit): void {
      if (!initial) { permit?.use(); return; } // Preserve direct callers' reporting contract.
      hopPermit?.release();
      hopPermit = permit;
      budget.pendingHopPermit = permit;
    },
    // Adapter-owned transports settle through the live dispatch view, not an HTTP receipt too.
    incomingMeta: initial ? {
      comboAttempt: options.comboAttempt === true,
      sendBudget: budget.adapterDispatchBudget,
      onPhysicalSend: send => budget.noteAdapterPhysicalSend(inputTokens(), send),
      onRecoveryWithheld: budget.noteAdapterRecoveryWithheld,
    } satisfies Partial<IncomingMeta> : {},
    fetchOptions(adapter: ProviderAdapter): Pick<ProviderFetchOptions, "onPhysicalDispatch"> {
      return initial && !adapter.fetchResponse && !adapter.runTurn
        ? { onPhysicalDispatch: () => {
          const prepaid = budget.pendingHopPermit;
          budget.pendingHopPermit = undefined;
          budget.noteInitialDispatch(prepaid);
        } } : {};
    },
    takeProducerOwnership(): void { if (initial) initial.producerOwned = true; },
    release(): void { initial?.permit.release(); hopPermit?.release(); },
    releaseUnsentHop(): void { hopPermit?.release(); },
  };
}
