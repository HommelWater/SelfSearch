import { tokenize } from './tokenize.js';
import { termDomainRatio } from './domain.js';

const BODY_TRUNCATE = 50000;
const DIRECT_LIMIT = 25;
const RELATED_LIMIT = 25;
// A keyword is "common" once it shows up in more than this fraction of a
// corpus's docs, and only after the corpus has at least this many docs.
const COMMON_RATIO = 0.5;
const MIN_CORPUS_DOCS = 5;

// --- Local extraction (no LLM): keyword frequency over the page text --------
//
// Terms that recur across most of a corpus of pages (a domain's indexed pages,
// e.g. "video"/"likes" on youtube.com, or the user's whole index, e.g. a lot
// of cooking pages) carry no signal for telling those pages apart, so they are
// deprioritized in favor of the unique terms. Each corpus is a { docs, terms }
// summary; the penalty combines domain-level and user-level corpora.

// 1 = no penalty; 0 = fully common (appears in every indexed doc of the corpus).
function corpusPenalty(term, stats) {
  if (!stats || stats.docs < MIN_CORPUS_DOCS) return 1;
  const ratio = termDomainRatio(term, stats);
  if (ratio <= COMMON_RATIO) return 1;
  return Math.max(0, 1 - (ratio - COMMON_RATIO) / (1 - COMMON_RATIO));
}

// page: { title, metaDescription, metaKeywords, bodyText }
// opts: { domainStats, userStats } — keyword frequency corpora, from core/domain.js.
// Returns { title, description, direct_keywords, related_keywords }.
export function extractFromDom(page, opts = {}) {
  const { domainStats, userStats } = opts;
  const title = String(page.title || '').trim();
  const body = String(page.bodyText || '').slice(0, BODY_TRUNCATE);

  // Weighted term frequencies: body 1x, title 3x, meta keywords 2x.
  const counts = new Map();
  const bump = (text, weight = 1) => {
    for (const t of tokenize(text)) counts.set(t, (counts.get(t) || 0) + weight);
  };
  bump(title, 3);
  if (page.metaKeywords) {
    for (const k of String(page.metaKeywords).split(/[,;]/)) {
      const t = k.trim().toLowerCase();
      if (t.length > 2) counts.set(t, (counts.get(t) || 0) + 2);
    }
  }
  bump(body, 1);

  // Demote terms that are common across the domain or the user's whole index,
  // then rank the rest. A fully common term (penalty 0) is dropped: it carries
  // no signal here.
  const sorted = [...counts.entries()]
    .map(([t, count]) => {
      let w = count * corpusPenalty(t, domainStats);
      w *= corpusPenalty(t, userStats);
      return [t, w];
    })
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]);
  const direct = sorted.slice(0, DIRECT_LIMIT).map(([t]) => t);
  const related = sorted.slice(DIRECT_LIMIT, DIRECT_LIMIT + RELATED_LIMIT).map(([t]) => t);

  let description = String(page.metaDescription || '').trim();
  if (!description) {
    description = body.replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  return {
    title: title || null,
    description,
    direct_keywords: direct.join(' '),
    related_keywords: related.join(' ')
  };
}
