export type SlackRouteKey = 'jamie_group' | 'aa_group' | 'project' | 'interviewer' |
  'interviewer_rishi' | 'interviewer_rithika' | 'interviewer_aa' | 'interviewer_santosh';
export type SlackMessageKind = 'interview.feedback_request' | 'interview.feedback_reminder' |
  'takehome.grading_request' | 'takehome.grading_reminder' | 'rejection.confirmation_request' | 'onboarding.jamie' |
  'onboarding.aa' | 'onboarding.address_update' | 'onboarding.ready_notice' |
  'offboarding.reminder' | 'offboarding.cancellation' | 'failure.project' | 'payment.project' | 'interview.next_step_request' | 'next_step.project' | 'email.deep_dive_pending';
export interface DispatchRequest {
  requestKey: string; candidateId: string; occurrenceId: string; action: SlackMessageKind;
  recipientIds: string[]; state: string; isFixture: boolean; triggerAt: number;
  payload: Record<string, unknown> & { routeKey: SlackRouteKey; candidate: {
    pageId: string; fullName: string; email: string; emailVerified: true; url: string;
  } };
}
export interface PreparedAuthorization {
  verified: true; sourceLinksVerified: true; holdsChecked: true; priorDeliveryChecked: true;
  checkedAt: number; expiresAt: number; sourceEventIds: string[];
  scope: { requestKey: string; candidateId: string; candidateEmail: string; occurrenceId: string;
    action: SlackMessageKind; recipientIds: string[]; messageText: string };
}
export interface ThreadInput { requestKey: string; candidateId: string; routeKey: SlackRouteKey; channelId: string }
export interface ThreadBinding { verified: true; candidateId: string; routeKey: SlackRouteKey;
  channelId: string; threadTs: string | null; ownerRequestKey: string }
export interface SlackDispatchResult {
  status: 'sent' | 'simulated' | 'blocked' | 'uncertain'; reason?: string;
  /** null means an attempted delivery was not verified; never treat it as unsent. */
  delivered?: boolean | null; locked?: boolean; requestKey?: string; receipt?: Record<string, unknown>;
}
export const SLACK_MESSAGE_KINDS: readonly SlackMessageKind[];
export function renderSlackMessage(request: DispatchRequest): string;
/** Server dependencies must derive authority from current evidence, never MCP-supplied flags. */
export function createSlackDispatcher(config: {
  env: Record<string, unknown>; store: unknown;
  routes: Partial<Record<SlackRouteKey, { channelId: string; type: 'im' | 'mpim' }>>;
  authorizePreparedAction: (input: { request: DispatchRequest; messageText: string;
    phase: 'prepare' | 'before_send' }) => Promise<PreparedAuthorization | null>;
  readControl: () => Promise<{ verified: true; readAt: number; mode: 'Off' | 'Test' | 'Live';
    baselineComplete: boolean; activatedAt: number | null }>;
  /** Must atomically reserve first-thread ownership, or return an existing verified binding. */
  getCandidateThread: (input: ThreadInput) => Promise<ThreadBinding | null>;
  /** Must persist and read back the thread via compare-and-set; retain uncertain reservations. */
  saveCandidateThread: (input: ThreadInput & { verified: true; ownerRequestKey: string; previousThreadTs: string | null;
    threadTs: string; messageTs: string }) => Promise<{ verified: true; threadTs: string }>;
  fetchImpl?: typeof fetch; clock?: () => number;
}): (input: { requestKey: string; claimToken: string }) => Promise<SlackDispatchResult>;
