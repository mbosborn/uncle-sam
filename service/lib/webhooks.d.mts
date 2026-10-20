export interface WebhookDeps {
 secret?: string; store: unknown; schedule?: (promise: Promise<unknown>) => void;
 run?: (input: { eventId: string; attemptId: string }) => Promise<unknown>; log?: (line: string) => void;
}
export function handleNotionWebhook(request: Request, deps: WebhookDeps): Promise<Response>;
export function handlePortalWebhook(request: Request, deps: WebhookDeps): Promise<Response>;
