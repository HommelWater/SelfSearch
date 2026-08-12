// Deterministic canonical JSON matching core/mesh.js's canonicalJson (sorted
// keys, JSON.stringify values). Used to produce verifiable wire docs in tests.
export function canonicalDoc(obj) {
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => `"${k}":${JSON.stringify(obj[k])}`).join(',') + '}';
}

// Sign a wire doc ({...fields, authorNpub}) with the given secret key, matching
// how the mesh signs docs it serves.
export function signWireDoc(deps, sk, d) {
  const payload = {
    authorNpub: d.authorNpub,
    url: d.url,
    title: d.title || '',
    description: d.description || '',
    direct_keywords: d.direct_keywords || '',
    related_keywords: d.related_keywords || '',
    timestamp: d.timestamp || 0
  };
  const msg = deps.sha256(new TextEncoder().encode(canonicalDoc(payload)));
  const sig = deps.bytesToHex(deps.schnorr.sign(msg, sk));
  return { ...payload, sig };
}
