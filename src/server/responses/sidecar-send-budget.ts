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
  let producerActive = false;
  const releaseHop = (): void => {
    const permit = hopPermit;
    hopPermit = undefined;
    if (budget.pendingHopPermit === permit) budget.pendingHopPermit = undefined;
    permit?.release();
  };
  return {
    ownCredentialHop(permit?: SingleUseDispatchPermit): void {
      if (!initial) { permit?.use(); return; } // Preserve direct callers' reporting contract.
      releaseHop();
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
    takeProducerOwnership(): void {
      if (initial) { initial.producerOwned = true; producerActive = true; }
    },
    release(): void {
      initial?.permit.release(); producerActive = false; releaseHop();
    },
    // Iteration collection can finish while runTurn still awaits pacing or beforeDispatch.
    releaseUnsentHop(): void { if (!producerActive) releaseHop(); },
  };
}
