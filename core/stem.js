// Porter stemmer — the classic algorithm (Martin Porter, 1980), English only.
// Collapses inflections ("running"/"runs" -> "run", "recipes" -> "recip")
// so search matches across word forms. Applied identically at index time and
// query time, which keeps the inverted index, bloom filters and peer searches
// consistent. Not used for the keywords shown in results — those stay raw.

const STEP2 = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize',
  bli: 'ble', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous',
  ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive',
  fulness: 'ful', ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble',
  logi: 'log'
};
const STEP3 = {
  icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic', ful: '', ness: ''
};

const c = '[^aeiou]';
const v = '[aeiouy]';
const C = c + '[^aeiouy]*';
const V = v + '[aeiou]*';
// m conditions: [C]VC... (m>=1), [C]VC[V] (m==1), [C]VCVC... (m>=2), vowel in stem.
const mgr0 = new RegExp('^(' + C + ')?' + V + C);
const meq1 = new RegExp('^(' + C + ')?' + V + C + '(' + V + ')?$');
const mgr1 = new RegExp('^(' + C + ')?' + V + C + V + C);
const s_v = new RegExp('^(' + C + ')?' + v);

const re1a = /^(.+?)(ss|i)es$/;
const re2_1a = /^.+?[^s]s$/;
const re1b = /^(.+?)eed$/;
const re2_1b = /^(.+?)(ed|ing)$/;
const re2_1b2 = /(at|bl|iz)$/;
const re3_1b2 = /([^aeiouylsz])\1$/;
const re4_1b2 = new RegExp('^' + C + v + '[^aeiouwxy]$');   // *o: ends c-v-c, last c not w/x/y
const re1c = /^(.+?)y$/;
const re2 = /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
const re3 = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
const re4 = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
const re4ion = /^(.+?(?:s|t))ion$/;
const re5_1 = /^(.+?)e$/;
const re5_2 = /ll$/;

export function stem(w) {
  if (w.length <= 2) return w;
  // Mark an initial y so steps never turn it into an i; restored at the end.
  let s = w[0] === 'y' ? 'Y' + w.slice(1) : w;

  // Step 1a: plurals.
  if (re1a.test(s)) s = s.slice(0, -2);
  else if (re2_1a.test(s)) s = s.slice(0, -1);

  // Step 1b: -eed, -ed, -ing. Vowel/measure conditions apply to the stem
  // before the suffix, not the whole word.
  let m = re1b.exec(s);
  if (m) {
    if (mgr0.test(m[1])) s = s.slice(0, -1);          // eed -> ee
  } else if ((m = re2_1b.exec(s)) && s_v.test(m[1])) {
    s = m[1];
    if (re2_1b2.test(s)) s += 'e';                    // at/bl/iz -> add e
    else if (re3_1b2.test(s)) s = s.slice(0, -1);     // double letter -> drop
    else if (re4_1b2.test(s)) s += 'e';               // (m==1 and *o) -> add e
  }

  // Step 1c: (*v*) y -> i.
  if ((m = re1c.exec(s)) && s_v.test(m[1])) s = m[1] + 'i';

  // Step 2: (m > 0) suffix -> replacement.
  if ((m = re2.exec(s)) && mgr0.test(m[1])) s = m[1] + STEP2[m[2]];

  // Step 3: (m > 0) suffix -> replacement (may be empty).
  if ((m = re3.exec(s)) && mgr0.test(m[1])) s = m[1] + STEP3[m[2]];

  // Step 4: (m > 1) remove suffix; the -ion form additionally needs the
  // preceding stem to end in s/t.
  if ((m = re4.exec(s))) {
    if (mgr1.test(m[1])) s = m[1];
  } else if ((m = re4ion.exec(s)) && mgr1.test(m[1])) {
    s = m[1];
  }

  // Step 5a: (m > 1) e -> drop; (m == 1 and not *o) e -> drop.
  if ((m = re5_1.exec(s)) &&
      (mgr1.test(m[1]) || (meq1.test(m[1]) && !re4_1b2.test(m[1])))) {
    s = m[1];
  }

  // Step 5b: (m > 1 and *l) double l -> single l.
  if (re5_2.test(s) && mgr1.test(s)) s = s.slice(0, -1);

  return s.toLowerCase();
}
