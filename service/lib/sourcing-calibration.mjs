/** Manually approved examples are role-scoped and kept apart from model-rewritten taste/history. */
const clean = (v, n = 500) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export const calibrationKey = role => `sourcing:calibration:${role}`;
export async function readSourcingCalibration(kv, role) {
  if (!role || !/^[a-z0-9-]{1,60}$/.test(role)) return null;
  const value = await kv.get(calibrationKey(role));
  if (!value) return null;
  if (value.role !== role || value.version !== 1 || !Array.isArray(value.examples) || !Array.isArray(value.criteria)) throw new Error('sourcing_calibration_invalid');
  return value;
}
export function calibrationText(calibration) {
  if (!calibration) return '(none)';
  return `Project's explicit calibration (${clean(calibration.updatedAt, 40)}), for this role only. These are positive fit examples, not outreach instructions or hiring decisions. Newer explicit criteria take precedence over conflicting inferred taste. Preserve the active brief's location and explicit sourcing exclusions. Do not infer a trait shared by all examples when it is only evidenced for one.\nCriteria:\n${calibration.criteria.slice(0, 12).map(x => `- ${clean(x, 650)}`).join('\n')}\nExamples:\n${calibration.examples.slice(0, 12).map(x => `- ${clean(x.name, 100)} (${clean(x.linkedin, 180)}): ${clean(x.evidence, 1000)} [${clean(x.basis, 180)}]`).join('\n')}`;
}
/** Keep profile evidence before ranking, instead of discarding job descriptions in favour of titles. */
export function leadEvidence(lead) {
  return [lead.title, lead.company, lead.headline, ...(lead.workEvidence ?? []), ...(lead.past ?? [])].filter(x => typeof x === 'string').map(x => clean(x, 1500)).join(' | ');
}
const folded = text => clean(text, 15000).toLowerCase();
const ROLE_WORK = /\b(?:synthetic (?:data|trajector\w*)|synth(?:etic)? pipelines?|task[- ](?:gen\w*|design\w*)|(?:rl|reinforcement learning) (?:environments?|gyms?|infra\w*|training)|post[- ]training|verifiers?|verifiable rewards?|grading harness\w*|(?:llm|model|agent|capability)\w*.{0,35}(?:eval\w*|benchmark\w*)|(?:eval\w*|benchmark\w*).{0,35}(?:llm|model|agent|capability)\w*|fine[- ]tun\w*|finetun\w*|distillation|sft|rlhf|dpo)\b/i;
/** Validate the model's cited source text; a company, title or model-generated reason alone is not fit evidence. */
export function verifiedFitEvidence(lead, pick, calibration) {
  if (!calibration?.requireEvidence) return true;
  const quote = clean(pick?.evidence, 1000);
  if (/\b(?:no|not|never|unverified|unknown)\b/i.test(quote)) return false;
  if (quote.length < 20 || !folded(leadEvidence(lead)).includes(folded(quote))) return false;
  if (calibration.role === 'rl-coding-environments' && !ROLE_WORK.test(quote)) return false;
  if (calibration.indiaOnly && !/\b(?:india|bengaluru|bangalore|hyderabad|pune|mumbai|delhi|gurugram|gurgaon|noida|chennai|kolkata|ahmedabad|kochi|thiruvananthapuram)\b/i.test(lead.location ?? '')) return false;
  return true;
}
