export const REJECTION_SENDER: 'existing_rejection_agent';
type Adapter = (args: Record<string, unknown> & { signal: AbortSignal }) => Promise<unknown>;
export type RejectionHandoffDependencies = {
  env?: { UNCLE_SAM_AUTOMATIC_ACTIVITY?: string };
  resolveEvidence: Adapter; readControls: Adapter; readCandidate: Adapter;
  claim: Adapter; authorizeClaim: Adapter; appendEvidence: Adapter; readEvidence: Adapter;
  patchCandidate: Adapter; readSenderReceipt: Adapter; finishClaim: Adapter; markUncertain: Adapter;
  clock?: () => number; timeoutMs?: number;
};
export type RejectionHandoffInput = { eventId: string; attemptId: string; dryRun?: boolean };
export function createRejectionHandoff(dependencies: RejectionHandoffDependencies): Readonly<{
  handoff(input: RejectionHandoffInput): Promise<Record<string, unknown>>;
  hold(input: RejectionHandoffInput): Promise<Record<string, unknown>>;
}>;
