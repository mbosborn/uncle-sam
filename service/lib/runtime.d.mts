export type RouteMap = Record<string, { channelId: string; type: 'im' | 'mpim' }>;
export interface RunnerHandle {
 runEvent(input: { eventId: string; attemptId: string; deadline?: number }): Promise<Record<string, unknown>>;
 runTick(input?: { now?: number; deadline?: number }): Promise<Record<string, unknown>>;
}
export interface Runtime { store: unknown; runner: RunnerHandle; routeMap: RouteMap; }
export function parseRouteMap(json: unknown): RouteMap;
export function routesFromMap(map: RouteMap): Record<string, string[]>;
export function parseInterviewerEmails(json: unknown): Record<string, string>;
export function llmRouteOf(env: Record<string, unknown>): 'anthropic' | 'openrouter' | 'none';
export function llmSettingsOf(env: Record<string, unknown>): { route: 'anthropic' | 'openrouter'; apiKey: string; model?: string } | null;
export function describeConfiguration(env: Record<string, unknown>): Record<string, unknown>;
export function createRuntime(env: Record<string, unknown>, options?: { fetchImpl?: typeof fetch; clock?: () => number }): Runtime;
export function runScheduled(env: Record<string, unknown>, controller?: { scheduledTime?: number; cron?: string }, options?: { log?: (line: string) => void; fetchImpl?: typeof fetch; clock?: () => number; deadline?: number }): Promise<Record<string, unknown>>;
