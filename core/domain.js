import { tokenize } from './tokenize.js';

// Leading prefixes stripped to collapse www/mobile hostnames onto the main
// domain (e.g. www.youtube.com and m.youtube.com -> youtube.com).
const HOST_PREFIX = /^(?:www|m|mobile)\./;

// Main domain of a URL: lowercase hostname without www/m/mobile prefixes.
// Returns '' for unparseable URLs so callers can skip domain-aware logic.
export function hostnameOf(url) {
  try {
    return String(new URL(url).hostname).toLowerCase().replace(HOST_PREFIX, '');
  } catch {
    return '';
  }
}

// Terms that contribute to a doc's per-domain keyword stats. Only the stored
// keyword lists count: they are exactly what extraction ranks, so common terms
// there are the ones worth deprioritizing.
export function domainTerms(doc) {
  const set = new Set();
  for (const t of tokenize(doc.direct_keywords)) set.add(t);
  for (const t of tokenize(doc.related_keywords)) set.add(t);
  return [...set];
}

// Fraction of a domain's indexed docs that carry `term` as a keyword, 0..1.
// domainStats: { docs: number, terms: { term: count } } or null.
export function termDomainRatio(term, domainStats) {
  const docs = domainStats && domainStats.docs;
  const count = docs && domainStats.terms ? domainStats.terms[term] || 0 : 0;
  return docs > 0 ? count / docs : 0;
}
