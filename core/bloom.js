function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class BloomFilter {
  // bits: filter size in bits. hashes: number of hash functions.
  constructor(bits = 1 << 16, hashes = 5) {
    if (bits < 64) bits = 64;
    this.bits = bits;
    this.hashes = Math.max(1, hashes);
    this._bytes = new Uint8Array(Math.ceil(bits / 8));
  }

  // Compute optimal (bits, hashes) for expectedItems at a target false-positive rate.
  static create(expectedItems, fpRate = 0.01) {
    const n = Math.max(1, expectedItems);
    const bits = Math.max(64, Math.ceil((-n * Math.log(fpRate)) / (Math.LN2 * Math.LN2)));
    const hashes = Math.max(1, Math.round((bits / n) * Math.LN2));
    return new BloomFilter(bits, hashes);
  }

  _indexes(str) {
    const h1 = fnv1a(str, 0x811c9dc5);
    const h2 = fnv1a(str, 0x9e3779b9) >>> 1 | 1; // positive odd, so double-hashing never cycles
    const out = new Array(this.hashes);
    for (let i = 0; i < this.hashes; i++) out[i] = (h1 + i * h2) % this.bits;
    return out;
  }

  _set(i) {
    this._bytes[i >> 3] |= 1 << (i & 7);
  }

  _get(i) {
    return (this._bytes[i >> 3] & (1 << (i & 7))) !== 0;
  }

  add(value) {
    for (const i of this._indexes(value)) this._set(i);
    return this;
  }

  has(value) {
    for (const i of this._indexes(value)) {
      if (!this._get(i)) return false;
    }
    return true;
  }

  addAll(values) {
    for (const v of values) this.add(v);
    return this;
  }

  // In-place OR of another filter's bits. Both must share the same size/hashes.
  union(other) {
    if (other.bits !== this.bits || other.hashes !== this.hashes) {
      throw new Error(`BloomFilter size mismatch: ${this.bits}/${other.bits}, ${this.hashes}/${other.hashes}`);
    }
    for (let i = 0; i < this._bytes.length; i++) this._bytes[i] |= other._bytes[i];
    return this;
  }

  toBytes() {
    return this._bytes;
  }

  static fromBytes(bytes, hashes) {
    const f = new BloomFilter(bytes.length * 8, hashes);
    f._bytes.set(bytes);
    return f;
  }

  toBase64() {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < this._bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, this._bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  static fromBase64(b64, hashes) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return BloomFilter.fromBytes(bytes, hashes);
  }

  toJSON() {
    return { bits: this.bits, hashes: this.hashes, data: this.toBase64() };
  }

  static fromJSON(json) {
    const f = new BloomFilter(json.bits, json.hashes);
    f._bytes = new Uint8Array(fromB64Bytes(json.data));
    return f;
  }
}

function fromB64Bytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
