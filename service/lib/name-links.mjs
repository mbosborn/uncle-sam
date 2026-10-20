/**
 * Putting a candidate's LinkedIn on their name (Project, 2026-10-15: "hyperlink their names to the LinkedIn URL when he says
 * the candidate's name"). The only link built here is a canonical LinkedIn profile (https://www.linkedin.com/in/<slug>),
 * rebuilt from the tracker's LinkedIn field; anything else leaves the plain name. The message's own text never changes
 * (it is what Slack keeps as the fallback and what the receipts check); only the displayed block carries the link.
 */
const LINKEDIN_HOST = /^(?:[a-z]{1,3}\.)?linkedin\.com$/;
const LINKEDIN_SLUG = /^(?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2})+$/;
export const CANONICAL_LINKEDIN = /^https:\/\/www\.linkedin\.com\/in\/(?:[A-Za-z0-9_-]|%[0-9A-Fa-f]{2}){3,100}$/;

/**
 * A LinkedIn profile rebuilt in one canonical form (https://www.linkedin.com/in/<slug>), or null unless the field holds a
 * well-formed /in/ profile. A missing scheme, http, a country subdomain, a trailing slash, a query or a fragment are fine;
 * another host, credentials, a port, a company page or a slug cut off with a dangling hyphen are not (spec E-D12).
 */
export function linkedinProfileUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 300 || /\s/u.test(text)) return null;
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !LINKEDIN_HOST.test(url.hostname)) return null;
  const [, section, slug = ''] = url.pathname.split('/');
  if (section !== 'in' || slug.length < 3 || slug.length > 100 || !LINKEDIN_SLUG.test(slug) || slug.startsWith('-') || slug.endsWith('-')) return null;
  return `https://www.linkedin.com/in/${slug}`;
}

/** The canonical LinkedIn for a value already canonical (a stored payload), or null. */
export const trustedLinkedin = url => (typeof url === 'string' && CANONICAL_LINKEDIN.test(url) ? url : null);

/** Links for read-only answers: LinkedIn first, then a URL built from a verified recruiting page id. */
export function candidateLinkParts(text, candidates = []) {
  const byName = new Map();
  for (const c of candidates) {
    if (!c || c.archived || c.inRecruitingSource === false) continue;
    const name = String(c.fullName ?? '').replace(/\s*⭐\s*$/u, '').trim();
    const id = String(c.pageId ?? '').replaceAll('-', '');
    const url = linkedinProfileUrl(c.profile?.linkedin) ?? (/^[a-f0-9]{32}$/i.test(id) ? `https://www.notion.so/${id.toLowerCase()}` : null);
    if (!url || name.length < 2 || name.length > 120 || /[<>|\u0000-\u001f]/.test(name)) continue;
    if (!byName.has(name)) byName.set(name, url);
    else if (byName.get(name) !== url) byName.set(name, null); // never attach one namesake's URL to an ambiguous label
  }
  const names = [...byName.keys()].filter(n => byName.get(n)).sort((a, b) => b.length - a.length);
  if (!names.length) return null;
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  const parts = []; let at = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    parts.push({ link: { url: byName.get(m[0]), label: m[0] } }); at = m.index + m[0].length;
  }
  if (!parts.length) return null;
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/**
 * `text` split at each whole-word occurrence of `name`, as parts: { text } and { link: { url, label: name } }. Null when there
 * is no trusted LinkedIn, no usable name, or the name does not appear.
 */
export function nameParts(text, name, url) {
  const link = trustedLinkedin(url);
  const label = typeof name === 'string' ? name.trim() : '';
  if (!link || typeof text !== 'string' || label.length < 2 || label.length > 160 || /[<>|\u0000-\u001f\u007f]/u.test(label)) return null;
  const parts = []; let at = 0, found = false;
  const boundary = ch => !ch || !/[\p{L}\p{N}]/u.test(ch);
  for (let i = text.indexOf(label); i !== -1; i = text.indexOf(label, i + label.length)) {
    if (!boundary(text[i - 1]) || !boundary(text[i + label.length])) continue;
    if (i > at) parts.push({ text: text.slice(at, i) });
    parts.push({ link: { url: link, label } });
    at = i + label.length; found = true;
  }
  if (!found) return null;
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** A Block Kit rich_text block for parts (no markup is parsed in rich text, so nothing in the text can format or link). */
export function richTextBlock(parts) {
  return { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: parts.map(part => (part.link
    ? { type: 'link', url: part.link.url, text: part.link.label }
    : { type: 'text', text: part.text })) }] };
}

/** The message body as a block: the candidate's name linked to their LinkedIn when one is on file, else plain text as before. */
export function bodyBlock(body, candidate) {
  const parts = nameParts(body, candidate?.fullName, candidate?.linkedin);
  return parts ? richTextBlock(parts) : { type: 'section', text: { type: 'plain_text', text: String(body).slice(0, 3000), emoji: true } };
}
