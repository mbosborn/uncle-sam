export function createSlackIngress(config: {
 env: Record<string, unknown>; store: unknown; signatureConfig: Record<string, unknown>;
 schedule: (promise: Promise<unknown>) => void;
 wakeFactory?: (deps: { env: Record<string, unknown>; store: unknown }) => (input: { eventId: string; attemptId: string }) => Promise<unknown>;
}): (request: Request) => Promise<Response>;
