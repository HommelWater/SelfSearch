import { getPublicKey, finalizeEvent } from './nostr-deps.js?v=10';
import { SimplePool } from './nostr-deps.js?v=10';
import { nip44 } from './nostr-deps.js?v=10';
import { nip19 } from './nostr-deps.js?v=10';
import { bytesToHex, hexToBytes } from './nostr-deps.js?v=10';
import { schnorr } from './nostr-deps.js?v=10';
import { sha256 } from './nostr-deps.js?v=10';

function log(...args) {
    try { (window.__p2plog = window.__p2plog || []).push(Math.round(Date.now() / 1000) % 100000 + ' ' + args.join(' ')); } catch { /* ignore */ }
    console.log(...args);
}

function canonicalJson(obj) {
    if (Array.isArray(obj)) return '[' + obj.map(canonicalJson).join(',') + ']';
    if (typeof obj === 'object' && obj !== null) {
        const keys = Object.keys(obj).sort();
        return '{' + keys.map(k => `"${k}":${canonicalJson(obj[k])}`).join(',') + '}';
    }
    return JSON.stringify(obj);
}

export function signPayload(payload, skHex) {
    const msgHash = sha256(new TextEncoder().encode(canonicalJson(payload)));
    const sig = schnorr.sign(msgHash, hexToBytes(skHex));
    return bytesToHex(sig);
}

export function verifyPayload(payload, sigHex, npub) {
    if (!npub || !sigHex || !payload) return false;
    const { data: pk } = nip19.decode(npub);
    const msgHash = sha256(new TextEncoder().encode(canonicalJson(payload)));
    return schnorr.verify(hexToBytes(sigHex), msgHash, hexToBytes(pk));
}

const KIND_SIGNAL = 25000;   // ephemeral, NIP-44 encrypted WebRTC signaling
const AUTH_KIND = 25001;     // signed in-band proof the channel belongs to the npub

const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band'
];

// Relays can be overridden via options or localStorage 'nostr_p2p_relays'
// (JSON array of ws(s):// URLs), e.g. for a self-hosted relay.
function resolveRelays(optionRelays) {
    if (optionRelays && optionRelays.length) return optionRelays;
    try {
        const stored = (typeof localStorage !== 'undefined') && localStorage.getItem('nostr_p2p_relays');
        if (stored) {
            const parsed = JSON.parse(stored);
            if (Array.isArray(parsed) && parsed.length) return parsed;
        }
    } catch { /* fall through to defaults */ }
    return DEFAULT_RELAYS;
}

// ICE servers can be extended via options or localStorage 'nostr_p2p_turn'
// (JSON object { urls, username?, credential? }), e.g. for a self-hosted
// TURN server to connect through restrictive NATs/firewalls. The default
// STUN entry is always kept; an explicit options.iceServers array replaces
// the whole list.
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

function resolveIceServers(optionIce) {
    if (optionIce && optionIce.length) return optionIce;
    const ice = [...DEFAULT_ICE_SERVERS];
    try {
        const stored = (typeof localStorage !== 'undefined') && localStorage.getItem('nostr_p2p_turn');
        if (stored) {
            const turn = JSON.parse(stored);
            if (turn && turn.urls) ice.push(turn);
        }
    } catch { /* fall through to defaults */ }
    return ice;
}

// --- Timing knobs -----------------------------------------------------------
const MAINTENANCE_INTERVAL = 10 * 1000;  // liveness + rotation tick
const PENDING_TIMEOUT = 25 * 1000;       // give up on an offered handshake
                                         // (leaves room for one offer re-send)
const ANSWER_TIMEOUT = 18 * 1000;        // answering is one relay round-trip,
                                         // but internet ICE checks need room;
                                         // runs from last signal seen
const SILENCE_TIMEOUT = 40 * 1000;       // no inbound traffic => peer is gone
                                         // (pings every tick; ~3 missed = drop)

// A session is the ONE source of truth for a peer relationship:
//   { npub, peerPk, pc, channel, phase: 'connecting'|'connected',
//     initiator, createdAt, connectedAt, lastActivity, iceBuffer, authSent }
// There is at most one session per npub; every event handler validates that
// the object it fired for is still the current session before touching state.
export class NostrP2P {
    constructor(secretKeyHex, options = {}) {
        this.sk = hexToBytes(secretKeyHex);
        this.hex_sk = secretKeyHex;
        this.relays = resolveRelays(options.relays);
        this.iceServers = resolveIceServers(options.iceServers);
        this.pk = getPublicKey(this.sk);
        this.npub = nip19.npubEncode(this.pk);
        this.pool = new SimplePool();

        this.onConnect = options.onConnect || null;
        this.onDisconnect = options.onDisconnect || null;
        // Verify sender signature before handing anything to the app.
        this.onMessage = (npub, message) => {
            if (typeof message === 'string') {
                try { message = JSON.parse(message); } catch { return; }
            }
            const { signature, ...payload } = message;
            if (!verifyPayload(payload, signature, message.sender)) return;
            if (options.onMessage) options.onMessage(npub, message);
        };

        this.maxConnections = options.maxConnections || 12;
        this.pendingSlots = options.pendingSlots || 3;
        this.minConnectionAge = options.minConnectionAge || 60 * 1000;
        // When true, accept signaling from unknown peers and auto-discover
        // them. Needed for open networks where new peers must be able to
        // reach us.
        this.open = options.open || false;

        this.sessions = new Map();                 // npub -> session (the only state)
        this.peers = options.peers || new Set([this.npub]); // everyone we know about
        this._signalQueues = new Map();            // serialize signaling per peer
        this._lastOfferAt = {};                    // offer dedup, per npub

        this._subscribe();
        // Re-subscribe periodically: the initial subscription can race the
        // relay handshake, and relays drop subs.
        this._listenTimer = setInterval(() => this._subscribe(), 20 * 1000);
        this._maintenanceTimer = setInterval(() => this._maintenance(), MAINTENANCE_INTERVAL);
        // Don't wait a full tick for the first connection attempts.
        setTimeout(() => this._maintenance(), 1000);
    }

    // --- Public API ---------------------------------------------------------

    // Connected (authenticated) peers only – derived view over the sessions.
    get connections() {
        const out = new Map();
        for (const [npub, s] of this.sessions) {
            if (s.phase === 'connected') out.set(npub, s);
        }
        return out;
    }

    isConnected(npub) {
        return this.sessions.get(npub)?.phase === 'connected';
    }

    // Initiate a connection to a peer.
    connect(npub) {
        if (npub === this.npub || this.sessions.has(npub)) return;
        if (this.sessions.size >= this.maxConnections + this.pendingSlots) return;
        this._createSession(npub, true, nip19.decode(npub).data);
    }

    addPeer(npub) {
        if (npub === this.npub || this.peers.has(npub)) return;
        this.peers.add(npub);
        this._maintenance();
    }

    removePeer(npub) {
        this.peers.delete(npub);
        this._dropSession(npub);
    }

    // Send a message to a connected peer. Objects are signed automatically;
    // 'sender' and 'signature' are reserved fields.
    send(npub, message) {
        if (typeof message === 'string') {
            try { message = JSON.parse(message); } catch { /* raw string payload */ }
        }
        if (typeof message === 'object' && message !== null) {
            if (!message.sender) {
                message.sender = this.npub;
                message.signature = signPayload(message, this.hex_sk);
            } else {
                const { signature, ...payload } = message;
                if (!verifyPayload(payload, signature, message.sender)) return;
            }
        }
        const s = this.sessions.get(npub);
        if (!s || s.phase !== 'connected' || s.channel?.readyState !== 'open') {
            throw new Error('Not connected to ' + npub.slice(0, 16));
        }
        s.channel.send(typeof message === 'string' ? message : JSON.stringify(message));
    }

    broadcast(message, except = []) {
        if (typeof message === 'string') {
            try { message = JSON.parse(message); } catch { /* raw string payload */ }
        }
        if (typeof message !== 'object' || message === null) return;
        if (!message.sender) {
            message.sender = this.npub;
            message.signature = signPayload(message, this.hex_sk);
        } else {
            const { signature, ...payload } = message;
            if (!verifyPayload(payload, signature, message.sender)) return;
        }
        const wire = JSON.stringify(message);
        for (const [npub, s] of this.sessions) {
            if (except.includes(npub)) continue;
            if (s.phase === 'connected' && s.channel?.readyState === 'open') {
                try { s.channel.send(wire); } catch { /* closing; maintenance reaps it */ }
            }
        }
    }

    close() {
        clearInterval(this._listenTimer);
        clearInterval(this._maintenanceTimer);
        try { this._sub?.close(); } catch { /* ignore */ }
        for (const npub of Array.from(this.sessions.keys())) this._closeSession(npub);
        this.pool.close(this.relays);
    }

    // Call when the page comes back after being frozen/backgrounded (phone
    // screen unlock, tab switch, network change). Relay sockets and WebRTC
    // transports may be half-dead, so: re-establish signaling immediately,
    // drop sessions that went silent while we were away, ping the rest, and
    // refill connections right away instead of waiting for the next tick.
    resume() {
        this._subscribe();
        // Demand proof of life: sessions that don't answer our ping before the
        // next maintenance tick are dropped, so reconnect takes ~15s instead
        // of waiting out the full silence timeout.
        const now = Date.now();
        for (const s of this.sessions.values()) {
            if (s.phase !== 'connected') continue;
            s._resumeCheck = now;
            try {
                if (s.channel?.readyState === 'open') s.channel.send(JSON.stringify({ type: 'ping', t: now }));
            } catch { this._dropSession(s.npub); }
        }
        this._maintenance();
    }

    // --- Session lifecycle --------------------------------------------------

    _createSession(npub, initiator, peerPk) {
        const pc = new RTCPeerConnection({
            iceServers: this.iceServers
        });
        log(`[p2p] new session ${npub.slice(0, 12)} initiator=${initiator}`);
        const session = {
            npub,
            peerPk: peerPk || null,
            pc,
            channel: null,
            phase: 'connecting',
            initiator,
            createdAt: Date.now(),
            connectedAt: 0,
            lastActivity: Date.now(),
            iceBuffer: [],
            myCandidates: [],
            authSent: false
        };
        this.sessions.set(npub, session);

        pc.onicecandidate = (e) => {
            if (e.candidate && session.peerPk) {
                // Trickle candidates are sent once and then forgotten — but the
                // peer may not have a session for them yet (offer still in
                // transit) or may have replaced it (glare). Keep them so the
                // maintenance loop can re-trickle; one-sided candidate loss is
                // survivable locally but often fatal across real NATs.
                const c = e.candidate.toJSON();
                session.myCandidates.push(c);
                this._sendSignal(session.peerPk, { type: 'ice-candidate', candidate: c });
            }
        };
        pc.onconnectionstatechange = () => {
            // 'failed'/'closed' are final; 'disconnected' is often transient,
            // so that one is left to the liveness check instead.
            if (['failed', 'closed'].includes(pc.connectionState) && this.sessions.get(npub) === session) {
                this._dropSession(npub);
            }
        };
        pc.ondatachannel = (e) => this._attachChannel(session, e.channel);

        if (initiator) {
            this._attachChannel(session, pc.createDataChannel('nostr-p2p'));
            pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                    // ots identifies this handshake attempt across re-sends:
                    // relays lose publishes (socket still connecting, dropped
                    // subs), so the offer is re-sent every maintenance tick,
                    // and the peer must dedup by ots – not event.created_at.
                    session.offerTs = Math.floor(Date.now() / 1000);
                    this._sendSignal(session.peerPk, { type: 'offer', ots: session.offerTs, sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
                })
                .catch(() => { if (this.sessions.get(npub) === session) this._dropSession(npub); });
        }
        return session;
    }

    _attachChannel(session, channel) {
        if (session.channel) return;
        session.channel = channel;
        const { npub } = session;
        channel.onopen = () => {
            if (!session.authSent) {
                session.authSent = true;
                this._sendAuth(session);
            }
        };
        channel.onclose = () => {
            if (this.sessions.get(npub) === session && session.channel === channel) {
                this._dropSession(npub, 'channel closed');
            }
        };
        channel.onmessage = (e) => this._handleChannelMessage(session, e.data);
    }

    // Close the pc/channel; the session object stays in the map.
    _closeSession(npub) {
        const s = this.sessions.get(npub);
        if (!s) return null;
        this.sessions.delete(npub);
        try { s.channel?.close(); } catch { /* ignore */ }
        try { s.pc.close(); } catch { /* ignore */ }
        return s;
    }

    // Close + notify the app if it had ever been told about this peer.
    _dropSession(npub, reason = '') {
        const s = this._closeSession(npub);
        if (s) log(`[p2p] drop ${npub.slice(0, 12)} (${s.phase}) ${reason}`);
        if (s && s.phase === 'connected') this.onDisconnect?.(npub);
        // Any drop is retried almost immediately, not at the next maintenance
        // tick: with few peers, waiting out the tick leaves the app peerless
        // for no reason.
        if (s) setTimeout(() => this._maintenance(), 500);
    }

    // --- Auth handshake -----------------------------------------------------

    _sendAuth(session) {
        if (!session.channel || session.channel.readyState !== 'open') return;
        const authEvent = finalizeEvent({
            kind: AUTH_KIND,
            created_at: Math.floor(Date.now() / 1000),
            tags: session.peerPk ? [['p', session.peerPk]] : [],
            content: 'webrtc-auth'
        }, this.sk);
        session.channel.send(JSON.stringify({ type: 'auth', event: authEvent }));
    }

    _verifyAuth(event, expectedNpub) {
        if (event.kind !== AUTH_KIND) return false;
        if (Math.abs(event.created_at - Math.floor(Date.now() / 1000)) > 60) return false;
        if (nip19.npubEncode(event.pubkey) !== expectedNpub) return false;
        const serialized = JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
        const id = bytesToHex(sha256(new TextEncoder().encode(serialized)));
        if (id !== event.id) return false;
        return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
    }

    _handleChannelMessage(session, data) {
        const { npub } = session;
        if (this.sessions.get(npub) !== session) return; // stale channel
        session.lastActivity = Date.now();

        let msg;
        try { msg = JSON.parse(data); } catch { msg = null; }

        if (msg && msg.type === 'auth' && msg.event) {
            if (session.phase === 'connected') return; // duplicate auth
            if (!this._verifyAuth(msg.event, npub)) { this._dropSession(npub); return; }
            log(`[p2p] connected ${npub.slice(0, 12)}`);
            session.peerPk = msg.event.pubkey;
            session.phase = 'connected';
            session.connectedAt = Date.now();
            if (!session.authSent) {
                session.authSent = true;
                this._sendAuth(session);
            }
            this.onConnect?.(npub);
            return;
        }
        if (msg && msg.type === 'ping') return; // keepalive, handled via lastActivity

        // App traffic only flows on authenticated sessions.
        if (session.phase === 'connected') this.onMessage(npub, data);
    }

    // --- Maintenance: liveness + rotation -----------------------------------

    _maintenance() {
        const now = Date.now();

        for (const [npub, s] of Array.from(this.sessions)) {
            if (s.phase === 'connecting') {
                // Handshake never completed – tear down; rotation may retry.
                // Answering slots expire faster: they only need one relay
                // round-trip, and a stale one (answering a replayed offer the
                // peer has already moved on from) otherwise wedges reconnects
                // for the full pending timeout. The clock runs from the last
                // signal we saw, not session birth: slow ICE checks across
                // the internet must not get a progressing handshake killed.
                const timeout = s.initiator ? PENDING_TIMEOUT : ANSWER_TIMEOUT;
                if (now - Math.max(s.createdAt, s.lastSignalAt || 0) > timeout) {
                    this._dropSession(npub, 'handshake timeout');
                    continue;
                }
                // Re-send the offer every tick until the handshake lands:
                // publishes to relays can silently fail while sockets connect.
                // Re-trickle our ICE candidates too — the peer's session may
                // not have existed (or may have been replaced) when they were
                // first sent, and lost candidates break real-world ICE.
                if (s.initiator && s.pc.localDescription && s.offerTs) {
                    try {
                        this._sendSignal(s.peerPk, { type: 'offer', ots: s.offerTs, sdp: { type: s.pc.localDescription.type, sdp: s.pc.localDescription.sdp } });
                        if (s.myCandidates.length) this._sendSignal(s.peerPk, { type: 'ice-candidates', candidates: s.myCandidates });
                    } catch { /* retry next tick */ }
                } else if (!s.initiator && s.myCandidates.length && s.pc.localDescription) {
                    // Answering side: our candidates may equally have been lost
                    // before the offerer's answer-processing session existed.
                    try { this._sendSignal(s.peerPk, { type: 'ice-candidates', candidates: s.myCandidates }); } catch { /* retry next tick */ }
                }
                continue;
            }
            // A session challenged on resume() must have shown inbound
            // traffic since; otherwise it's a half-dead transport.
            if (s._resumeCheck) {
                if (s.lastActivity >= s._resumeCheck) {
                    s._resumeCheck = 0;
                } else if (now - s._resumeCheck > MAINTENANCE_INTERVAL) {
                    this._dropSession(npub, 'no answer after resume');
                    continue;
                }
            }
            // Connected: a vanished peer's channel can read 'open' forever
            // (ICE failure detection is unreliable in throttled tabs), so
            // silence is the real liveness signal.
            if (now - s.lastActivity > SILENCE_TIMEOUT) {
                this._dropSession(npub, 'silence');
                continue;
            }
            try {
                if (s.channel?.readyState === 'open') {
                    s.channel.send(JSON.stringify({ type: 'ping', t: now }));
                } else {
                    this._dropSession(npub); // channel died without an event
                }
            } catch { this._dropSession(npub); }
        }

        // Fill toward the in-flight target with fresh candidates.
        const deficit = this.maxConnections + this.pendingSlots - this.sessions.size;
        const candidates = Array.from(this.peers).filter(p => p !== this.npub && !this.sessions.has(p));
        for (let i = candidates.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
        }
        const used = Math.max(0, Math.min(deficit, candidates.length));
        for (let i = 0; i < used; i++) this.connect(candidates[i]);

        // Passive rotation: at max connected, swap the oldest eligible
        // connection for a fresh peer to keep the mesh well mixed.
        const connected = [...this.sessions.values()].filter(s => s.phase === 'connected');
        if (connected.length >= this.maxConnections && candidates.length > used) {
            let oldest = null;
            for (const s of connected) {
                if (now - s.connectedAt >= this.minConnectionAge && (!oldest || s.connectedAt < oldest.connectedAt)) {
                    oldest = s;
                }
            }
            if (oldest) {
                this._dropSession(oldest.npub);
                this.connect(candidates[used]);
            }
        }
    }

    // --- Signaling (Nostr relays) -------------------------------------------

    _subscribe() {
        try {
            if (this._sub) { try { this._sub.close(); } catch { /* ignore */ } }
            this._sub = this.pool.subscribeMany(
                this.relays,
                { kinds: [KIND_SIGNAL], '#p': [this.pk], since: Math.floor(Date.now() / 1000) - 300 },
                { onevent: (event) => this.handleSignal(event) }
            );
        } catch (e) {
            console.warn('Relay subscribe failed, will retry', e);
        }
    }

    async _sendSignal(recipientPk, payload) {
        const ck = nip44.getConversationKey(this.sk, recipientPk);
        const ciphertext = nip44.encrypt(JSON.stringify(payload), ck);
        const event = finalizeEvent({
            kind: KIND_SIGNAL,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', recipientPk]],
            content: ciphertext
        }, this.sk);
        await Promise.allSettled(this.pool.publish(this.relays, event));
    }

    // Serialize processing per peer: concurrent offer/answer handling races
    // corrupt RTCPeerConnection state.
    handleSignal(event) {
        // Never signal with ourselves (same identity in a second tab, or
        // accidentally self-added): it only corrupts handshake state.
        if (event.pubkey === this.pk) return;
        const key = event.pubkey;
        const prev = this._signalQueues.get(key) || Promise.resolve();
        const next = prev.then(() => this._handleSignal(event)).catch(() => {});
        this._signalQueues.set(key, next);
        return next;
    }

    async _handleSignal(event) {
        const senderPk = event.pubkey;
        const npub = nip19.npubEncode(senderPk);
        if (!this.peers.has(npub)) {
            if (!this.open) return;
            this.peers.add(npub); // auto-discover peers that reach out to us
        }

        let payload;
        try {
            const ck = nip44.getConversationKey(this.sk, senderPk);
            payload = JSON.parse(nip44.decrypt(event.content, ck));
        } catch {
            return;
        }

        let session = this.sessions.get(npub);
        // Any inbound signal means the handshake is still progressing —
        // real-world ICE/relay latency can exceed the bare timeouts, so a
        // session may only be reaped after this much *quiet* time.
        if (session) session.lastSignalAt = Date.now();

        if (payload.type === 'offer') {
            // ots identifies the handshake attempt (re-sends share it);
            // fall back to event time for peers on older builds.
            const offerTs = (payload.ots || event.created_at || 0) * 1000;
            // Too old to be answerable: the offerer's handshake attempt times
            // out anyway, so answering a replayed offer only breaks a healthy
            // connection or wedges a stale one.
            if (Date.now() - offerTs > PENDING_TIMEOUT) { log(`[p2p] ignore old offer from ${npub.slice(0, 12)}`); return; }
            if (this._lastOfferAt[npub] && offerTs <= this._lastOfferAt[npub]) {
                // Duplicate/re-sent offer: if we're still answering it, our
                // answer may have been lost – send it again.
                const s = this.sessions.get(npub);
                if (s && !s.initiator && s.phase === 'connecting' && s.pc.localDescription) {
                    try {
                        await this._sendSignal(senderPk, { type: 'answer', sdp: { type: s.pc.localDescription.type, sdp: s.pc.localDescription.sdp } });
                        if (s.myCandidates.length) await this._sendSignal(senderPk, { type: 'ice-candidates', candidates: s.myCandidates });
                    } catch { /* ignore */ }
                }
                return;
            }
            this._lastOfferAt[npub] = offerTs;

            if (session) {
                if (session.phase === 'connected') {
                    // A genuinely new offer means the peer restarted (or its pc
                    // died silently). Replace our side, or it can never
                    // reconnect.
                    this._dropSession(npub, 'replaced by new offer');
                    session = null;
                } else if (session.initiator) {
                    // Glare: both sides offered. The lexicographically larger
                    // npub keeps its offer; the smaller yields and adopts.
                    if (this.npub > npub) { log(`[p2p] glare: keep our offer to ${npub.slice(0, 12)}`); return; }
                    log(`[p2p] glare: yield to ${npub.slice(0, 12)}`);
                    this._closeSession(npub);
                    session = null;
                } else {
                    // We were answering an older offer from them that never
                    // completed – adopt the fresh attempt instead of ignoring
                    // it, or both sides wait out their timeouts in turn.
                    this._closeSession(npub);
                    session = null;
                }
            }
            if (!session) {
                if (this.sessions.size >= this.maxConnections + this.pendingSlots) return;
                session = this._createSession(npub, false, senderPk);
            }
        }

        if (payload.type === 'answer') {
            if (!session || !session.initiator || session.pc.signalingState !== 'have-local-offer') return;
        }

        if (!session) return; // e.g. an ICE candidate with no session
        const pc = session.pc;

        try {
            if (payload.type === 'offer') {
                await pc.setRemoteDescription(payload.sdp);
                await this._flushIce(session);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                await this._sendSignal(senderPk, { type: 'answer', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
            } else if (payload.type === 'answer') {
                await pc.setRemoteDescription(payload.sdp);
                await this._flushIce(session);
            } else if (payload.type === 'ice-candidate' && payload.candidate) {
                if (pc.remoteDescription?.type) {
                    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
                } else {
                    session.iceBuffer.push(payload.candidate);
                }
            } else if (payload.type === 'ice-candidates' && Array.isArray(payload.candidates)) {
                for (const candidate of payload.candidates) {
                    if (pc.remoteDescription?.type) {
                        await pc.addIceCandidate(new RTCIceCandidate(candidate));
                    } else {
                        session.iceBuffer.push(candidate);
                    }
                }
            }
        } catch (e) {
            // Stale or raced signaling message – ignore; maintenance retries.
            console.warn('Signaling error', e);
        }
    }

    async _flushIce(session) {
        const buffered = session.iceBuffer.splice(0);
        for (const candidate of buffered) {
            try { await session.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* stale */ }
        }
    }
}
