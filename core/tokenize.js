import { stem } from './stem.js';

const STOPWORDS = new Set(`
a about above after again against all am an and any are aren't as at be because been before being below between
both but by can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further
had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i
i'd i'll i'm i've if in into is isn't it it's its itself let's me more most mustn't my myself no nor not of off on once
only or other ought our ours ourselves out over own same shan't she she'd she'll she's should shouldn't so some such
than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this
those through to too under until up very was wasn't we we'd we'll we're we've were weren't what what's when when's
where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your
yours yourself yourselves`.trim().split(/\s+/));

// Lowercase, split on non-letter/non-number runs, drop empty/short/stop words.
export function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

// Bump this whenever tokenization/normalization changes so the inverted index,
// bloom filters and docCache terms get rebuilt once against the new scheme.
export const TOKENIZER_VERSION = 2;

// Tokens reduced to their stem ("running" -> "run"). Used for the searchable
// index and queries so inflections match; the stored keywords stay raw.
export function stemmed(text) {
  return tokenize(text).map(stem);
}

// Unique searchable terms across all fields of a doc (stemmed).
export function docTerms(doc) {
  const set = new Set();
  for (const field of ['title', 'description', 'direct_keywords', 'related_keywords']) {
    for (const t of stemmed(doc[field])) set.add(t);
  }
  return [...set];
}
