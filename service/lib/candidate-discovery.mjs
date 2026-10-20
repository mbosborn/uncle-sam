/**
 * Read-only identity questions. Search the recruiting record's identifying evidence, including closed records.
 * Every retained clue must match one candidate. Calendar proximity and model guesses cannot select a person.
 * No workflow proposal, candidate write, contact enrichment, or outbound candidate message is available here.
 */
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f<>|]/g, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set(`a an the who whom whose what which was were is are am be been being do did does we i you he she they it his her their them us our my your that this those these from at of for to in on with and or but then had has have having can could would should will please hey hi uncle sam me again find found look looking looked up lookup identify remember remind name named names person people guy man woman lady candidate candidates someone anyone somebody one send show give get open reopen profile linkedin link url about before after ago supposed`.split(' '));
const normalize = text => clean(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/strategic\s+projects?\s+leads?/g, 'spl').replace(/strategic\s+projects?\s+associates?/g, 'spa')
  .replace(/[’']s\b/g, '').replace(/machine[\s-]+learning\s+engineers?/g, 'mle').replace(/re[\s-]+schedul/g, 'reschedul');
const stem = word => /^interview/.test(word) ? 'interview' : /^(?:reschedul|postpon)/.test(word) ? 'reschedul'
  : /^cancel/.test(word) ? 'cancel' : /^(?:engineer|engineering)$/.test(word) ? 'engineer' : word;

export function isCandidateDiscoveryQuestion(text) {
  const t = clean(String(text ?? '').replace(/<@[A-Z0-9]+>/g, ' '));
  if (/^(?:please\s+)?(?:reject|withdraw|mark|move|schedule|reschedule|cancel|send|resend|hold|hire)\b/i.test(t)
      && !/\blinkedin\b/i.test(t)) return false;
  if (/\b(?:and|then)\s+(?:reject|withdraw|mark|move|send|resend|hire)\b/i.test(t)) return false;
  if (/\blinkedin\b/i.test(t) && /\b(?:who|which|find|show|give|get|open|look|profile|link|url)\b/i.test(t)) return true;
  if (/\bwho (?:is|are) in (?:round|stage|trial|the pipeline)\b/i.test(t)) return false;
  if (/^who(?:'s| is| was| are| were)\s+(?:booked|scheduled|interviewing|handling|responsible|assigned|available|free|busy)\b/i.test(t)) return false;
  return /\bwho (?:was|is|were|from)\b|\bwhich (?:candidate|person|guy|man|woman)\b|\b(?:what|remember).{0,35}\bname\b|\bfind (?:the|that|a) (?:candidate|person|guy)\b/i.test(t);
}

/** Literal clues only, with a few established role abbreviations and scheduling inflections. Unknown wording narrows, never broadens. */
export function discoveryTerms(question) {
  return [...new Set((normalize(question).match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => !STOP.has(w)).map(stem))];
}

export function discoveryAlternatives(term) {
  return term === 'spl' ? ['spl', 'strategic project'] : term === 'spa' ? ['spa', 'strategic project']
    : term === 'mle' ? ['mle', 'machine learning'] : term === 'reschedul' ? ['reschedul', 'postpon'] : [term];
}

export function candidateEvidence(candidate) {
  const f = candidate?.fields ?? {}, p = candidate?.profile ?? {};
  return [candidate?.fullName, p.from, f.Role, f.Category, f.Track, f['Candidate brief'], f['Next action'],
    p.categoryBasis, p.reviewNote].filter(v => typeof v === 'string' && v.trim()).map(clean);
}

function matchingTerms(text) {
  // Negative/uncertain evidence cannot prove an identity clue. A positive sentence elsewhere can still match.
  return normalize(text).split(/[.!?;\n]|\bbut\b/).filter(s => !/\b(?:not|never|no|unknown|unconfirmed|unclear|maybe|possibly|unverified)\b|can.?t confirm|cannot confirm/.test(s))
    .flatMap(s => (s.match(/[\p{L}\p{N}]+/gu) ?? []).map(stem));
}
export function matchesDiscovery(candidate, terms) {
  if (!candidate || candidate.archived || candidate.inRecruitingSource === false || /^\[(?:TEST|FIXTURE)\]/i.test(candidate.fullName ?? '')) return false;
  const evidence = new Set(candidateEvidence(candidate).flatMap(matchingTerms));
  return terms.length > 0 && terms.every(t => evidence.has(t));
}

/** The caller supplies trusted link construction shared with ordinary Q&A. */
export async function answerCandidateDiscovery({ question, notion, entryOf }) {
  const terms = discoveryTerms(question);
  const result = (replyKind, reason, parts, extra = {}) => ({ replyKind, reason, text: parts.map(p => p.text ?? p.link.label).join(''), parts, ...extra });
  const plain = (kind, reason, text) => result(kind, reason, [{ text }]);
  if (!terms.length || terms.length > 12 || terms.some(t => /^(?:not|never|except|without)$/.test(t))) {
    return plain('clarified', 'discovery_clues', '📋 Give me a name, company, role, or a detail from their interview so I can find the right profile.');
  }
  if (typeof notion.searchCandidateEvidence !== 'function') throw new Error('candidate_discovery_unavailable');
  const found = await notion.searchCandidateEvidence({ terms, alternatives: terms.map(discoveryAlternatives) });
  if (found.truncated) return plain('clarified', 'discovery_incomplete', '📋 That search has more results than I could check. Add a company, name, or interview detail to narrow it down.');
  const matches = found.candidates.filter(c => matchesDiscovery(c, terms));
  if (!matches.length) return plain('no_match', 'discovery_no_verified_match', "📋 I couldn't verify a candidate matching all those clues in the recruiting records. Do you remember another detail?");
  if (matches.length > 1) {
    const parts = [{ text: '📋 More than one candidate matches those clues: ' }];
    for (const [i, c] of matches.slice(0, 4).entries()) {
      if (i) parts.push({ text: ', ' });
      const e = entryOf(c);
      parts.push(e.link ? { link: { url: e.link.url, label: e.name } } : { text: e.name });
    }
    parts.push({ text: `${matches.length > 4 ? ' and others' : ''}. Which one did you mean?` });
    // Do not enroll this in the status/action follow-up path: this is an identity lookup only.
    return result('clarified', 'discovery_ambiguous', parts);
  }
  const candidate = await notion.getCandidate(matches[0].pageId);
  if (!matchesDiscovery(candidate, terms)) return plain('no_match', 'discovery_changed', '📋 The record changed while I was checking it, so I cannot confirm a match from those clues.');
  const e = entryOf(candidate);
  const parts = [{ text: '🎖️ ' }, e.link ? { link: { url: e.link.url, label: e.name } } : { text: e.name }];
  // Identity-only: do not quote private notes, pay, verdicts, or stale next actions into Slack.
  parts.push({ text: '. Their recruiting record matches those identifying details.' });
  return result('answered', 'candidate_discovery', parts, { candidatePageId: candidate.pageId });
}
