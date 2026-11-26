//#region src/crypto/base64.ts
var e = /^[A-Za-z0-9_-]*$/;
function t(e) {
	let t = "";
	for (let n of e) t += String.fromCharCode(n);
	return btoa(t).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function n(t) {
	if (!e.test(t) || t.length % 4 == 1) return null;
	let n = t.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - t.length % 4) % 4);
	try {
		let e = atob(n), t = new Uint8Array(e.length);
		for (let n = 0; n < e.length; n++) t[n] = e.charCodeAt(n);
		return t;
	} catch {
		return null;
	}
}
//#endregion
//#region src/crypto/room.ts
var r = /^slc1-[A-Za-z0-9_-]{43}$/, i = new TextEncoder().encode("safelight-studio-collab/1"), a = "s1.", o = 12;
function s() {
	return "slc1-" + t(crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(32)));
}
function c(e) {
	let t = e.trim();
	return r.test(t) ? t : null;
}
async function l(e, t, n) {
	let r = await crypto.subtle.deriveBits({
		name: "HKDF",
		hash: "SHA-256",
		salt: i,
		info: new TextEncoder().encode(t)
	}, e, n * 8);
	return new Uint8Array(r);
}
var u = (e) => [...e].map((e) => e.toString(16).padStart(2, "0")).join("");
async function d(e) {
	let r = n(e.slice(5));
	if (!r) throw Error("Not a room code");
	let i = await crypto.subtle.importKey("raw", r, "HKDF", !1, ["deriveBits"]), [a, o, s] = await Promise.all([
		l(i, "room-id", 16),
		l(i, "seal-key", 32),
		l(i, "relay-token", 32)
	]), c = await crypto.subtle.importKey("raw", o, "AES-GCM", !1, ["encrypt", "decrypt"]);
	return {
		roomId: u(a),
		relayToken: t(s),
		sealKey: c
	};
}
var f = (e) => new TextEncoder().encode(`studio-collab/1/${e}`);
async function p(e, n) {
	let r = crypto.getRandomValues(new Uint8Array(o)), i = new TextEncoder().encode(JSON.stringify(n)), s = await crypto.subtle.encrypt({
		name: "AES-GCM",
		iv: r,
		additionalData: f(e.roomId)
	}, e.sealKey, i);
	return `${a}${t(r)}.${t(new Uint8Array(s))}`;
}
async function m(e, t) {
	if (!t.startsWith(a)) return null;
	let [r, i, s] = t.slice(3).split(".");
	if (s !== void 0 || !r || !i) return null;
	let c = n(r), l = n(i);
	if (!c || c.length !== o || !l) return null;
	try {
		let t = await crypto.subtle.decrypt({
			name: "AES-GCM",
			iv: c,
			additionalData: f(e.roomId)
		}, e.sealKey, l);
		return JSON.parse(new TextDecoder().decode(t));
	} catch {
		return null;
	}
}
//#endregion
//#region src/sync/clock.ts
var h = 6e5;
function g(e, t) {
	return e ? t ? e[0] === t[0] ? e[1] > t[1] : e[0] > t[0] : !0 : !1;
}
function _(e) {
	return Array.isArray(e) && e.length === 2 && typeof e[0] == "number" && Number.isFinite(e[0]) && typeof e[1] == "string";
}
var v = class {
	last = 0;
	by;
	now;
	constructor(e, t = Date.now, n = 0) {
		this.by = e, this.now = t, this.last = n;
	}
	next() {
		return this.last = Math.max(this.now(), this.last + 1), [this.last, this.by];
	}
	observe(e) {
		e && e[0] > this.last && (this.last = e[0]);
	}
	tooFarAhead(e) {
		return e[0] > this.now() + h;
	}
	get lastAt() {
		return this.last;
	}
}, y = [
	"shooter",
	"culler",
	"editor",
	"exporter"
], b = /^[pc]:./, x = 512, S = (e) => typeof e == "object" && !!e && !Array.isArray(e), C = (e, t = x) => typeof e == "string" && e.length <= t, w = (e) => typeof e == "number" && Number.isInteger(e) && e >= 1, T = (e) => y.some((t) => t === e);
function ee(e, t = 0) {
	return t > 32 ? !1 : e === null || typeof e == "string" || typeof e == "boolean" ? !0 : typeof e == "number" ? Number.isFinite(e) : Array.isArray(e) ? e.every((e) => ee(e, t + 1)) : S(e) && Object.values(e).every((e) => ee(e, t + 1));
}
function E(e) {
	return Array.isArray(e) && e.length === 3 && C(e[0], 2048) && b.test(e[0]) && C(e[1]) && e[1] !== "" && ee(e[2]);
}
function te(e) {
	return Array.isArray(e) && e.length === 4 && E(e.slice(0, 3)) && _(e[3]);
}
function ne(e) {
	let t = {};
	if (S(e)) for (let [n, r] of Object.entries(e)) C(r) && (t[n] = r);
	return t;
}
function re(e, t) {
	return !Array.isArray(e.regs) || !e.regs.every(te) ? null : {
		v: 1,
		kind: "state",
		by: t,
		regs: e.regs,
		fp: ne(e.fp)
	};
}
function ie(e, t) {
	return !w(e.seq) || !_(e.at) || e.at[1] !== t || !Array.isArray(e.ch) || !e.ch.every(E) ? null : {
		v: 1,
		kind: "ops",
		by: t,
		name: C(e.name, 80) ? e.name : "",
		seq: e.seq,
		at: e.at,
		ch: e.ch,
		fp: ne(e.fp)
	};
}
function ae(e, t) {
	return typeof e.wall != "number" || !Number.isFinite(e.wall) ? null : {
		v: 1,
		kind: "presence",
		by: t,
		name: C(e.name, 80) ? e.name : "",
		role: T(e.role) ? e.role : "",
		module: C(e.module, 64) ? e.module : "",
		photo: C(e.photo, 2048) ? e.photo : "",
		editing: e.editing === !0,
		wall: e.wall,
		app: C(e.app, 32) ? e.app : ""
	};
}
function oe(e) {
	return !S(e) || e.v !== 1 || !C(e.by, 64) || e.by === "" ? null : e.kind === "ops" ? ie(e, e.by) : e.kind === "presence" ? ae(e, e.by) : e.kind === "state" ? re(e, e.by) : null;
}
//#endregion
//#region src/settings.ts
var se = "studio-collab", ce = "profile", le = "room", ue = "members", de = "autoStage", fe = "realtime", pe = "room-code", me = (e) => typeof e == "object" && !!e && !Array.isArray(e), D = (e) => typeof e == "string" ? e : "", he = (e) => y.some((t) => t === e);
function ge(e) {
	let t = e.get(ce, null);
	return me(t) ? {
		name: D(t.name).slice(0, 80),
		role: he(t.role) ? t.role : ""
	} : {
		name: "",
		role: ""
	};
}
function _e(e, t) {
	e.set(ce, {
		name: t.name.slice(0, 80),
		role: t.role
	});
}
function ve(e) {
	let t;
	try {
		t = new URL(e.trim());
	} catch {
		return null;
	}
	return t.protocol !== "https:" || t.username || t.password || t.search || t.hash ? null : `${t.origin}${t.pathname.replace(/\/+$/, "")}`;
}
var ye = (e) => new URL(e).origin.replace(/^https:/, "wss:");
function O(e) {
	let t = e.get(le, null);
	if (!me(t)) return null;
	let n = t.keychain === !0, r = n ? "" : c(D(t.code));
	if (r === null) return null;
	let i = {
		code: r,
		keychain: n,
		project: D(t.project)
	};
	if (t.transport === "folder" && D(t.folderToken)) return {
		...i,
		transport: "folder",
		folderToken: D(t.folderToken),
		folderLabel: D(t.folderLabel)
	};
	let a = ve(D(t.relayUrl));
	return t.transport === "relay" && a ? {
		...i,
		transport: "relay",
		relayUrl: a
	} : null;
}
function be(e, t) {
	e.set(le, t);
}
function xe(e, t) {
	let n = e.get(ue, {}), r = {};
	if (me(n)) for (let [e, t] of Object.entries(n)) typeof t == "string" && /^[0-9a-f]{16}$/.test(t) && (r[e] = t);
	let i = r[t];
	if (i) return i;
	let a = [...crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(8))].map((e) => e.toString(16).padStart(2, "0")).join("");
	return e.set(ue, {
		...r,
		[t]: a
	}), a;
}
var Se = (e) => e.get(de, !0) !== !1;
function Ce(e) {
	let t = e.trim();
	return /^turns?:[^\s'"]+$/i.test(t) ? t : null;
}
function we(e) {
	let t = e.get(fe, null);
	if (!me(t)) return {
		publicSignalling: !0,
		turn: null
	};
	let n = me(t.turn) ? t.turn : null, r = n ? Ce(D(n.url)) : null;
	return {
		publicSignalling: t.publicSignalling !== !1,
		turn: n && r ? {
			url: r,
			username: D(n.username),
			credential: D(n.credential)
		} : null
	};
}
function Te(e, t) {
	e.set(fe, t);
}
//#endregion
//#region src/sync/catalog-sync.ts
var Ee = [
	"shot",
	"culled",
	"edited",
	"exported"
], De = [
	"none",
	"pick",
	"reject"
], Oe = [
	"none",
	"red",
	"yellow",
	"green",
	"blue",
	"purple"
], ke = (e) => typeof e == "string" && De.some((t) => t === e), Ae = (e) => typeof e == "string" && Oe.some((t) => t === e), je = (e) => typeof e == "number" && Number.isInteger(e) && e >= 0 && e <= 5, Me = (e) => typeof e == "string" && Ee.some((t) => t === e), Ne = (e) => Me(e) ? Ee.indexOf(e) : 0;
function Pe(e) {
	let t = e.relPath.replace(/\\/g, "/").normalize("NFC");
	return e.copyOf ? `p:${t}#copy:${e.copyName ?? "copy"}` : `p:${t}`;
}
function Fe(e) {
	return [
		e.filename,
		e.fileSize,
		e.exif.dateTimeOriginal ?? "",
		e.exif.subSecTimeOriginal ?? ""
	].join("|");
}
var k = (e) => JSON.stringify(e ?? null);
function Ie(e) {
	return e === null || typeof e == "string" || typeof e == "boolean" ? !0 : typeof e == "number" ? Number.isFinite(e) : Array.isArray(e) ? e.every(Ie) : typeof e == "object" && e !== void 0 && Object.values(e).every(Ie);
}
function Le(e) {
	return typeof e.exposure == "number";
}
function Re(e, t) {
	let n = {};
	for (let [r, i] of Object.entries(e)) n[r.slice(t.length)] = i;
	return n;
}
var ze = class {
	opts;
	byKey = /* @__PURE__ */ new Map();
	byFingerprint = /* @__PURE__ */ new Map();
	keyOf = /* @__PURE__ */ new Map();
	indexedFrom = null;
	aliases = /* @__PURE__ */ new Map();
	lastSeen = /* @__PURE__ */ new Map();
	settleTimer = null;
	editTimers = /* @__PURE__ */ new Map();
	unsubscribe = null;
	running = !1;
	startup = [];
	writing = /* @__PURE__ */ new Map();
	deferred = /* @__PURE__ */ new Set();
	oversized = /* @__PURE__ */ new Set();
	listeners = /* @__PURE__ */ new Set();
	constructor(e) {
		this.opts = e;
	}
	get state() {
		return this.opts.engine.state;
	}
	recordOfflineChanges() {
		if (!this.opts.engine.firstJoin) for (let e of this.opts.catalog.photos()) this.recordMetadata(e, !1);
	}
	async begin() {
		await this.opts.engine.idle(), this.reindex(), this.running = !0;
		let e = this.startup;
		this.startup = [], this.applied(e);
		let t = this.opts.engine.firstJoin, n = this.opts.catalog.photos();
		for (let e of n) t && this.recordMetadata(e, !0), this.lastSeen.set(e.id, e);
		if (t) for (let e of n) await this.recordEdit(e.id, !0);
		this.unsubscribe = this.opts.catalog.onPhotosChange(() => this.scheduleSettle());
	}
	stop() {
		this.running = !1, this.unsubscribe?.(), this.settleTimer && clearTimeout(this.settleTimer);
		for (let e of this.editTimers.values()) clearTimeout(e);
	}
	subscribe(e) {
		return this.listeners.add(e), () => this.listeners.delete(e);
	}
	notify() {
		for (let e of this.listeners) e();
	}
	reindex() {
		let e = this.opts.catalog.photos();
		if (e !== this.indexedFrom) {
			this.indexedFrom = e, this.byKey = /* @__PURE__ */ new Map(), this.byFingerprint = /* @__PURE__ */ new Map(), this.keyOf = /* @__PURE__ */ new Map();
			for (let t of e) {
				let e = Pe(t);
				if (this.byKey.set(e, t.id), this.keyOf.set(t.id, e), t.copyOf) continue;
				let n = Fe(t);
				this.byFingerprint.set(n, [...this.byFingerprint.get(n) ?? [], t.id]);
			}
		}
	}
	photoIdFor(e) {
		this.reindex();
		let t = this.byKey.get(e) ?? this.aliases.get(e);
		if (t) return t;
		let n = this.state.fingerprints.get(e), r = n ? this.byFingerprint.get(n) : void 0;
		if (r?.length === 1) return this.aliases.set(e, r[0]), r[0];
	}
	keyFor(e) {
		return this.reindex(), this.keyOf.get(e);
	}
	entitiesFor(e) {
		let t = this.keyFor(e), n = [...this.aliases].filter(([, t]) => t === e).map(([e]) => e);
		return t ? [t, ...n] : n;
	}
	value(e, t) {
		let n = this.keyFor(e);
		if (n && this.state.has(n, t)) return this.state.value(n, t);
		for (let n of this.entitiesFor(e)) if (this.state.has(n, t)) return this.state.value(n, t);
	}
	stageOf(e) {
		let t = this.value(e, "stage");
		return Me(t) ? t : "shot";
	}
	scheduleSettle() {
		this.running && !this.settleTimer && (this.settleTimer = setTimeout(() => {
			this.settleTimer = null, this.settle();
		}, this.opts.settleMs ?? 250));
	}
	settle() {
		if (!this.running) return;
		let e = this.opts.catalog.photos(), t = /* @__PURE__ */ new Map();
		for (let n of e) if (this.writing.has(n.id)) {
			let e = this.lastSeen.get(n.id);
			e && t.set(n.id, e);
		} else t.set(n.id, n), this.lastSeen.get(n.id) !== n && this.recordMetadata(n, !1);
		this.lastSeen = t;
	}
	recordMetadata(e, t) {
		let n = Pe(e), r = [], i = (e, i, a) => {
			let o = this.state.has(n, e);
			(o || !a) && (!o || !t && k(this.state.value(n, e)) !== k(i)) && r.push([
				n,
				e,
				i
			]);
		};
		i("rating", e.rating, e.rating === 0), i("flag", e.flag, e.flag === "none"), i("label", e.colorLabel, e.colorLabel === "none");
		let a = new Set(e.keywords);
		for (let e of a) i(`kw/${e}`, !0, !1);
		for (let [e, i] of Object.entries(this.state.fields(n, "kw/"))) i === !0 && !a.has(e.slice(3)) && !t && r.push([
			n,
			e,
			!1
		]);
		r.some(([, e]) => e === "rating" || e === "flag" || e === "label") && this.opts.autoStage() && Ne(this.state.value(n, "stage")) < Ne("culled") && r.push([
			n,
			"stage",
			"culled"
		]), r.length && this.opts.engine.record(r, { [n]: Fe(e) });
	}
	async recordEdit(e, t = !1) {
		let n = this.opts.catalog.photos().find((t) => t.id === e);
		if (!n) return;
		let r = await this.opts.catalog.getEditState(e), i = r?.stack[r.currentIndex];
		if (!i) return;
		let a = Pe(n);
		if (t && Object.keys(this.state.fields(a, "e/")).length) return;
		let o = [], s = !1, c = (e, t) => {
			if (!Ie(t)) return;
			let n = k(t);
			n.length > 204800 ? s = !0 : (!this.state.has(a, e) || k(this.state.value(a, e)) !== n) && o.push([
				a,
				e,
				t
			]);
		};
		for (let [e, t] of Object.entries(i.params)) c(`e/p/${e}`, t);
		let l = i.paramBag ?? {};
		for (let [e, t] of Object.entries(l)) c(`e/b/${e}`, t);
		for (let [e, t] of Object.entries(this.state.fields(a, "e/b/"))) t !== null && !(e.slice(4) in l) && o.push([
			a,
			e,
			null
		]);
		s ? this.oversized.add(e) : this.oversized.delete(e), o.length !== 0 && (this.opts.autoStage() && Ne(this.state.value(a, "stage")) < Ne("edited") && o.push([
			a,
			"stage",
			"edited"
		]), this.opts.engine.record(o, { [a]: Fe(n) }));
	}
	markExported(e) {
		let t = this.opts.catalog.photos().find((t) => t.id === e);
		if (!t || !this.opts.autoStage()) return;
		let n = Pe(t);
		this.state.value(n, "stage") !== "exported" && this.opts.engine.record([[
			n,
			"stage",
			"exported"
		]], { [n]: Fe(t) });
	}
	setStage(e, t) {
		for (let n of e) {
			let e = this.opts.catalog.photos().find((e) => e.id === n);
			if (!e) continue;
			let r = Pe(e);
			this.opts.engine.record([[
				r,
				"stage",
				t
			]], { [r]: Fe(e) });
		}
	}
	applied(e, t = !1) {
		if (!this.running) {
			this.startup.push(...e);
			return;
		}
		let n = /* @__PURE__ */ new Set(), r = /* @__PURE__ */ new Set();
		for (let i of e) {
			if (!i.entity.startsWith("p:")) continue;
			let e = this.photoIdFor(i.entity);
			e && (i.field.startsWith("e/") ? t || r.add(e) : n.add(e));
		}
		let i = new Map(this.opts.catalog.photos().map((e) => [e.id, e]));
		for (let e of n) {
			let t = i.get(e);
			t && this.writeRemote(t);
		}
		for (let e of r) this.scheduleEdit(e);
		(n.size || r.size) && this.notify();
	}
	async writeRemote(e) {
		this.writing.set(e.id, (this.writing.get(e.id) ?? 0) + 1);
		try {
			await this.writeValues(e);
		} finally {
			let t = (this.writing.get(e.id) ?? 1) - 1;
			t > 0 ? this.writing.set(e.id, t) : this.writing.delete(e.id), this.scheduleSettle();
		}
	}
	async writeValues(e) {
		let t = this.opts.catalog, n = this.value(e.id, "rating");
		je(n) && n !== e.rating && await t.setRating(e.id, n);
		let r = this.value(e.id, "flag");
		ke(r) && r !== e.flag && await t.setFlag(e.id, r);
		let i = this.value(e.id, "label");
		Ae(i) && i !== e.colorLabel && await t.setColorLabel(e.id, i);
		let a = new Set(e.keywords), o = {};
		for (let t of this.entitiesFor(e.id).reverse()) Object.assign(o, this.state.fields(t, "kw/"));
		for (let [n, r] of Object.entries(o)) {
			let i = n.slice(3);
			r === !0 && !a.has(i) && await t.addKeyword(e.id, i), r === !1 && a.has(i) && await t.removeKeyword(e.id, i);
		}
	}
	scheduleEdit(e) {
		this.editTimers.has(e) || this.editTimers.set(e, setTimeout(() => {
			this.editTimers.delete(e), this.opts.catalog.editingPhotoId() === e ? (this.deferred.add(e), this.notify()) : this.applyEdit(e);
		}, this.opts.settleMs ?? 250));
	}
	async applyEdit(e) {
		if (this.deferred.delete(e), !(this.keyFor(e) ?? this.entitiesFor(e)[0])) return;
		let t = {};
		for (let n of [...this.entitiesFor(e)].reverse()) Object.assign(t, this.state.fields(n, "e/"));
		let n = Re(Object.fromEntries(Object.entries(t).filter(([e]) => e.startsWith("e/p/"))), "e/p/"), r = Re(Object.fromEntries(Object.entries(t).filter(([e]) => e.startsWith("e/b/"))), "e/b/"), i = await this.opts.catalog.getEditState(e), a = i?.stack[i.currentIndex], o;
		if (a) o = {
			...a.params,
			...n
		};
		else if (Le(n)) o = n;
		else return;
		let s = { ...a?.paramBag ?? {} };
		for (let [e, t] of Object.entries(r)) t === null ? delete s[e] : s[e] = t;
		if (a && k(a.params) === k(o) && k(a.paramBag ?? {}) === k(s)) {
			this.notify();
			return;
		}
		let c = {
			timestamp: (this.opts.now ?? Date.now)(),
			label: this.opts.stepLabel(),
			params: o,
			paramBag: s
		}, l = i ? [...i.stack.slice(0, i.currentIndex + 1), c] : [c];
		await this.opts.catalog.putEditState({
			photoId: e,
			stack: l,
			currentIndex: l.length - 1
		}), this.notify();
	}
	flushDeferred() {
		let e = this.opts.catalog.editingPhotoId();
		for (let t of [...this.deferred]) t !== e && this.applyEdit(t);
	}
}, Be = /^c:([0-9a-f]{8})$/;
function Ve(e) {
	let t = /* @__PURE__ */ new Map();
	for (let n of e.entityKeys("p:")) for (let [r, i] of Object.entries(e.fields(n, "col/"))) i === !0 && t.set(r.slice(4), (t.get(r.slice(4)) ?? 0) + 1);
	let n = [];
	for (let r of e.entityKeys("c:")) {
		let i = Be.exec(r)?.[1], a = e.value(r, "name");
		i && e.value(r, "deleted") !== !0 && typeof a == "string" && n.push({
			id: i,
			name: a,
			count: t.get(i) ?? 0
		});
	}
	return n.sort((e, t) => e.name.localeCompare(t.name));
}
function He(e, t) {
	let n = [...crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(4))].map((e) => e.toString(16).padStart(2, "0")).join("");
	return e.record([[
		`c:${n}`,
		"name",
		t.trim().slice(0, 120)
	]]), n;
}
function Ue(e, t, n) {
	e.record([[
		`c:${t}`,
		"name",
		n.trim().slice(0, 120)
	]]);
}
function We(e, t) {
	e.record([[
		`c:${t}`,
		"deleted",
		!0
	]]);
}
function Ge(e, t, n, r, i) {
	let a = n.flatMap((t) => {
		let n = e.keyFor(t);
		return n ? [[
			n,
			`col/${r}`,
			i
		]] : [];
	});
	t.record(a);
}
var Ke = (e, t, n) => e.value(t, `col/${n}`) === !0, qe = class {
	upTo = 0;
	extra = /* @__PURE__ */ new Set();
	has(e) {
		return e <= this.upTo || this.extra.has(e);
	}
	add(e) {
		if (!this.has(e)) for (this.extra.add(e); this.extra.delete(this.upTo + 1);) this.upTo++;
	}
}, Je = class e {
	entities = /* @__PURE__ */ new Map();
	seen = /* @__PURE__ */ new Map();
	fingerprints = /* @__PURE__ */ new Map();
	hasSeen(e, t) {
		return this.seen.get(e)?.has(t) ?? !1;
	}
	contiguous(e) {
		return this.seen.get(e)?.upTo ?? 0;
	}
	highest(e) {
		let t = this.seen.get(e);
		return t ? Math.max(t.upTo, ...t.extra) : 0;
	}
	take(e, t, n, r) {
		let i = this.entities.get(e) ?? /* @__PURE__ */ new Map();
		return g(r, i.get(t)?.s) ? (i.set(t, {
			v: n,
			s: r
		}), this.entities.set(e, i), !0) : !1;
	}
	noteFingerprints(e) {
		for (let [t, n] of Object.entries(e)) this.fingerprints.set(t, n);
	}
	apply(e) {
		if (this.hasSeen(e.by, e.seq)) return [];
		let t = this.seen.get(e.by) ?? new qe();
		t.add(e.seq), this.seen.set(e.by, t), this.noteFingerprints(e.fp);
		let n = [];
		for (let [t, r, i] of e.ch) this.take(t, r, i, e.at) && n.push({
			entity: t,
			field: r,
			value: i
		});
		return n;
	}
	applySnapshot(e) {
		this.noteFingerprints(e.fp);
		let t = [];
		for (let [n, r, i, a] of e.regs) this.take(n, r, i, a) && t.push({
			entity: n,
			field: r,
			value: i
		});
		return t;
	}
	registers() {
		let e = [];
		for (let [t, n] of this.entities) for (let [r, i] of n) e.push([
			t,
			r,
			i.v,
			i.s
		]);
		return e;
	}
	value(e, t) {
		return this.entities.get(e)?.get(t)?.v;
	}
	has(e, t) {
		return this.entities.get(e)?.has(t) ?? !1;
	}
	fields(e, t = "") {
		let n = {};
		for (let [r, i] of this.entities.get(e) ?? []) r.startsWith(t) && (n[r] = i.v);
		return n;
	}
	entityKeys(e = "") {
		return [...this.entities.keys()].filter((t) => t.startsWith(e));
	}
	latest() {
		let e;
		for (let t of this.entities.values()) for (let n of t.values()) g(n.s, e) && (e = n.s);
		return e;
	}
	toJSON() {
		let e = {};
		for (let [t, n] of [...this.entities].sort(([e], [t]) => e < t ? -1 : +(e > t))) {
			let r = {};
			for (let [e, t] of [...n].sort(([e], [t]) => e < t ? -1 : +(e > t))) r[e] = [t.v, t.s];
			e[t] = r;
		}
		let t = {};
		for (let [e, n] of this.seen) t[e] = {
			upTo: n.upTo,
			extra: [...n.extra].sort((e, t) => e - t)
		};
		return {
			entities: e,
			seen: t,
			fp: Object.fromEntries(this.fingerprints)
		};
	}
	static fromJSON(t) {
		let n = new e();
		for (let [e, r] of Object.entries(t.entities ?? {})) {
			let t = /* @__PURE__ */ new Map();
			for (let [e, n] of Object.entries(r)) Array.isArray(n) && n.length === 2 && _(n[1]) && t.set(e, {
				v: n[0],
				s: n[1]
			});
			n.entities.set(e, t);
		}
		for (let [e, r] of Object.entries(t.seen ?? {})) {
			let t = new qe();
			t.upTo = Number.isInteger(r.upTo) ? r.upTo : 0;
			for (let e of Array.isArray(r.extra) ? r.extra : []) Number.isInteger(e) && t.extra.add(e);
			n.seen.set(e, t);
		}
		for (let [e, r] of Object.entries(t.fp ?? {})) typeof r == "string" && n.fingerprints.set(e, r);
		return n;
	}
}, Ye = 400, Xe = 200, Ze = 2e3, Qe = 5e3, $e = 5e3, et = class {
	state = new Je();
	opts;
	now;
	clock;
	transport = null;
	cursor = 0;
	seq = 0;
	outbox = [];
	pending = [];
	held = [];
	presence = /* @__PURE__ */ new Map();
	names = /* @__PURE__ */ new Map();
	lastChange = /* @__PURE__ */ new Map();
	own = {
		role: "",
		module: "",
		photo: "",
		editing: !1
	};
	phase = "connecting";
	detail = "";
	rejected = 0;
	work = Promise.resolve();
	publishing = null;
	timers = /* @__PURE__ */ new Set();
	flushTimer = null;
	saveTimer = null;
	presenceTimer = null;
	tickTimer = null;
	presenceTimerEvery = null;
	listeners = /* @__PURE__ */ new Set();
	stopped = !1;
	ready = !1;
	firstJoin = !0;
	constructor(e) {
		this.opts = e, this.now = e.now ?? Date.now, this.clock = new v(e.memberId, this.now);
	}
	get memberId() {
		return this.opts.memberId;
	}
	get realtime() {
		return this.transport?.realtime ?? !1;
	}
	async start() {
		let e = await this.opts.store.load(this.opts.room.roomId);
		this.firstJoin = !e, e && (this.state = Je.fromJSON(e.state), this.cursor = e.cursor, this.outbox = [...e.outbox], this.seq = e.seq), this.clock = new v(this.opts.memberId, this.now, Math.max(e?.clock ?? 0, this.state.latest()?.[0] ?? 0)), this.opts.onLoaded?.();
		let t = this.opts.transport({
			get: () => this.cursor,
			set: (e) => this.setCursor(e)
		});
		this.transport = t, await t.start(this.sink()), await this.idle(), this.seq = Math.max(this.seq, this.state.highest(this.opts.memberId)), this.ready = !0;
		let n = t.realtime ? 15e3 : 3e4;
		this.tickTimer = setInterval(() => this.tick(), $e), this.presenceTimerEvery = setInterval(() => void this.sendPresence(), n), this.flush(), this.publishOutbox(), this.sendPresence(), this.notify();
	}
	async stop() {
		this.flushTimer && clearTimeout(this.flushTimer), this.flushTimer = null, this.flush(), this.stopped = !0;
		for (let e of [this.saveTimer, this.presenceTimer]) e && clearTimeout(e);
		for (let e of this.timers) clearTimeout(e);
		this.tickTimer && clearInterval(this.tickTimer), this.presenceTimerEvery && clearInterval(this.presenceTimerEvery), await this.work, await this.transport?.stop(), await this.save();
	}
	record(e, t = {}) {
		e.length !== 0 && (this.pending.push({
			changes: e,
			fp: t
		}), !this.flushTimer && (this.flushTimer = setTimeout(() => {
			this.flushTimer = null, this.flush();
		}, this.opts.flushMs ?? 100)));
	}
	setPresence(e) {
		let t = e.role === this.own.role && e.module === this.own.module && e.photo === this.own.photo && e.editing === this.own.editing;
		this.own = e, !(t || !this.ready || this.presenceTimer) && (this.presenceTimer = setTimeout(() => {
			this.presenceTimer = null, this.sendPresence();
		}, 150));
	}
	async idle() {
		for (;;) {
			let e = this.work;
			if (await e, this.flushTimer && (clearTimeout(this.flushTimer), this.flushTimer = null, this.flush()), this.publishing && await this.publishing, this.work === e && !this.flushTimer && !this.publishing) return;
		}
	}
	subscribe(e) {
		return this.listeners.add(e), () => this.listeners.delete(e);
	}
	view() {
		let e = this.now(), t = this.realtime ? 9e4 : 24e4, n = this.transport?.links?.() ?? {}, r = this.transport?.kind === "relay" ? "relay" : "folder", i = /* @__PURE__ */ new Set([
			...this.presence.keys(),
			...this.names.keys(),
			...Object.keys(n)
		]);
		i.delete(this.opts.memberId);
		let a = [...i].map((i) => {
			let a = this.presence.get(i)?.presence;
			return {
				id: i,
				name: a?.name || this.names.get(i) || "Someone",
				role: a?.role ?? "",
				module: a?.module ?? "",
				photo: a?.photo ?? "",
				editing: a?.editing ?? !1,
				seenAt: a?.wall ?? null,
				fresh: !!a && Math.abs(e - a.wall) <= t,
				lastChangeAt: this.lastChange.get(i) ?? null,
				link: n[i]?.state === "open" ? "direct" : r,
				connecting: n[i]?.state === "connecting",
				rttMs: n[i]?.state === "open" ? n[i].rttMs : null
			};
		});
		a.sort((e, t) => Number(t.fresh) - Number(e.fresh) || e.name.localeCompare(t.name));
		let o = /* @__PURE__ */ new Map();
		for (let t of this.held) o.set(t.by, Math.max(o.get(t.by) ?? 0, t.at[0] - e));
		return {
			ready: this.ready,
			kind: this.transport?.kind ?? "",
			realtime: this.realtime,
			phase: this.phase,
			detail: this.detail,
			members: a,
			unsent: this.outbox.length + this.pending.length,
			rejected: this.rejected,
			held: [...o].map(([e, t]) => ({
				by: e,
				name: this.names.get(e) || "Someone",
				aheadMs: t
			}))
		};
	}
	tick() {
		this.held.length !== 0 && this.enqueue(async () => {
			let e = this.held.filter((e) => !this.clock.tooFarAhead(e.at));
			if (e.length === 0) return;
			this.held = this.held.filter((t) => !e.includes(t));
			let t = e.flatMap((e) => this.applyOp(e));
			this.afterApplied(t);
		});
	}
	notify() {
		for (let e of this.listeners) e();
	}
	enqueue(e) {
		this.work = this.work.then(e).catch((e) => {
			this.detail = e instanceof Error ? e.message : String(e);
		});
	}
	setCursor(e) {
		this.cursor = e, this.scheduleSave();
	}
	sink() {
		return {
			entries: (e) => this.enqueue(() => this.take(e)),
			presence: (e, t) => this.enqueue(() => this.takePresence(e, t)),
			status: (e) => {
				this.phase = e.phase, this.detail = e.detail ?? "", e.phase === "live" && this.ready && this.publishOutbox(), this.notify();
			},
			reset: () => this.enqueue(() => this.republish()),
			linksChanged: () => this.notify()
		};
	}
	applyOp(e) {
		this.clock.observe(e.at), e.name && this.names.set(e.by, e.name);
		let t = this.state.apply(e);
		return e.by !== this.opts.memberId && this.lastChange.set(e.by, this.now()), t;
	}
	afterApplied(e, t = !1) {
		e.length && this.opts.onApplied?.(e, t), this.scheduleSave(), this.notify();
	}
	async take(e) {
		let t = [];
		for (let n of e) {
			let e = oe(await m(this.opts.room, n.data));
			if (!e || n.origin !== void 0 && e.by !== n.origin) this.rejected++;
			else if (e.kind === "ops") {
				if (this.state.hasSeen(e.by, e.seq)) continue;
				if (this.clock.tooFarAhead(e.at)) {
					this.held.some((t) => t.by === e.by && t.seq === e.seq) || this.held.push(e), e.name && this.names.set(e.by, e.name);
					continue;
				}
				t.push(...this.applyOp(e));
			} else if (e.kind === "state") {
				for (let t of e.regs) this.clock.observe(t[3]);
				t.push(...this.state.applySnapshot(e));
			} else e.by !== this.opts.memberId && (this.presence.set(e.by, {
				presence: e,
				receivedAt: this.now()
			}), e.name && this.names.set(e.by, e.name));
		}
		this.afterApplied(t);
	}
	async takePresence(e, t) {
		let n = oe(await m(this.opts.room, e));
		!n || n.kind !== "presence" || t !== void 0 && n.by !== t ? (this.rejected++, this.notify()) : n.by !== this.opts.memberId && (this.presence.set(n.by, {
			presence: n,
			receivedAt: this.now()
		}), n.name && this.names.set(n.by, n.name), this.notify());
	}
	flush() {
		if (!this.ready || this.stopped || this.pending.length === 0) return;
		let e = this.pending;
		this.pending = [], this.enqueue(async () => {
			let t = e.flatMap((e) => e.changes), n = Object.assign({}, ...e.map((e) => e.fp)), r = [];
			for (let e = 0; e < t.length; e += Ye) {
				let i = t.slice(e, e + Ye), a = new Set(i.map((e) => e[0])), o = {
					v: 1,
					kind: "ops",
					by: this.opts.memberId,
					name: this.opts.name(),
					seq: ++this.seq,
					at: this.clock.next(),
					ch: i,
					fp: Object.fromEntries(Object.entries(n).filter(([e]) => a.has(e)))
				};
				r.push(...this.state.apply(o)), this.outbox.push(await p(this.opts.room, o));
			}
			this.afterApplied(r, !0), this.publishOutbox();
		});
	}
	async republish() {
		let e = this.state.registers(), t = Object.fromEntries(this.state.fingerprints);
		for (let n = 0; n < e.length; n += Ye) {
			let r = e.slice(n, n + Ye), i = new Set(r.map((e) => e[0]));
			this.outbox.push(await p(this.opts.room, {
				v: 1,
				kind: "state",
				by: this.opts.memberId,
				regs: r,
				fp: Object.fromEntries(Object.entries(t).filter(([e]) => i.has(e)))
			}));
		}
		this.scheduleSave(), this.ready && this.publishOutbox();
	}
	publishOutbox() {
		if (this.publishing) return this.publishing;
		let e = this.transport;
		return !e || this.outbox.length === 0 || this.stopped ? Promise.resolve() : (this.publishing = (async () => {
			try {
				for (; this.outbox.length && !this.stopped;) {
					let t = this.outbox.slice(0, Xe);
					await e.publish(t), this.outbox.splice(0, t.length), this.scheduleSave();
				}
			} catch (e) {
				this.detail = e instanceof Error ? e.message : String(e), this.later(() => void this.publishOutbox(), Qe);
			} finally {
				this.publishing = null, this.notify();
			}
		})(), this.publishing);
	}
	async sendPresence() {
		if (!this.transport || this.stopped) return;
		let e = {
			v: 1,
			kind: "presence",
			by: this.opts.memberId,
			name: this.opts.name(),
			role: this.own.role,
			module: this.own.module,
			photo: this.own.photo,
			editing: this.own.editing,
			wall: this.now(),
			app: this.opts.appVersion ?? ""
		};
		try {
			await this.transport.publishPresence(await p(this.opts.room, e));
		} catch {}
	}
	later(e, t) {
		if (this.stopped) return;
		let n = setTimeout(() => {
			this.timers.delete(n), e();
		}, t);
		this.timers.add(n);
	}
	scheduleSave() {
		this.saveTimer || this.stopped || (this.saveTimer = setTimeout(() => {
			this.saveTimer = null, this.save();
		}, Ze));
	}
	async save() {
		let e = {
			state: this.state.toJSON(),
			cursor: this.cursor,
			outbox: this.outbox,
			seq: this.seq,
			clock: this.clock.lastAt
		};
		await this.opts.store.save(this.opts.room.roomId, e);
	}
}, tt = /^[0-9a-f]{16}$/, nt = /^ops-(\d{6})(.*)\.log$/, rt = /^h1 (\d+)$/, it = "presence.log", at = "signal.log", ot = (e) => `ops-${String(e).padStart(6, "0")}.log`;
function st(e) {
	if (/^[.~]/.test(e) || /\.tmp$/i.test(e)) return null;
	let t = nt.exec(e);
	return t ? Number(t[1]) : null;
}
function ct(e) {
	let t = e.lastIndexOf("\n");
	return t === -1 ? {
		lines: [],
		length: 0
	} : {
		lines: e.slice(0, t).split("\n").map((e) => e.replace(/\r$/, "")),
		length: t + 1
	};
}
var lt = class {
	kind = "folder";
	realtime = !1;
	opts;
	sink = null;
	members = null;
	own = null;
	progress = /* @__PURE__ */ new Map();
	segment = 1;
	segmentText = "";
	segmentLines = 0;
	segmentEntries = 0;
	writes = Promise.resolve();
	signals = [];
	timer = null;
	polling = null;
	stopped = !1;
	constructor(e) {
		this.opts = {
			...e,
			pollMs: e.pollMs ?? 1500,
			maxSegmentLines: e.maxSegmentLines ?? 1e3,
			maxSegmentBytes: e.maxSegmentBytes ?? 262144
		};
	}
	async start(e) {
		this.sink = e, this.stopped = !1, e.status({ phase: "connecting" });
		try {
			await this.openOwn();
		} catch (t) {
			e.status({
				phase: "problem",
				detail: t instanceof Error ? t.message : String(t)
			});
		}
		await this.poll(), this.schedule();
	}
	async stop() {
		this.stopped = !0, this.timer && clearTimeout(this.timer), this.timer = null, await this.writes;
	}
	publish(e) {
		let t = this.writes.then(() => this.append(e));
		return this.writes = t.catch(() => {}), t;
	}
	publishPresence(e) {
		let t = this.writes.then(async () => {
			await (await this.ownFolder()).writeText(it, `${e}\n`);
		});
		return this.writes = t.catch(() => {}), t;
	}
	publishSignal(e) {
		this.signals = [...this.signals, e].slice(-8);
		let t = `${this.signals.join("\n")}\n`, n = this.writes.then(async () => (await this.ownFolder()).writeText(at, t));
		return this.writes = n.catch(() => {}), n;
	}
	poll() {
		return this.polling ||= this.readAll().finally(() => this.polling = null), this.polling;
	}
	schedule() {
		this.stopped || this.opts.pollMs <= 0 || (this.timer = setTimeout(() => {
			this.poll().finally(() => this.schedule());
		}, this.opts.pollMs));
	}
	async membersFolder() {
		if (this.members) return this.members;
		let e = await (await (await this.opts.root.folder("studio-collab", !0))?.folder(this.opts.roomId, !0))?.folder("members", !0);
		if (!e) throw Error("Couldn't make the room's folder");
		return this.members = e, e;
	}
	async ownFolder() {
		if (this.own) return this.own;
		let e = await (await this.membersFolder()).folder(this.opts.memberId, !0);
		if (!e) throw Error("Couldn't make this computer's folder in the room");
		return this.own = e, e;
	}
	async openOwn() {
		let e = await this.ownFolder(), t = (await e.list()).filter((e) => e.kind === "file").map((e) => nt.exec(e.name)?.[2] === "" ? st(e.name) : null).filter((e) => e !== null);
		this.segment = t.length ? Math.max(...t) : 1;
		let { lines: n } = ct(await e.readText(ot(this.segment)) ?? "");
		this.segmentText = n.length ? `${n.join("\n")}\n` : "", this.segmentLines = n.length, this.segmentEntries = n.filter((e) => !rt.test(e)).length;
	}
	async append(e) {
		if (e.length === 0) return;
		let t = await this.ownFolder();
		for (let n of e) {
			if (this.segmentEntries >= this.opts.maxSegmentLines || this.segmentEntries > 0 && this.segmentText.length + n.length + 1 > this.opts.maxSegmentBytes) {
				await t.writeText(ot(this.segment), this.segmentText);
				let e = this.segmentLines;
				this.segment++, this.segmentText = `h1 ${e}\n`, this.segmentLines = 1, this.segmentEntries = 0;
			}
			this.segmentText += `${n}\n`, this.segmentLines++, this.segmentEntries++;
		}
		await t.writeText(ot(this.segment), this.segmentText);
	}
	async readAll() {
		let e = this.sink;
		if (e) try {
			let t = await this.membersFolder();
			for (let n of await t.list()) {
				if (n.kind !== "directory" || !tt.test(n.name)) continue;
				let r = await t.folder(n.name, !1);
				r && await this.readMember(n.name, r, e);
			}
			this.stopped || e.status({ phase: "live" });
		} catch (t) {
			this.members = null, this.own = null, e.status({
				phase: "problem",
				detail: t instanceof Error ? t.message : String(t)
			});
		}
	}
	async readMember(e, t, n) {
		let r = this.progress.get(e) ?? {
			files: /* @__PURE__ */ new Map(),
			closedAt: /* @__PURE__ */ new Map(),
			presence: null,
			signals: /* @__PURE__ */ new Set()
		};
		this.progress.set(e, r);
		let i = ct(await t.readText(it) ?? "").lines.at(-1) ?? null;
		if (i && i !== r.presence && (r.presence = i, n.presence(i, e)), n.signal && e !== this.opts.memberId) {
			let i = ct(await t.readText(at) ?? "").lines.filter(Boolean);
			for (let t of i) r.signals.has(t) || n.signal(t, e);
			r.signals = new Set(i);
		}
		let a = (await t.list()).filter((e) => e.kind === "file").map((e) => ({
			name: e.name,
			segment: st(e.name)
		})).filter((e) => e.segment !== null).sort((e, t) => e.segment - t.segment || (e.name < t.name ? -1 : 1));
		for (let i of a) {
			let a = r.files.get(i.name) ?? {
				lines: 0,
				length: 0,
				done: !1
			};
			if (r.files.set(i.name, a), a.done) continue;
			let o = await t.readText(i.name);
			if (o === null) continue;
			o.length < a.length && (a.lines = 0, a.length = 0);
			let { lines: s, length: c } = ct(o), l = [];
			for (let t of s.slice(a.lines)) {
				let n = rt.exec(t);
				n ? r.closedAt.set(i.segment - 1, Number(n[1])) : t && l.push({
					data: t,
					origin: e
				});
			}
			a.lines = Math.max(a.lines, s.length), a.length = c, l.length && n.entries(l);
		}
		for (let e of a) {
			let t = r.files.get(e.name), n = r.closedAt.get(e.segment);
			t && n !== void 0 && t.lines >= n && (t.done = !0);
		}
	}
}, ut = 3e4, dt = 3e4, ft = "The relay turned this room down: the room code doesn't match the one the room was opened with on this relay.";
function pt(e) {
	return typeof e == "object" && !!e && "seq" in e && "data" in e && typeof e.seq == "number" && typeof e.data == "string";
}
var mt = (e) => Array.isArray(e) ? e.filter(pt) : [];
function ht(e) {
	if (typeof e != "string") return null;
	try {
		let t = JSON.parse(e);
		return typeof t == "object" && t && "type" in t && typeof t.type == "string" ? {
			...t,
			type: t.type
		} : null;
	} catch {
		return null;
	}
}
var gt = (e) => new Promise((t) => setTimeout(t, e)), _t = class {
	kind = "relay";
	realtime = !0;
	opts;
	base;
	sink = null;
	stopped = !1;
	fatal = !1;
	retry;
	socket = null;
	connected = !1;
	nextRef = 1;
	pending = /* @__PURE__ */ new Map();
	presenceSeen = /* @__PURE__ */ new Map();
	abort = new AbortController();
	pinger = null;
	reconnectTimer = null;
	constructor(e) {
		this.opts = {
			...e,
			retryMs: e.retryMs ?? [1e3, 3e4],
			pollWaitS: e.pollWaitS ?? 25
		}, this.base = e.baseUrl.replace(/\/+$/, ""), this.retry = this.opts.retryMs[0];
	}
	roomUrl(e) {
		return `${this.base}/v1/rooms/${this.opts.roomId}/${e}`;
	}
	start(e) {
		return this.sink = e, this.stopped = !1, e.status({ phase: "connecting" }), new Promise((e) => {
			this.opts.mode === "socket" ? this.connect(e) : this.pollLoop(e);
		});
	}
	async stop() {
		this.stopped = !0, this.abort.abort(), this.pinger && clearInterval(this.pinger), this.reconnectTimer && clearTimeout(this.reconnectTimer), this.socket?.close(1e3, "Bye"), this.socket = null, this.failPending(/* @__PURE__ */ Error("Stopped"));
	}
	async publish(e) {
		if (e.length === 0) return;
		if (this.opts.mode === "poll") {
			let t = await this.opts.fetch(this.roomUrl("entries"), {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({ entries: e })
			});
			if (!t.ok) throw Error(await this.problemOf(t));
			return;
		}
		let t = this.socket;
		if (!t || !this.connected) throw Error("Not connected to the relay");
		let n = this.nextRef++;
		await new Promise((r, i) => {
			let a = setTimeout(() => {
				this.pending.delete(n), i(/* @__PURE__ */ Error("The relay didn't answer"));
			}, ut);
			this.pending.set(n, {
				resolve: () => {
					clearTimeout(a), r();
				},
				reject: (e) => {
					clearTimeout(a), i(e);
				}
			}), t.send(JSON.stringify({
				type: "push",
				ref: n,
				entries: e
			}));
		});
	}
	async publishPresence(e) {
		if (this.opts.mode === "poll") {
			let t = await this.opts.fetch(this.roomUrl("presence"), {
				method: "POST",
				headers: this.headers(),
				body: JSON.stringify({
					member: this.opts.memberId,
					data: e
				})
			});
			if (!t.ok) throw Error(await this.problemOf(t));
		} else this.socket && this.connected && this.socket.send(JSON.stringify({
			type: "presence",
			data: e
		}));
	}
	async publishSignal(e) {
		this.socket && this.connected && this.socket.send(JSON.stringify({
			type: "signal",
			data: e
		}));
	}
	headers() {
		return {
			authorization: `Bearer ${this.opts.token}`,
			"content-type": "application/json"
		};
	}
	async problemOf(e) {
		if (e.status === 401) return ft;
		try {
			let t = await e.json();
			if (typeof t == "object" && t && "message" in t && typeof t.message == "string") return t.message;
		} catch {}
		return `The relay answered ${e.status}`;
	}
	deliver(e) {
		if (e.length === 0) return;
		let t = e.map((e) => ({ data: e.data }));
		this.opts.cursor.set(Math.max(this.opts.cursor.get(), ...e.map((e) => e.seq))), this.sink?.entries(t);
	}
	presence(e, t) {
		typeof e == "string" && typeof t == "string" && e !== this.opts.memberId && this.presenceSeen.get(e) !== t && (this.presenceSeen.set(e, t), this.sink?.presence(t, e));
	}
	reset() {
		this.opts.cursor.set(0), this.sink?.reset?.();
	}
	failPending(e) {
		for (let t of this.pending.values()) t.reject(e);
		this.pending.clear();
	}
	backoff() {
		let e = this.retry;
		return this.retry = Math.min(this.retry * 2, this.opts.retryMs[1]), e;
	}
	connect(e) {
		let t = this.opts.openSocket;
		if (!t) {
			this.sink?.status({
				phase: "problem",
				detail: "Live connections aren't available"
			}), e();
			return;
		}
		let n = -1, r;
		try {
			r = t(`${this.base.replace(/^http/i, "ws")}/v1/rooms/${this.opts.roomId}/socket`);
		} catch (t) {
			this.sink?.status({
				phase: "problem",
				detail: t instanceof Error ? t.message : String(t)
			}), e();
			return;
		}
		this.socket = r;
		let i = () => {
			n >= 0 && this.opts.cursor.get() >= n && e();
		};
		r.addEventListener("open", () => {
			r.send(JSON.stringify({
				type: "hello",
				token: this.opts.token,
				after: this.opts.cursor.get(),
				member: this.opts.memberId
			}));
		}), r.addEventListener("message", (e) => {
			let t = ht(e.data);
			if (t) {
				if (t.type === "welcome") this.connected = !0, this.retry = this.opts.retryMs[0], n = typeof t.head == "number" ? t.head : 0, this.sink?.status({ phase: "live" }), this.pinger && clearInterval(this.pinger), this.pinger = setInterval(() => r.send(JSON.stringify({ type: "ping" })), dt), i();
				else if (t.type === "entries") this.deliver(mt(t.entries)), i();
				else if (t.type === "reset") n = typeof t.head == "number" ? t.head : 0, this.reset(), i();
				else if (t.type === "presence") this.presence(t.member, t.data);
				else if (t.type === "signal") typeof t.data == "string" && typeof t.member == "string" && this.sink?.signal?.(t.data, t.member);
				else if (t.type === "ack" && typeof t.ref == "number") this.pending.get(t.ref)?.resolve(), this.pending.delete(t.ref);
				else if (t.type === "error") {
					let e = typeof t.code == "string" ? t.code : "error";
					typeof t.ref == "number" && (this.pending.get(t.ref)?.reject(Error(e)), this.pending.delete(t.ref)), e === "auth" ? (this.fatal = !0, this.sink?.status({
						phase: "problem",
						detail: ft
					})) : e === "room-full" && this.sink?.status({
						phase: "problem",
						detail: "The relay's room is full"
					});
				}
			}
		}), r.addEventListener("close", () => {
			this.socket === r && (this.socket = null), this.connected = !1, this.pinger && clearInterval(this.pinger), this.failPending(/* @__PURE__ */ Error("The connection to the relay closed")), e(), !(this.stopped || this.fatal) && (this.sink?.status({
				phase: "offline",
				detail: "Reconnecting to the relay"
			}), this.reconnectTimer = setTimeout(() => this.connect(() => {}), this.backoff()));
		});
	}
	async pollLoop(e) {
		let t = !0;
		for (; !this.stopped && !this.fatal;) try {
			let n = this.opts.cursor.get(), r = t ? 0 : this.opts.pollWaitS, i = await this.opts.fetch(`${this.roomUrl("entries")}?after=${n}&wait=${r}`, {
				method: "GET",
				headers: this.headers(),
				timeoutMs: (r + 15) * 1e3,
				signal: this.abort.signal
			});
			if (i.status === 401) {
				this.fatal = !0, this.sink?.status({
					phase: "problem",
					detail: ft
				});
				break;
			}
			if (!i.ok) throw Error(await this.problemOf(i));
			let a = await i.json();
			if (typeof a != "object" || !a) throw Error("The relay sent something unreadable");
			if (("head" in a && typeof a.head == "number" ? a.head : 0) < n) {
				this.reset();
				continue;
			}
			if (this.deliver(mt("entries" in a ? a.entries : [])), "presence" in a && Array.isArray(a.presence)) for (let e of a.presence) typeof e == "object" && e && "member" in e && "data" in e && this.presence(e.member, e.data);
			this.retry = this.opts.retryMs[0], this.sink?.status({ phase: "live" }), "more" in a && a.more === !0 || (t = !1, e());
		} catch (t) {
			if (this.stopped) break;
			this.sink?.status({
				phase: "offline",
				detail: t instanceof Error ? t.message : String(t)
			}), e(), await gt(this.backoff());
		}
		e();
	}
}, vt = [
	"hello",
	"offer",
	"answer"
], yt = (e, t) => typeof e == "string" && e.length <= t;
function bt(e) {
	if (typeof e != "object" || !e || Array.isArray(e) || !("v" in e) || e.v !== 1 || !("kind" in e) || e.kind !== "signal") return null;
	let t = "by" in e ? e.by : void 0, n = "to" in e ? e.to : void 0, r = "type" in e ? e.type : void 0, i = "session" in e ? e.session : void 0, a = "peerSession" in e ? e.peerSession : void 0, o = "sdp" in e ? e.sdp : void 0, s = "at" in e ? e.at : void 0;
	if (!yt(t, 64) || t === "" || !yt(n, 64) || !yt(i, 64) || i === "" || !yt(a, 64) || !yt(o, 65536) || typeof s != "number" || !Number.isFinite(s)) return null;
	let c = vt.find((e) => e === r);
	return c ? {
		v: 1,
		kind: "signal",
		by: t,
		to: n,
		type: c,
		session: i,
		peerSession: a,
		sdp: o,
		at: s
	} : null;
}
var xt = (e, t) => p(e, t);
async function St(e, t, n) {
	let r = bt(await m(e, t));
	return !r || Math.abs(n - r.at) > 3e5 ? null : r;
}
async function Ct(e) {
	let t = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(e));
	return [...new Uint8Array(t)].map((e) => e.toString(16).padStart(2, "0")).join("");
}
var wt = (e, t) => Ct(`studio-collab/signal/1/${e}/${Math.floor(t / 864e5)}`), Tt = class {
	buses;
	seen = /* @__PURE__ */ new Map();
	constructor(e) {
		this.buses = e;
	}
	start(e, t) {
		let n = (e) => {
			let n = Date.now();
			for (let [e, t] of this.seen) n - t > 3e5 && this.seen.delete(e);
			this.seen.has(e) || (this.seen.set(e, n), t(e));
		};
		for (let t of this.buses) t.start(e, n);
	}
	retopic(e) {
		for (let t of this.buses) t.retopic(e);
	}
	send(e) {
		this.seen.set(e, Date.now());
		for (let t of this.buses) t.send(e);
	}
	phases() {
		return this.buses.map((e) => ({
			name: e.name,
			phase: e.phase()
		}));
	}
	stop() {
		for (let e of this.buses) e.stop();
	}
}, Et = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }, { urls: "stun:stun.cloudflare.com:3478" }];
function Dt(e) {
	if (typeof e != "string") return null;
	try {
		let t = JSON.parse(e);
		if (typeof t != "object" || !t || !("t" in t) || !("d" in t || "n" in t)) return null;
		if (t.t === "e" && "d" in t && Array.isArray(t.d) && t.d.every((e) => typeof e == "string")) return {
			t: "e",
			d: t.d
		};
		if (t.t === "p" && "d" in t && typeof t.d == "string") return {
			t: "p",
			d: t.d
		};
		if ((t.t === "ping" || t.t === "pong") && "n" in t && typeof t.n == "number") return {
			t: t.t,
			n: t.n
		};
	} catch {
		return null;
	}
	return null;
}
var Ot = () => [...crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(8))].map((e) => e.toString(16).padStart(2, "0")).join(""), kt = class {
	opts;
	now;
	session = Ot();
	peers = /* @__PURE__ */ new Map();
	backoff = /* @__PURE__ */ new Map();
	lastDirectedHello = /* @__PURE__ */ new Map();
	helloTimer = null;
	pingTimer = null;
	work = Promise.resolve();
	stopped = !1;
	constructor(e) {
		this.opts = e, this.now = e.now ?? Date.now;
	}
	start() {
		this.stopped = !1, this.hello(""), this.helloTimer = setInterval(() => void this.hello(""), this.opts.helloEveryMs ?? 15e3), this.pingTimer = setInterval(() => this.ping(), 5e3);
	}
	stop() {
		this.stopped = !0, this.helloTimer && clearInterval(this.helloTimer), this.pingTimer && clearInterval(this.pingTimer);
		for (let e of [...this.peers.keys()]) this.drop(e);
	}
	receive(e) {
		this.work = this.work.then(() => this.handle(e)).catch(() => {});
	}
	async settled() {
		await this.work;
	}
	broadcastEntries(e) {
		this.sendAll(JSON.stringify({
			t: "e",
			d: e
		}));
	}
	broadcastPresence(e) {
		this.sendAll(JSON.stringify({
			t: "p",
			d: e
		}));
	}
	links() {
		let e = {};
		for (let [t, n] of this.peers) e[t] = {
			state: n.state,
			rttMs: n.rttMs
		};
		return e;
	}
	sendAll(e) {
		for (let t of this.peers.values()) t.state === "open" && t.channel?.readyState === "open" && t.channel.send(e);
	}
	signal(e) {
		return xt(this.opts.room, {
			v: 1,
			kind: "signal",
			by: this.opts.memberId,
			session: this.session,
			at: this.now(),
			...e
		}).then((e) => this.opts.send(e));
	}
	hello(e) {
		return this.stopped ? Promise.resolve() : this.signal({
			to: e,
			type: "hello",
			peerSession: "",
			sdp: ""
		});
	}
	async handle(e) {
		if (this.stopped) return;
		let t = await St(this.opts.room, e, this.now());
		if (!(!t || t.by === this.opts.memberId || t.to && t.to !== this.opts.memberId)) {
			if (t.type === "hello") return this.onHello(t);
			if (t.type === "offer" && t.peerSession === this.session) return this.onOffer(t);
			if (t.type === "answer" && t.peerSession === this.session) return this.onAnswer(t);
		}
	}
	async onHello(e) {
		let t = this.peers.get(e.by);
		if (t && t.theirSession === e.session) return;
		t && this.drop(e.by);
		let n = this.backoff.get(e.by);
		if (n && this.now() < n.until) return;
		if (this.opts.memberId < e.by) return this.offer(e.by, e.session);
		let r = this.lastDirectedHello.get(e.by) ?? 0;
		this.now() - r < 3e3 || (this.lastDirectedHello.set(e.by, this.now()), await this.hello(e.by));
	}
	newPeer(e, t) {
		let n = this.opts.createPeer({ iceServers: this.opts.iceServers }), r = {
			member: e,
			theirSession: t,
			pc: n,
			channel: null,
			state: "connecting",
			rttMs: null,
			timer: null
		};
		return this.peers.set(e, r), r.timer = setTimeout(() => {
			this.peers.get(e) === r && r.state !== "open" && this.fail(e);
		}, this.opts.connectMs ?? 2e4), n.on("connectionstatechange", () => {
			this.peers.get(e) === r && n.connectionState === "failed" && this.fail(e);
		}), this.opts.onChange?.(), r;
	}
	wire(e, t) {
		e.channel = t;
		let n = () => {
			this.peers.get(e.member) === e && (e.state = "open", e.timer && clearTimeout(e.timer), this.backoff.delete(e.member), this.ping(), this.opts.onChange?.());
		};
		t.readyState === "open" ? n() : t.on("open", n), t.on("close", () => {
			this.peers.get(e.member) === e && (this.drop(e.member), this.opts.onChange?.());
		}), t.onMessage((n) => {
			let r = Dt(n);
			r && (r.t === "e" ? this.opts.onEntries(r.d, e.member) : r.t === "p" ? this.opts.onPresence(r.d, e.member) : r.t === "ping" ? t.send(JSON.stringify({
				t: "pong",
				n: r.n
			})) : (e.rttMs = Math.max(0, Math.round(this.now() - r.n)), this.opts.onChange?.()));
		});
	}
	ping() {
		this.sendAll(JSON.stringify({
			t: "ping",
			n: this.now()
		}));
	}
	async gathered(e) {
		e.iceGatheringState !== "complete" && await new Promise((t) => {
			let n = setTimeout(t, this.opts.gatherMs ?? 4e3);
			e.on("icegatheringstatechange", () => {
				e.iceGatheringState === "complete" && (clearTimeout(n), t());
			});
		});
	}
	async offer(e, t) {
		let n = this.newPeer(e, t);
		this.wire(n, n.pc.createDataChannel("studio-collab", { ordered: !0 })), await n.pc.setLocalDescription(await n.pc.createOffer()), await this.gathered(n.pc);
		let r = n.pc.localDescription?.sdp;
		this.peers.get(e) === n && r && await this.signal({
			to: e,
			type: "offer",
			peerSession: t,
			sdp: r
		});
	}
	async onOffer(e) {
		this.peers.has(e.by) && this.drop(e.by);
		let t = this.newPeer(e.by, e.session);
		t.pc.onChannel((e) => this.wire(t, e)), await t.pc.setRemoteDescription({
			type: "offer",
			sdp: e.sdp
		}), await t.pc.setLocalDescription(await t.pc.createAnswer()), await this.gathered(t.pc);
		let n = t.pc.localDescription?.sdp;
		this.peers.get(e.by) === t && n && await this.signal({
			to: e.by,
			type: "answer",
			peerSession: e.session,
			sdp: n
		});
	}
	async onAnswer(e) {
		let t = this.peers.get(e.by);
		t && t.theirSession === e.session && t.state !== "open" && await t.pc.setRemoteDescription({
			type: "answer",
			sdp: e.sdp
		});
	}
	fail(e) {
		this.drop(e);
		let t = Math.min((this.backoff.get(e)?.waitMs ?? 15e3) * 2, 3e5);
		this.backoff.set(e, {
			until: this.now() + t,
			waitMs: t
		}), this.opts.onChange?.();
	}
	drop(e) {
		let t = this.peers.get(e);
		if (t) {
			this.peers.delete(e), t.timer && clearTimeout(t.timer);
			try {
				t.channel?.close(), t.pc.close();
			} catch {}
		}
	}
}, At = class {
	durable;
	name;
	receive = null;
	constructor(e) {
		this.durable = e, this.name = e.kind;
	}
	start(e, t) {
		this.receive = t;
	}
	retopic() {}
	send(e) {
		this.durable.publishSignal?.(e).catch(() => {});
	}
	phase() {
		return this.durable.publishSignal ? "live" : "offline";
	}
	stop() {}
}, jt = 36e5, Mt = class {
	kind;
	realtime = !0;
	opts;
	mesh = null;
	mux = null;
	topicTimer = null;
	constructor(e) {
		this.opts = e, this.kind = e.durable.kind;
	}
	async start(e) {
		let { room: t, memberId: n, durable: r } = this.opts, i = this.opts.now ?? Date.now, a = new At(r), o = new Tt([a, ...this.opts.publicBuses]), s = new kt({
			room: t,
			memberId: n,
			send: (e) => o.send(e),
			createPeer: this.opts.createPeer,
			iceServers: this.opts.iceServers,
			onEntries: (t, n) => e.entries(t.map((e) => ({
				data: e,
				origin: n
			}))),
			onPresence: (t, n) => e.presence(t, n),
			onChange: () => e.linksChanged?.(),
			now: i,
			...this.opts.mesh
		});
		this.mesh = s, this.mux = o;
		let c = await wt(t.roomId, i());
		o.start(c, (e) => s.receive(e)), this.topicTimer = setInterval(() => {
			wt(t.roomId, i()).then((e) => {
				e !== c && (c = e, o.retopic(e));
			});
		}, jt), await r.start({
			...e,
			signal: (e) => a.receive?.(e)
		}), s.start();
	}
	publish(e) {
		return this.mesh?.broadcastEntries(e), this.opts.durable.publish(e);
	}
	publishPresence(e) {
		return this.mesh?.broadcastPresence(e), this.opts.durable.publishPresence(e);
	}
	links() {
		return this.mesh?.links() ?? {};
	}
	signalling() {
		return this.mux?.phases() ?? [];
	}
	async stop() {
		this.topicTimer && clearInterval(this.topicTimer), this.mesh?.stop(), this.mux?.stop(), await this.opts.durable.stop();
	}
}, A = typeof globalThis == "object" && "crypto" in globalThis ? globalThis.crypto : void 0;
//#endregion
//#region node_modules/@noble/hashes/esm/utils.js
function Nt(e) {
	return e instanceof Uint8Array || ArrayBuffer.isView(e) && e.constructor.name === "Uint8Array";
}
function Pt(e) {
	if (!Number.isSafeInteger(e) || e < 0) throw Error("positive integer expected, got " + e);
}
function j(e, ...t) {
	if (!Nt(e)) throw Error("Uint8Array expected");
	if (t.length > 0 && !t.includes(e.length)) throw Error("Uint8Array expected of length " + t + ", got length=" + e.length);
}
function Ft(e) {
	if (typeof e != "function" || typeof e.create != "function") throw Error("Hash should be wrapped by utils.createHasher");
	Pt(e.outputLen), Pt(e.blockLen);
}
function It(e, t = !0) {
	if (e.destroyed) throw Error("Hash instance has been destroyed");
	if (t && e.finished) throw Error("Hash#digest() has already been called");
}
function Lt(e, t) {
	j(e);
	let n = t.outputLen;
	if (e.length < n) throw Error("digestInto() expects output buffer of length at least " + n);
}
function Rt(...e) {
	for (let t = 0; t < e.length; t++) e[t].fill(0);
}
function zt(e) {
	return new DataView(e.buffer, e.byteOffset, e.byteLength);
}
function M(e, t) {
	return e << 32 - t | e >>> t;
}
var Bt = typeof Uint8Array.from([]).toHex == "function" && typeof Uint8Array.fromHex == "function", Vt = /* @__PURE__ */ Array.from({ length: 256 }, (e, t) => t.toString(16).padStart(2, "0"));
function N(e) {
	if (j(e), Bt) return e.toHex();
	let t = "";
	for (let n = 0; n < e.length; n++) t += Vt[e[n]];
	return t;
}
var P = {
	_0: 48,
	_9: 57,
	A: 65,
	F: 70,
	a: 97,
	f: 102
};
function Ht(e) {
	if (e >= P._0 && e <= P._9) return e - P._0;
	if (e >= P.A && e <= P.F) return e - (P.A - 10);
	if (e >= P.a && e <= P.f) return e - (P.a - 10);
}
function Ut(e) {
	if (typeof e != "string") throw Error("hex string expected, got " + typeof e);
	if (Bt) return Uint8Array.fromHex(e);
	let t = e.length, n = t / 2;
	if (t % 2) throw Error("hex string expected, got unpadded hex of length " + t);
	let r = new Uint8Array(n);
	for (let t = 0, i = 0; t < n; t++, i += 2) {
		let n = Ht(e.charCodeAt(i)), a = Ht(e.charCodeAt(i + 1));
		if (n === void 0 || a === void 0) {
			let t = e[i] + e[i + 1];
			throw Error("hex string expected, got non-hex character \"" + t + "\" at index " + i);
		}
		r[t] = n * 16 + a;
	}
	return r;
}
function Wt(e) {
	if (typeof e != "string") throw Error("string expected");
	return new Uint8Array(new TextEncoder().encode(e));
}
function Gt(e) {
	return typeof e == "string" && (e = Wt(e)), j(e), e;
}
function F(...e) {
	let t = 0;
	for (let n = 0; n < e.length; n++) {
		let r = e[n];
		j(r), t += r.length;
	}
	let n = new Uint8Array(t);
	for (let t = 0, r = 0; t < e.length; t++) {
		let i = e[t];
		n.set(i, r), r += i.length;
	}
	return n;
}
var Kt = class {};
function qt(e) {
	let t = (t) => e().update(Gt(t)).digest(), n = e();
	return t.outputLen = n.outputLen, t.blockLen = n.blockLen, t.create = () => e(), t;
}
function Jt(e = 32) {
	if (A && typeof A.getRandomValues == "function") return A.getRandomValues(new Uint8Array(e));
	if (A && typeof A.randomBytes == "function") return Uint8Array.from(A.randomBytes(e));
	throw Error("crypto.getRandomValues must be defined");
}
//#endregion
//#region node_modules/@noble/hashes/esm/_md.js
function Yt(e, t, n, r) {
	if (typeof e.setBigUint64 == "function") return e.setBigUint64(t, n, r);
	let i = BigInt(32), a = BigInt(4294967295), o = Number(n >> i & a), s = Number(n & a), c = r ? 4 : 0, l = r ? 0 : 4;
	e.setUint32(t + c, o, r), e.setUint32(t + l, s, r);
}
function Xt(e, t, n) {
	return e & t ^ ~e & n;
}
function Zt(e, t, n) {
	return e & t ^ e & n ^ t & n;
}
var Qt = class extends Kt {
	constructor(e, t, n, r) {
		super(), this.finished = !1, this.length = 0, this.pos = 0, this.destroyed = !1, this.blockLen = e, this.outputLen = t, this.padOffset = n, this.isLE = r, this.buffer = new Uint8Array(e), this.view = zt(this.buffer);
	}
	update(e) {
		It(this), e = Gt(e), j(e);
		let { view: t, buffer: n, blockLen: r } = this, i = e.length;
		for (let a = 0; a < i;) {
			let o = Math.min(r - this.pos, i - a);
			if (o === r) {
				let t = zt(e);
				for (; r <= i - a; a += r) this.process(t, a);
			} else n.set(e.subarray(a, a + o), this.pos), this.pos += o, a += o, this.pos === r && (this.process(t, 0), this.pos = 0);
		}
		return this.length += e.length, this.roundClean(), this;
	}
	digestInto(e) {
		It(this), Lt(e, this), this.finished = !0;
		let { buffer: t, view: n, blockLen: r, isLE: i } = this, { pos: a } = this;
		t[a++] = 128, Rt(this.buffer.subarray(a)), this.padOffset > r - a && (this.process(n, 0), a = 0);
		for (let e = a; e < r; e++) t[e] = 0;
		Yt(n, r - 8, BigInt(this.length * 8), i), this.process(n, 0);
		let o = zt(e), s = this.outputLen;
		if (s % 4) throw Error("_sha2: outputLen should be aligned to 32bit");
		let c = s / 4, l = this.get();
		if (c > l.length) throw Error("_sha2: outputLen bigger than state");
		for (let e = 0; e < c; e++) o.setUint32(4 * e, l[e], i);
	}
	digest() {
		let { buffer: e, outputLen: t } = this;
		this.digestInto(e);
		let n = e.slice(0, t);
		return this.destroy(), n;
	}
	_cloneInto(e) {
		e ||= new this.constructor(), e.set(...this.get());
		let { blockLen: t, buffer: n, length: r, finished: i, destroyed: a, pos: o } = this;
		return e.destroyed = a, e.finished = i, e.length = r, e.pos = o, r % t && e.buffer.set(n), e;
	}
	clone() {
		return this._cloneInto();
	}
}, I = /* @__PURE__ */ Uint32Array.from([
	1779033703,
	3144134277,
	1013904242,
	2773480762,
	1359893119,
	2600822924,
	528734635,
	1541459225
]), $t = /* @__PURE__ */ Uint32Array.from([
	1116352408,
	1899447441,
	3049323471,
	3921009573,
	961987163,
	1508970993,
	2453635748,
	2870763221,
	3624381080,
	310598401,
	607225278,
	1426881987,
	1925078388,
	2162078206,
	2614888103,
	3248222580,
	3835390401,
	4022224774,
	264347078,
	604807628,
	770255983,
	1249150122,
	1555081692,
	1996064986,
	2554220882,
	2821834349,
	2952996808,
	3210313671,
	3336571891,
	3584528711,
	113926993,
	338241895,
	666307205,
	773529912,
	1294757372,
	1396182291,
	1695183700,
	1986661051,
	2177026350,
	2456956037,
	2730485921,
	2820302411,
	3259730800,
	3345764771,
	3516065817,
	3600352804,
	4094571909,
	275423344,
	430227734,
	506948616,
	659060556,
	883997877,
	958139571,
	1322822218,
	1537002063,
	1747873779,
	1955562222,
	2024104815,
	2227730452,
	2361852424,
	2428436474,
	2756734187,
	3204031479,
	3329325298
]), L = /* @__PURE__ */ new Uint32Array(64), en = class extends Qt {
	constructor(e = 32) {
		super(64, e, 8, !1), this.A = I[0] | 0, this.B = I[1] | 0, this.C = I[2] | 0, this.D = I[3] | 0, this.E = I[4] | 0, this.F = I[5] | 0, this.G = I[6] | 0, this.H = I[7] | 0;
	}
	get() {
		let { A: e, B: t, C: n, D: r, E: i, F: a, G: o, H: s } = this;
		return [
			e,
			t,
			n,
			r,
			i,
			a,
			o,
			s
		];
	}
	set(e, t, n, r, i, a, o, s) {
		this.A = e | 0, this.B = t | 0, this.C = n | 0, this.D = r | 0, this.E = i | 0, this.F = a | 0, this.G = o | 0, this.H = s | 0;
	}
	process(e, t) {
		for (let n = 0; n < 16; n++, t += 4) L[n] = e.getUint32(t, !1);
		for (let e = 16; e < 64; e++) {
			let t = L[e - 15], n = L[e - 2], r = M(t, 7) ^ M(t, 18) ^ t >>> 3, i = M(n, 17) ^ M(n, 19) ^ n >>> 10;
			L[e] = i + L[e - 7] + r + L[e - 16] | 0;
		}
		let { A: n, B: r, C: i, D: a, E: o, F: s, G: c, H: l } = this;
		for (let e = 0; e < 64; e++) {
			let t = M(o, 6) ^ M(o, 11) ^ M(o, 25), u = l + t + Xt(o, s, c) + $t[e] + L[e] | 0, d = (M(n, 2) ^ M(n, 13) ^ M(n, 22)) + Zt(n, r, i) | 0;
			l = c, c = s, s = o, o = a + u | 0, a = i, i = r, r = n, n = u + d | 0;
		}
		n = n + this.A | 0, r = r + this.B | 0, i = i + this.C | 0, a = a + this.D | 0, o = o + this.E | 0, s = s + this.F | 0, c = c + this.G | 0, l = l + this.H | 0, this.set(n, r, i, a, o, s, c, l);
	}
	roundClean() {
		Rt(L);
	}
	destroy() {
		this.set(0, 0, 0, 0, 0, 0, 0, 0), Rt(this.buffer);
	}
}, tn = /* @__PURE__ */ qt(() => new en()), nn = class extends Kt {
	constructor(e, t) {
		super(), this.finished = !1, this.destroyed = !1, Ft(e);
		let n = Gt(t);
		if (this.iHash = e.create(), typeof this.iHash.update != "function") throw Error("Expected instance of class which extends utils.Hash");
		this.blockLen = this.iHash.blockLen, this.outputLen = this.iHash.outputLen;
		let r = this.blockLen, i = new Uint8Array(r);
		i.set(n.length > r ? e.create().update(n).digest() : n);
		for (let e = 0; e < i.length; e++) i[e] ^= 54;
		this.iHash.update(i), this.oHash = e.create();
		for (let e = 0; e < i.length; e++) i[e] ^= 106;
		this.oHash.update(i), Rt(i);
	}
	update(e) {
		return It(this), this.iHash.update(e), this;
	}
	digestInto(e) {
		It(this), j(e, this.outputLen), this.finished = !0, this.iHash.digestInto(e), this.oHash.update(e), this.oHash.digestInto(e), this.destroy();
	}
	digest() {
		let e = new Uint8Array(this.oHash.outputLen);
		return this.digestInto(e), e;
	}
	_cloneInto(e) {
		e ||= Object.create(Object.getPrototypeOf(this), {});
		let { oHash: t, iHash: n, finished: r, destroyed: i, blockLen: a, outputLen: o } = this;
		return e = e, e.finished = r, e.destroyed = i, e.blockLen = a, e.outputLen = o, e.oHash = t._cloneInto(e.oHash), e.iHash = n._cloneInto(e.iHash), e;
	}
	clone() {
		return this._cloneInto();
	}
	destroy() {
		this.destroyed = !0, this.oHash.destroy(), this.iHash.destroy();
	}
}, rn = (e, t, n) => new nn(e, t).update(n).digest();
rn.create = (e, t) => new nn(e, t);
//#endregion
//#region node_modules/@noble/curves/esm/utils.js
var an = /* @__PURE__ */ BigInt(0), on = /* @__PURE__ */ BigInt(1);
function sn(e, t = "") {
	if (typeof e != "boolean") {
		let n = t && `"${t}"`;
		throw Error(n + "expected boolean, got type=" + typeof e);
	}
	return e;
}
function R(e, t, n = "") {
	let r = Nt(e), i = e?.length, a = t !== void 0;
	if (!r || a && i !== t) {
		let o = n && `"${n}" `, s = a ? ` of length ${t}` : "", c = r ? `length=${i}` : `type=${typeof e}`;
		throw Error(o + "expected Uint8Array" + s + ", got " + c);
	}
	return e;
}
function cn(e) {
	let t = e.toString(16);
	return t.length & 1 ? "0" + t : t;
}
function ln(e) {
	if (typeof e != "string") throw Error("hex string expected, got " + typeof e);
	return e === "" ? an : BigInt("0x" + e);
}
function z(e) {
	return ln(N(e));
}
function un(e) {
	return j(e), ln(N(Uint8Array.from(e).reverse()));
}
function dn(e, t) {
	return Ut(e.toString(16).padStart(t * 2, "0"));
}
function fn(e, t) {
	return dn(e, t).reverse();
}
function B(e, t, n) {
	let r;
	if (typeof t == "string") try {
		r = Ut(t);
	} catch (t) {
		throw Error(e + " must be hex string or Uint8Array, cause: " + t);
	}
	else if (Nt(t)) r = Uint8Array.from(t);
	else throw Error(e + " must be hex string or Uint8Array");
	let i = r.length;
	if (typeof n == "number" && i !== n) throw Error(e + " of length " + n + " expected, got " + i);
	return r;
}
var pn = (e) => typeof e == "bigint" && an <= e;
function mn(e, t, n) {
	return pn(e) && pn(t) && pn(n) && t <= e && e < n;
}
function hn(e, t, n, r) {
	if (!mn(t, n, r)) throw Error("expected valid " + e + ": " + n + " <= n < " + r + ", got " + t);
}
function gn(e) {
	let t = 0;
	for (; e > an; e >>= on, t += 1);
	return t;
}
var _n = (e) => (on << BigInt(e)) - on;
function vn(e, t, n) {
	if (typeof e != "number" || e < 2) throw Error("hashLen must be a number");
	if (typeof t != "number" || t < 2) throw Error("qByteLen must be a number");
	if (typeof n != "function") throw Error("hmacFn must be a function");
	let r = (e) => new Uint8Array(e), i = (e) => Uint8Array.of(e), a = r(e), o = r(e), s = 0, c = () => {
		a.fill(1), o.fill(0), s = 0;
	}, l = (...e) => n(o, a, ...e), u = (e = r(0)) => {
		o = l(i(0), e), a = l(), e.length !== 0 && (o = l(i(1), e), a = l());
	}, d = () => {
		if (s++ >= 1e3) throw Error("drbg: tried 1000 values");
		let e = 0, n = [];
		for (; e < t;) {
			a = l();
			let t = a.slice();
			n.push(t), e += a.length;
		}
		return F(...n);
	};
	return (e, t) => {
		c(), u(e);
		let n;
		for (; !(n = t(d()));) u();
		return c(), n;
	};
}
function yn(e, t, n = {}) {
	if (!e || typeof e != "object") throw Error("expected valid options object");
	function r(t, n, r) {
		let i = e[t];
		if (r && i === void 0) return;
		let a = typeof i;
		if (a !== n || i === null) throw Error(`param "${t}" is invalid: expected ${n}, got ${a}`);
	}
	Object.entries(t).forEach(([e, t]) => r(e, t, !1)), Object.entries(n).forEach(([e, t]) => r(e, t, !0));
}
function bn(e) {
	let t = /* @__PURE__ */ new WeakMap();
	return (n, ...r) => {
		let i = t.get(n);
		if (i !== void 0) return i;
		let a = e(n, ...r);
		return t.set(n, a), a;
	};
}
//#endregion
//#region node_modules/@noble/curves/esm/abstract/modular.js
var V = BigInt(0), H = BigInt(1), U = /* @__PURE__ */ BigInt(2), xn = /* @__PURE__ */ BigInt(3), Sn = /* @__PURE__ */ BigInt(4), Cn = /* @__PURE__ */ BigInt(5), wn = /* @__PURE__ */ BigInt(7), Tn = /* @__PURE__ */ BigInt(8), En = /* @__PURE__ */ BigInt(9), Dn = /* @__PURE__ */ BigInt(16);
function W(e, t) {
	let n = e % t;
	return n >= V ? n : t + n;
}
function G(e, t, n) {
	let r = e;
	for (; t-- > V;) r *= r, r %= n;
	return r;
}
function On(e, t) {
	if (e === V) throw Error("invert: expected non-zero number");
	if (t <= V) throw Error("invert: expected positive modulus, got " + t);
	let n = W(e, t), r = t, i = V, a = H, o = H, s = V;
	for (; n !== V;) {
		let e = r / n, t = r % n, c = i - o * e, l = a - s * e;
		r = n, n = t, i = o, a = s, o = c, s = l;
	}
	if (r !== H) throw Error("invert: does not exist");
	return W(i, t);
}
function kn(e, t, n) {
	if (!e.eql(e.sqr(t), n)) throw Error("Cannot find square root");
}
function An(e, t) {
	let n = (e.ORDER + H) / Sn, r = e.pow(t, n);
	return kn(e, r, t), r;
}
function jn(e, t) {
	let n = (e.ORDER - Cn) / Tn, r = e.mul(t, U), i = e.pow(r, n), a = e.mul(t, i), o = e.mul(e.mul(a, U), i), s = e.mul(a, e.sub(o, e.ONE));
	return kn(e, s, t), s;
}
function Mn(e) {
	let t = Vn(e), n = Nn(e), r = n(t, t.neg(t.ONE)), i = n(t, r), a = n(t, t.neg(r)), o = (e + wn) / Dn;
	return (e, t) => {
		let n = e.pow(t, o), s = e.mul(n, r), c = e.mul(n, i), l = e.mul(n, a), u = e.eql(e.sqr(s), t), d = e.eql(e.sqr(c), t);
		n = e.cmov(n, s, u), s = e.cmov(l, c, d);
		let f = e.eql(e.sqr(s), t), p = e.cmov(n, s, f);
		return kn(e, p, t), p;
	};
}
function Nn(e) {
	if (e < xn) throw Error("sqrt is not defined for small field");
	let t = e - H, n = 0;
	for (; t % U === V;) t /= U, n++;
	let r = U, i = Vn(e);
	for (; zn(i, r) === 1;) if (r++ > 1e3) throw Error("Cannot find square root: probably non-prime P");
	if (n === 1) return An;
	let a = i.pow(r, t), o = (t + H) / U;
	return function(e, r) {
		if (e.is0(r)) return r;
		if (zn(e, r) !== 1) throw Error("Cannot find square root");
		let i = n, s = e.mul(e.ONE, a), c = e.pow(r, t), l = e.pow(r, o);
		for (; !e.eql(c, e.ONE);) {
			if (e.is0(c)) return e.ZERO;
			let t = 1, n = e.sqr(c);
			for (; !e.eql(n, e.ONE);) if (t++, n = e.sqr(n), t === i) throw Error("Cannot find square root");
			let r = H << BigInt(i - t - 1), a = e.pow(s, r);
			i = t, s = e.sqr(a), c = e.mul(c, s), l = e.mul(l, a);
		}
		return l;
	};
}
function Pn(e) {
	return e % Sn === xn ? An : e % Tn === Cn ? jn : e % Dn === En ? Mn(e) : Nn(e);
}
var Fn = [
	"create",
	"isValid",
	"is0",
	"neg",
	"inv",
	"sqrt",
	"sqr",
	"eql",
	"add",
	"sub",
	"mul",
	"pow",
	"div",
	"addN",
	"subN",
	"mulN",
	"sqrN"
];
function In(e) {
	return yn(e, Fn.reduce((e, t) => (e[t] = "function", e), {
		ORDER: "bigint",
		MASK: "bigint",
		BYTES: "number",
		BITS: "number"
	})), e;
}
function Ln(e, t, n) {
	if (n < V) throw Error("invalid exponent, negatives unsupported");
	if (n === V) return e.ONE;
	if (n === H) return t;
	let r = e.ONE, i = t;
	for (; n > V;) n & H && (r = e.mul(r, i)), i = e.sqr(i), n >>= H;
	return r;
}
function Rn(e, t, n = !1) {
	let r = Array(t.length).fill(n ? e.ZERO : void 0), i = t.reduce((t, n, i) => e.is0(n) ? t : (r[i] = t, e.mul(t, n)), e.ONE), a = e.inv(i);
	return t.reduceRight((t, n, i) => e.is0(n) ? t : (r[i] = e.mul(t, r[i]), e.mul(t, n)), a), r;
}
function zn(e, t) {
	let n = (e.ORDER - H) / U, r = e.pow(t, n), i = e.eql(r, e.ONE), a = e.eql(r, e.ZERO), o = e.eql(r, e.neg(e.ONE));
	if (!i && !a && !o) throw Error("invalid Legendre symbol result");
	return i ? 1 : a ? 0 : -1;
}
function Bn(e, t) {
	t !== void 0 && Pt(t);
	let n = t === void 0 ? e.toString(2).length : t;
	return {
		nBitLength: n,
		nByteLength: Math.ceil(n / 8)
	};
}
function Vn(e, t, n = !1, r = {}) {
	if (e <= V) throw Error("invalid field: expected ORDER > 0, got " + e);
	let i, a, o = !1, s;
	if (typeof t == "object" && t) {
		if (r.sqrt || n) throw Error("cannot specify opts in two arguments");
		let e = t;
		e.BITS && (i = e.BITS), e.sqrt && (a = e.sqrt), typeof e.isLE == "boolean" && (n = e.isLE), typeof e.modFromBytes == "boolean" && (o = e.modFromBytes), s = e.allowedLengths;
	} else typeof t == "number" && (i = t), r.sqrt && (a = r.sqrt);
	let { nBitLength: c, nByteLength: l } = Bn(e, i);
	if (l > 2048) throw Error("invalid field: expected ORDER of <= 2048 bytes");
	let u, d = Object.freeze({
		ORDER: e,
		isLE: n,
		BITS: c,
		BYTES: l,
		MASK: _n(c),
		ZERO: V,
		ONE: H,
		allowedLengths: s,
		create: (t) => W(t, e),
		isValid: (t) => {
			if (typeof t != "bigint") throw Error("invalid field element: expected bigint, got " + typeof t);
			return V <= t && t < e;
		},
		is0: (e) => e === V,
		isValidNot0: (e) => !d.is0(e) && d.isValid(e),
		isOdd: (e) => (e & H) === H,
		neg: (t) => W(-t, e),
		eql: (e, t) => e === t,
		sqr: (t) => W(t * t, e),
		add: (t, n) => W(t + n, e),
		sub: (t, n) => W(t - n, e),
		mul: (t, n) => W(t * n, e),
		pow: (e, t) => Ln(d, e, t),
		div: (t, n) => W(t * On(n, e), e),
		sqrN: (e) => e * e,
		addN: (e, t) => e + t,
		subN: (e, t) => e - t,
		mulN: (e, t) => e * t,
		inv: (t) => On(t, e),
		sqrt: a || ((t) => (u ||= Pn(e), u(d, t))),
		toBytes: (e) => n ? fn(e, l) : dn(e, l),
		fromBytes: (t, r = !0) => {
			if (s) {
				if (!s.includes(t.length) || t.length > l) throw Error("Field.fromBytes: expected " + s + " bytes, got " + t.length);
				let e = new Uint8Array(l);
				e.set(t, n ? 0 : e.length - t.length), t = e;
			}
			if (t.length !== l) throw Error("Field.fromBytes: expected " + l + " bytes, got " + t.length);
			let i = n ? un(t) : z(t);
			if (o && (i = W(i, e)), !r && !d.isValid(i)) throw Error("invalid field element: outside of range 0..ORDER");
			return i;
		},
		invertBatch: (e) => Rn(d, e),
		cmov: (e, t, n) => n ? t : e
	});
	return Object.freeze(d);
}
function Hn(e) {
	if (typeof e != "bigint") throw Error("field order must be bigint");
	let t = e.toString(2).length;
	return Math.ceil(t / 8);
}
function Un(e) {
	let t = Hn(e);
	return t + Math.ceil(t / 2);
}
function Wn(e, t, n = !1) {
	let r = e.length, i = Hn(t), a = Un(t);
	if (r < 16 || r < a || r > 1024) throw Error("expected " + a + "-1024 bytes of input, got " + r);
	let o = W(n ? un(e) : z(e), t - H) + H;
	return n ? fn(o, i) : dn(o, i);
}
//#endregion
//#region node_modules/@noble/curves/esm/abstract/curve.js
var Gn = BigInt(0), K = BigInt(1);
function Kn(e, t) {
	let n = t.negate();
	return e ? n : t;
}
function qn(e, t) {
	let n = Rn(e.Fp, t.map((e) => e.Z));
	return t.map((t, r) => e.fromAffine(t.toAffine(n[r])));
}
function Jn(e, t) {
	if (!Number.isSafeInteger(e) || e <= 0 || e > t) throw Error("invalid window size, expected [1.." + t + "], got W=" + e);
}
function Yn(e, t) {
	Jn(e, t);
	let n = Math.ceil(t / e) + 1, r = 2 ** (e - 1), i = 2 ** e;
	return {
		windows: n,
		windowSize: r,
		mask: _n(e),
		maxNumber: i,
		shiftBy: BigInt(e)
	};
}
function Xn(e, t, n) {
	let { windowSize: r, mask: i, maxNumber: a, shiftBy: o } = n, s = Number(e & i), c = e >> o;
	s > r && (s -= a, c += K);
	let l = t * r, u = l + Math.abs(s) - 1, d = s === 0, f = s < 0, p = t % 2 != 0;
	return {
		nextN: c,
		offset: u,
		isZero: d,
		isNeg: f,
		isNegF: p,
		offsetF: l
	};
}
function Zn(e, t) {
	if (!Array.isArray(e)) throw Error("array expected");
	e.forEach((e, n) => {
		if (!(e instanceof t)) throw Error("invalid point at index " + n);
	});
}
function Qn(e, t) {
	if (!Array.isArray(e)) throw Error("array of scalars expected");
	e.forEach((e, n) => {
		if (!t.isValid(e)) throw Error("invalid scalar at index " + n);
	});
}
var $n = /* @__PURE__ */ new WeakMap(), er = /* @__PURE__ */ new WeakMap();
function tr(e) {
	return er.get(e) || 1;
}
function nr(e) {
	if (e !== Gn) throw Error("invalid wNAF");
}
var rr = class {
	constructor(e, t) {
		this.BASE = e.BASE, this.ZERO = e.ZERO, this.Fn = e.Fn, this.bits = t;
	}
	_unsafeLadder(e, t, n = this.ZERO) {
		let r = e;
		for (; t > Gn;) t & K && (n = n.add(r)), r = r.double(), t >>= K;
		return n;
	}
	precomputeWindow(e, t) {
		let { windows: n, windowSize: r } = Yn(t, this.bits), i = [], a = e, o = a;
		for (let e = 0; e < n; e++) {
			o = a, i.push(o);
			for (let e = 1; e < r; e++) o = o.add(a), i.push(o);
			a = o.double();
		}
		return i;
	}
	wNAF(e, t, n) {
		if (!this.Fn.isValid(n)) throw Error("invalid scalar");
		let r = this.ZERO, i = this.BASE, a = Yn(e, this.bits);
		for (let e = 0; e < a.windows; e++) {
			let { nextN: o, offset: s, isZero: c, isNeg: l, isNegF: u, offsetF: d } = Xn(n, e, a);
			n = o, c ? i = i.add(Kn(u, t[d])) : r = r.add(Kn(l, t[s]));
		}
		return nr(n), {
			p: r,
			f: i
		};
	}
	wNAFUnsafe(e, t, n, r = this.ZERO) {
		let i = Yn(e, this.bits);
		for (let e = 0; e < i.windows && n !== Gn; e++) {
			let { nextN: a, offset: o, isZero: s, isNeg: c } = Xn(n, e, i);
			if (n = a, !s) {
				let e = t[o];
				r = r.add(c ? e.negate() : e);
			}
		}
		return nr(n), r;
	}
	getPrecomputes(e, t, n) {
		let r = $n.get(t);
		return r || (r = this.precomputeWindow(t, e), e !== 1 && (typeof n == "function" && (r = n(r)), $n.set(t, r))), r;
	}
	cached(e, t, n) {
		let r = tr(e);
		return this.wNAF(r, this.getPrecomputes(r, e, n), t);
	}
	unsafe(e, t, n, r) {
		let i = tr(e);
		return i === 1 ? this._unsafeLadder(e, t, r) : this.wNAFUnsafe(i, this.getPrecomputes(i, e, n), t, r);
	}
	createCache(e, t) {
		Jn(t, this.bits), er.set(e, t), $n.delete(e);
	}
	hasCache(e) {
		return tr(e) !== 1;
	}
};
function ir(e, t, n, r) {
	let i = t, a = e.ZERO, o = e.ZERO;
	for (; n > Gn || r > Gn;) n & K && (a = a.add(i)), r & K && (o = o.add(i)), i = i.double(), n >>= K, r >>= K;
	return {
		p1: a,
		p2: o
	};
}
function ar(e, t, n, r) {
	Zn(n, e), Qn(r, t);
	let i = n.length, a = r.length;
	if (i !== a) throw Error("arrays of points and scalars must have equal length");
	let o = e.ZERO, s = gn(BigInt(i)), c = 1;
	s > 12 ? c = s - 3 : s > 4 ? c = s - 2 : s > 0 && (c = 2);
	let l = _n(c), u = Array(Number(l) + 1).fill(o), d = Math.floor((t.BITS - 1) / c) * c, f = o;
	for (let e = d; e >= 0; e -= c) {
		u.fill(o);
		for (let t = 0; t < a; t++) {
			let i = r[t], a = Number(i >> BigInt(e) & l);
			u[a] = u[a].add(n[t]);
		}
		let t = o;
		for (let e = u.length - 1, n = o; e > 0; e--) n = n.add(u[e]), t = t.add(n);
		if (f = f.add(t), e !== 0) for (let e = 0; e < c; e++) f = f.double();
	}
	return f;
}
function or(e, t, n) {
	if (t) {
		if (t.ORDER !== e) throw Error("Field.ORDER must match order: Fp == p, Fn == n");
		return In(t), t;
	}
	return Vn(e, { isLE: n });
}
function sr(e, t, n = {}, r) {
	if (r === void 0 && (r = e === "edwards"), !t || typeof t != "object") throw Error(`expected valid ${e} CURVE object`);
	for (let e of [
		"p",
		"n",
		"h"
	]) {
		let n = t[e];
		if (!(typeof n == "bigint" && n > Gn)) throw Error(`CURVE.${e} must be positive bigint`);
	}
	let i = or(t.p, n.Fp, r), a = or(t.n, n.Fn, r), o = [
		"Gx",
		"Gy",
		"a",
		e === "weierstrass" ? "b" : "d"
	];
	for (let e of o) if (!i.isValid(t[e])) throw Error(`CURVE.${e} must be valid field element of CURVE.Fp`);
	return t = Object.freeze(Object.assign({}, t)), {
		CURVE: t,
		Fp: i,
		Fn: a
	};
}
//#endregion
//#region node_modules/@noble/curves/esm/abstract/weierstrass.js
var cr = (e, t) => (e + (e >= 0 ? t : -t) / pr) / t;
function lr(e, t, n) {
	let [[r, i], [a, o]] = t, s = cr(o * e, n), c = cr(-i * e, n), l = e - s * r - c * a, u = -s * i - c * o, d = l < J, f = u < J;
	d && (l = -l), f && (u = -u);
	let p = _n(Math.ceil(gn(n) / 2)) + fr;
	if (l < J || l >= p || u < J || u >= p) throw Error("splitScalar (endomorphism): failed, k=" + e);
	return {
		k1neg: d,
		k1: l,
		k2neg: f,
		k2: u
	};
}
function ur(e) {
	if (![
		"compact",
		"recovered",
		"der"
	].includes(e)) throw Error("Signature format must be \"compact\", \"recovered\", or \"der\"");
	return e;
}
function dr(e, t) {
	let n = {};
	for (let r of Object.keys(t)) n[r] = e[r] === void 0 ? t[r] : e[r];
	return sn(n.lowS, "lowS"), sn(n.prehash, "prehash"), n.format !== void 0 && ur(n.format), n;
}
var q = {
	Err: class extends Error {
		constructor(e = "") {
			super(e);
		}
	},
	_tlv: {
		encode: (e, t) => {
			let { Err: n } = q;
			if (e < 0 || e > 256) throw new n("tlv.encode: wrong tag");
			if (t.length & 1) throw new n("tlv.encode: unpadded data");
			let r = t.length / 2, i = cn(r);
			if (i.length / 2 & 128) throw new n("tlv.encode: long form length too big");
			let a = r > 127 ? cn(i.length / 2 | 128) : "";
			return cn(e) + a + i + t;
		},
		decode(e, t) {
			let { Err: n } = q, r = 0;
			if (e < 0 || e > 256) throw new n("tlv.encode: wrong tag");
			if (t.length < 2 || t[r++] !== e) throw new n("tlv.decode: wrong tlv");
			let i = t[r++], a = !!(i & 128), o = 0;
			if (!a) o = i;
			else {
				let e = i & 127;
				if (!e) throw new n("tlv.decode(long): indefinite length not supported");
				if (e > 4) throw new n("tlv.decode(long): byte length is too big");
				let a = t.subarray(r, r + e);
				if (a.length !== e) throw new n("tlv.decode: length bytes not complete");
				if (a[0] === 0) throw new n("tlv.decode(long): zero leftmost byte");
				for (let e of a) o = o << 8 | e;
				if (r += e, o < 128) throw new n("tlv.decode(long): not minimal encoding");
			}
			let s = t.subarray(r, r + o);
			if (s.length !== o) throw new n("tlv.decode: wrong value length");
			return {
				v: s,
				l: t.subarray(r + o)
			};
		}
	},
	_int: {
		encode(e) {
			let { Err: t } = q;
			if (e < J) throw new t("integer: negative integers are not allowed");
			let n = cn(e);
			if (Number.parseInt(n[0], 16) & 8 && (n = "00" + n), n.length & 1) throw new t("unexpected DER parsing assertion: unpadded hex");
			return n;
		},
		decode(e) {
			let { Err: t } = q;
			if (e[0] & 128) throw new t("invalid signature integer: negative");
			if (e[0] === 0 && !(e[1] & 128)) throw new t("invalid signature integer: unnecessary leading zero");
			return z(e);
		}
	},
	toSig(e) {
		let { Err: t, _int: n, _tlv: r } = q, i = B("signature", e), { v: a, l: o } = r.decode(48, i);
		if (o.length) throw new t("invalid signature: left bytes after parsing");
		let { v: s, l: c } = r.decode(2, a), { v: l, l: u } = r.decode(2, c);
		if (u.length) throw new t("invalid signature: left bytes after parsing");
		return {
			r: n.decode(s),
			s: n.decode(l)
		};
	},
	hexFromSig(e) {
		let { _tlv: t, _int: n } = q, r = t.encode(2, n.encode(e.r)) + t.encode(2, n.encode(e.s));
		return t.encode(48, r);
	}
}, J = BigInt(0), fr = BigInt(1), pr = BigInt(2), mr = BigInt(3), hr = BigInt(4);
function Y(e, t) {
	let { BYTES: n } = e, r;
	if (typeof t == "bigint") r = t;
	else {
		let i = B("private key", t);
		try {
			r = e.fromBytes(i);
		} catch {
			throw Error(`invalid private key: expected ui8a of size ${n}, got ${typeof t}`);
		}
	}
	if (!e.isValidNot0(r)) throw Error("invalid private key: out of range [1..N-1]");
	return r;
}
function gr(e, t = {}) {
	let n = sr("weierstrass", e, t), { Fp: r, Fn: i } = n, a = n.CURVE, { h: o, n: s } = a;
	yn(t, {}, {
		allowInfinityPoint: "boolean",
		clearCofactor: "function",
		isTorsionFree: "function",
		fromBytes: "function",
		toBytes: "function",
		endo: "object",
		wrapPrivateKey: "boolean"
	});
	let { endo: c } = t;
	if (c && (!r.is0(a.a) || typeof c.beta != "bigint" || !Array.isArray(c.basises))) throw Error("invalid endo: expected \"beta\": bigint and \"basises\": array");
	let l = vr(r, i);
	function u() {
		if (!r.isOdd) throw Error("compression is not supported: Field does not have .isOdd()");
	}
	function d(e, t, n) {
		let { x: i, y: a } = t.toAffine(), o = r.toBytes(i);
		return sn(n, "isCompressed"), n ? (u(), F(_r(!r.isOdd(a)), o)) : F(Uint8Array.of(4), o, r.toBytes(a));
	}
	function f(e) {
		R(e, void 0, "Point");
		let { publicKey: t, publicKeyUncompressed: n } = l, i = e.length, a = e[0], o = e.subarray(1);
		if (i === t && (a === 2 || a === 3)) {
			let e = r.fromBytes(o);
			if (!r.isValid(e)) throw Error("bad point: is not on curve, wrong x");
			let t = h(e), n;
			try {
				n = r.sqrt(t);
			} catch (e) {
				let t = e instanceof Error ? ": " + e.message : "";
				throw Error("bad point: is not on curve, sqrt error" + t);
			}
			u();
			let i = r.isOdd(n);
			return (a & 1) == 1 !== i && (n = r.neg(n)), {
				x: e,
				y: n
			};
		}
		if (i === n && a === 4) {
			let e = r.BYTES, t = r.fromBytes(o.subarray(0, e)), n = r.fromBytes(o.subarray(e, e * 2));
			if (!g(t, n)) throw Error("bad point: is not on curve");
			return {
				x: t,
				y: n
			};
		}
		throw Error(`bad point: got length ${i}, expected compressed=${t} or uncompressed=${n}`);
	}
	let p = t.toBytes || d, m = t.fromBytes || f;
	function h(e) {
		let t = r.sqr(e), n = r.mul(t, e);
		return r.add(r.add(n, r.mul(e, a.a)), a.b);
	}
	function g(e, t) {
		let n = r.sqr(t), i = h(e);
		return r.eql(n, i);
	}
	if (!g(a.Gx, a.Gy)) throw Error("bad curve params: generator point");
	let _ = r.mul(r.pow(a.a, mr), hr), v = r.mul(r.sqr(a.b), BigInt(27));
	if (r.is0(r.add(_, v))) throw Error("bad curve params: a or b");
	function y(e, t, n = !1) {
		if (!r.isValid(t) || n && r.is0(t)) throw Error(`bad point coordinate ${e}`);
		return t;
	}
	function b(e) {
		if (!(e instanceof T)) throw Error("ProjectivePoint expected");
	}
	function x(e) {
		if (!c || !c.basises) throw Error("no endo");
		return lr(e, c.basises, i.ORDER);
	}
	let S = bn((e, t) => {
		let { X: n, Y: i, Z: a } = e;
		if (r.eql(a, r.ONE)) return {
			x: n,
			y: i
		};
		let o = e.is0();
		t ??= o ? r.ONE : r.inv(a);
		let s = r.mul(n, t), c = r.mul(i, t), l = r.mul(a, t);
		if (o) return {
			x: r.ZERO,
			y: r.ZERO
		};
		if (!r.eql(l, r.ONE)) throw Error("invZ was invalid");
		return {
			x: s,
			y: c
		};
	}), C = bn((e) => {
		if (e.is0()) {
			if (t.allowInfinityPoint && !r.is0(e.Y)) return;
			throw Error("bad point: ZERO");
		}
		let { x: n, y: i } = e.toAffine();
		if (!r.isValid(n) || !r.isValid(i)) throw Error("bad point: x or y not field elements");
		if (!g(n, i)) throw Error("bad point: equation left != right");
		if (!e.isTorsionFree()) throw Error("bad point: not in prime-order subgroup");
		return !0;
	});
	function w(e, t, n, i, a) {
		return n = new T(r.mul(n.X, e), n.Y, n.Z), t = Kn(i, t), n = Kn(a, n), t.add(n);
	}
	class T {
		constructor(e, t, n) {
			this.X = y("x", e), this.Y = y("y", t, !0), this.Z = y("z", n), Object.freeze(this);
		}
		static CURVE() {
			return a;
		}
		static fromAffine(e) {
			let { x: t, y: n } = e || {};
			if (!e || !r.isValid(t) || !r.isValid(n)) throw Error("invalid affine point");
			if (e instanceof T) throw Error("projective point not allowed");
			return r.is0(t) && r.is0(n) ? T.ZERO : new T(t, n, r.ONE);
		}
		static fromBytes(e) {
			let t = T.fromAffine(m(R(e, void 0, "point")));
			return t.assertValidity(), t;
		}
		static fromHex(e) {
			return T.fromBytes(B("pointHex", e));
		}
		get x() {
			return this.toAffine().x;
		}
		get y() {
			return this.toAffine().y;
		}
		precompute(e = 8, t = !0) {
			return E.createCache(this, e), t || this.multiply(mr), this;
		}
		assertValidity() {
			C(this);
		}
		hasEvenY() {
			let { y: e } = this.toAffine();
			if (!r.isOdd) throw Error("Field doesn't support isOdd");
			return !r.isOdd(e);
		}
		equals(e) {
			b(e);
			let { X: t, Y: n, Z: i } = this, { X: a, Y: o, Z: s } = e, c = r.eql(r.mul(t, s), r.mul(a, i)), l = r.eql(r.mul(n, s), r.mul(o, i));
			return c && l;
		}
		negate() {
			return new T(this.X, r.neg(this.Y), this.Z);
		}
		double() {
			let { a: e, b: t } = a, n = r.mul(t, mr), { X: i, Y: o, Z: s } = this, c = r.ZERO, l = r.ZERO, u = r.ZERO, d = r.mul(i, i), f = r.mul(o, o), p = r.mul(s, s), m = r.mul(i, o);
			return m = r.add(m, m), u = r.mul(i, s), u = r.add(u, u), c = r.mul(e, u), l = r.mul(n, p), l = r.add(c, l), c = r.sub(f, l), l = r.add(f, l), l = r.mul(c, l), c = r.mul(m, c), u = r.mul(n, u), p = r.mul(e, p), m = r.sub(d, p), m = r.mul(e, m), m = r.add(m, u), u = r.add(d, d), d = r.add(u, d), d = r.add(d, p), d = r.mul(d, m), l = r.add(l, d), p = r.mul(o, s), p = r.add(p, p), d = r.mul(p, m), c = r.sub(c, d), u = r.mul(p, f), u = r.add(u, u), u = r.add(u, u), new T(c, l, u);
		}
		add(e) {
			b(e);
			let { X: t, Y: n, Z: i } = this, { X: o, Y: s, Z: c } = e, l = r.ZERO, u = r.ZERO, d = r.ZERO, f = a.a, p = r.mul(a.b, mr), m = r.mul(t, o), h = r.mul(n, s), g = r.mul(i, c), _ = r.add(t, n), v = r.add(o, s);
			_ = r.mul(_, v), v = r.add(m, h), _ = r.sub(_, v), v = r.add(t, i);
			let y = r.add(o, c);
			return v = r.mul(v, y), y = r.add(m, g), v = r.sub(v, y), y = r.add(n, i), l = r.add(s, c), y = r.mul(y, l), l = r.add(h, g), y = r.sub(y, l), d = r.mul(f, v), l = r.mul(p, g), d = r.add(l, d), l = r.sub(h, d), d = r.add(h, d), u = r.mul(l, d), h = r.add(m, m), h = r.add(h, m), g = r.mul(f, g), v = r.mul(p, v), h = r.add(h, g), g = r.sub(m, g), g = r.mul(f, g), v = r.add(v, g), m = r.mul(h, v), u = r.add(u, m), m = r.mul(y, v), l = r.mul(_, l), l = r.sub(l, m), m = r.mul(_, h), d = r.mul(y, d), d = r.add(d, m), new T(l, u, d);
		}
		subtract(e) {
			return this.add(e.negate());
		}
		is0() {
			return this.equals(T.ZERO);
		}
		multiply(e) {
			let { endo: n } = t;
			if (!i.isValidNot0(e)) throw Error("invalid scalar: out of range");
			let r, a, o = (e) => E.cached(this, e, (e) => qn(T, e));
			if (n) {
				let { k1neg: t, k1: i, k2neg: s, k2: c } = x(e), { p: l, f: u } = o(i), { p: d, f } = o(c);
				a = u.add(f), r = w(n.beta, l, d, t, s);
			} else {
				let { p: t, f: n } = o(e);
				r = t, a = n;
			}
			return qn(T, [r, a])[0];
		}
		multiplyUnsafe(e) {
			let { endo: n } = t, r = this;
			if (!i.isValid(e)) throw Error("invalid scalar: out of range");
			if (e === J || r.is0()) return T.ZERO;
			if (e === fr) return r;
			if (E.hasCache(this)) return this.multiply(e);
			if (n) {
				let { k1neg: t, k1: i, k2neg: a, k2: o } = x(e), { p1: s, p2: c } = ir(T, r, i, o);
				return w(n.beta, s, c, t, a);
			}
			return E.unsafe(r, e);
		}
		multiplyAndAddUnsafe(e, t, n) {
			let r = this.multiplyUnsafe(t).add(e.multiplyUnsafe(n));
			return r.is0() ? void 0 : r;
		}
		toAffine(e) {
			return S(this, e);
		}
		isTorsionFree() {
			let { isTorsionFree: e } = t;
			return o === fr ? !0 : e ? e(T, this) : E.unsafe(this, s).is0();
		}
		clearCofactor() {
			let { clearCofactor: e } = t;
			return o === fr ? this : e ? e(T, this) : this.multiplyUnsafe(o);
		}
		isSmallOrder() {
			return this.multiplyUnsafe(o).is0();
		}
		toBytes(e = !0) {
			return sn(e, "isCompressed"), this.assertValidity(), p(T, this, e);
		}
		toHex(e = !0) {
			return N(this.toBytes(e));
		}
		toString() {
			return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
		}
		get px() {
			return this.X;
		}
		get py() {
			return this.X;
		}
		get pz() {
			return this.Z;
		}
		toRawBytes(e = !0) {
			return this.toBytes(e);
		}
		_setWindowSize(e) {
			this.precompute(e);
		}
		static normalizeZ(e) {
			return qn(T, e);
		}
		static msm(e, t) {
			return ar(T, i, e, t);
		}
		static fromPrivateKey(e) {
			return T.BASE.multiply(Y(i, e));
		}
	}
	T.BASE = new T(a.Gx, a.Gy, r.ONE), T.ZERO = new T(r.ZERO, r.ONE, r.ZERO), T.Fp = r, T.Fn = i;
	let ee = i.BITS, E = new rr(T, t.endo ? Math.ceil(ee / 2) : ee);
	return T.BASE.precompute(8), T;
}
function _r(e) {
	return Uint8Array.of(e ? 2 : 3);
}
function vr(e, t) {
	return {
		secretKey: t.BYTES,
		publicKey: 1 + e.BYTES,
		publicKeyUncompressed: 1 + 2 * e.BYTES,
		publicKeyHasPrefix: !0,
		signature: 2 * t.BYTES
	};
}
function yr(e, t = {}) {
	let { Fn: n } = e, r = t.randomBytes || Jt, i = Object.assign(vr(e.Fp, n), { seed: Un(n.ORDER) });
	function a(e) {
		try {
			return !!Y(n, e);
		} catch {
			return !1;
		}
	}
	function o(t, n) {
		let { publicKey: r, publicKeyUncompressed: a } = i;
		try {
			let i = t.length;
			return n === !0 && i !== r || n === !1 && i !== a ? !1 : !!e.fromBytes(t);
		} catch {
			return !1;
		}
	}
	function s(e = r(i.seed)) {
		return Wn(R(e, i.seed, "seed"), n.ORDER);
	}
	function c(t, r = !0) {
		return e.BASE.multiply(Y(n, t)).toBytes(r);
	}
	function l(e) {
		let t = s(e);
		return {
			secretKey: t,
			publicKey: c(t)
		};
	}
	function u(t) {
		if (typeof t == "bigint") return !1;
		if (t instanceof e) return !0;
		let { secretKey: r, publicKey: a, publicKeyUncompressed: o } = i;
		if (n.allowedLengths || r === a) return;
		let s = B("key", t).length;
		return s === a || s === o;
	}
	function d(t, r, i = !0) {
		if (u(t) === !0) throw Error("first arg must be private key");
		if (u(r) === !1) throw Error("second arg must be public key");
		let a = Y(n, t);
		return e.fromHex(r).multiply(a).toBytes(i);
	}
	return Object.freeze({
		getPublicKey: c,
		getSharedSecret: d,
		keygen: l,
		Point: e,
		utils: {
			isValidSecretKey: a,
			isValidPublicKey: o,
			randomSecretKey: s,
			isValidPrivateKey: a,
			randomPrivateKey: s,
			normPrivateKeyToScalar: (e) => Y(n, e),
			precompute(t = 8, n = e.BASE) {
				return n.precompute(t, !1);
			}
		},
		lengths: i
	});
}
function br(e, t, n = {}) {
	Ft(t), yn(n, {}, {
		hmac: "function",
		lowS: "boolean",
		randomBytes: "function",
		bits2int: "function",
		bits2int_modN: "function"
	});
	let r = n.randomBytes || Jt, i = n.hmac || ((e, ...n) => rn(t, e, F(...n))), { Fp: a, Fn: o } = e, { ORDER: s, BITS: c } = o, { keygen: l, getPublicKey: u, getSharedSecret: d, utils: f, lengths: p } = yr(e, n), m = {
		prehash: !1,
		lowS: typeof n.lowS == "boolean" && n.lowS,
		format: void 0,
		extraEntropy: !1
	}, h = "compact";
	function g(e) {
		return e > s >> fr;
	}
	function _(e, t) {
		if (!o.isValidNot0(t)) throw Error(`invalid signature ${e}: out of range 1..Point.Fn.ORDER`);
		return t;
	}
	function v(e, t) {
		ur(t);
		let n = p.signature;
		return R(e, t === "compact" ? n : t === "recovered" ? n + 1 : void 0, `${t} signature`);
	}
	class y {
		constructor(e, t, n) {
			this.r = _("r", e), this.s = _("s", t), n != null && (this.recovery = n), Object.freeze(this);
		}
		static fromBytes(e, t = h) {
			v(e, t);
			let n;
			if (t === "der") {
				let { r: t, s: n } = q.toSig(R(e));
				return new y(t, n);
			}
			t === "recovered" && (n = e[0], t = "compact", e = e.subarray(1));
			let r = o.BYTES, i = e.subarray(0, r), a = e.subarray(r, r * 2);
			return new y(o.fromBytes(i), o.fromBytes(a), n);
		}
		static fromHex(e, t) {
			return this.fromBytes(Ut(e), t);
		}
		addRecoveryBit(e) {
			return new y(this.r, this.s, e);
		}
		recoverPublicKey(t) {
			let n = a.ORDER, { r, s: i, recovery: c } = this;
			if (c == null || ![
				0,
				1,
				2,
				3
			].includes(c)) throw Error("recovery id invalid");
			if (s * pr < n && c > 1) throw Error("recovery id is ambiguous for h>1 curve");
			let l = c === 2 || c === 3 ? r + s : r;
			if (!a.isValid(l)) throw Error("recovery id 2 or 3 invalid");
			let u = a.toBytes(l), d = e.fromBytes(F(_r(!(c & 1)), u)), f = o.inv(l), p = x(B("msgHash", t)), m = o.create(-p * f), h = o.create(i * f), g = e.BASE.multiplyUnsafe(m).add(d.multiplyUnsafe(h));
			if (g.is0()) throw Error("point at infinify");
			return g.assertValidity(), g;
		}
		hasHighS() {
			return g(this.s);
		}
		toBytes(e = h) {
			if (ur(e), e === "der") return Ut(q.hexFromSig(this));
			let t = o.toBytes(this.r), n = o.toBytes(this.s);
			if (e === "recovered") {
				if (this.recovery == null) throw Error("recovery bit must be present");
				return F(Uint8Array.of(this.recovery), t, n);
			}
			return F(t, n);
		}
		toHex(e) {
			return N(this.toBytes(e));
		}
		assertValidity() {}
		static fromCompact(e) {
			return y.fromBytes(B("sig", e), "compact");
		}
		static fromDER(e) {
			return y.fromBytes(B("sig", e), "der");
		}
		normalizeS() {
			return this.hasHighS() ? new y(this.r, o.neg(this.s), this.recovery) : this;
		}
		toDERRawBytes() {
			return this.toBytes("der");
		}
		toDERHex() {
			return N(this.toBytes("der"));
		}
		toCompactRawBytes() {
			return this.toBytes("compact");
		}
		toCompactHex() {
			return N(this.toBytes("compact"));
		}
	}
	let b = n.bits2int || function(e) {
		if (e.length > 8192) throw Error("input is too large");
		let t = z(e), n = e.length * 8 - c;
		return n > 0 ? t >> BigInt(n) : t;
	}, x = n.bits2int_modN || function(e) {
		return o.create(b(e));
	}, S = _n(c);
	function C(e) {
		return hn("num < 2^" + c, e, J, S), o.toBytes(e);
	}
	function w(e, n) {
		return R(e, void 0, "message"), n ? R(t(e), void 0, "prehashed message") : e;
	}
	function T(t, n, i) {
		if (["recovered", "canonical"].some((e) => e in i)) throw Error("sign() legacy options not supported");
		let { lowS: a, prehash: s, extraEntropy: c } = dr(i, m);
		t = w(t, s);
		let l = x(t), u = Y(o, n), d = [C(u), C(l)];
		if (c != null && c !== !1) {
			let e = c === !0 ? r(p.secretKey) : c;
			d.push(B("extraEntropy", e));
		}
		let f = F(...d), h = l;
		function _(t) {
			let n = b(t);
			if (!o.isValidNot0(n)) return;
			let r = o.inv(n), i = e.BASE.multiply(n).toAffine(), s = o.create(i.x);
			if (s === J) return;
			let c = o.create(r * o.create(h + s * u));
			if (c === J) return;
			let l = (i.x === s ? 0 : 2) | Number(i.y & fr), d = c;
			return a && g(c) && (d = o.neg(c), l ^= 1), new y(s, d, l);
		}
		return {
			seed: f,
			k2sig: _
		};
	}
	function ee(e, n, r = {}) {
		e = B("message", e);
		let { seed: a, k2sig: s } = T(e, n, r);
		return vn(t.outputLen, o.BYTES, i)(a, s);
	}
	function E(e) {
		let t, n = typeof e == "string" || Nt(e), r = !n && typeof e == "object" && !!e && typeof e.r == "bigint" && typeof e.s == "bigint";
		if (!n && !r) throw Error("invalid signature, expected Uint8Array, hex string or Signature instance");
		if (r) t = new y(e.r, e.s);
		else if (n) {
			try {
				t = y.fromBytes(B("sig", e), "der");
			} catch (e) {
				if (!(e instanceof q.Err)) throw e;
			}
			if (!t) try {
				t = y.fromBytes(B("sig", e), "compact");
			} catch {
				return !1;
			}
		}
		return t || !1;
	}
	function te(t, n, r, i = {}) {
		let { lowS: a, prehash: s, format: c } = dr(i, m);
		if (r = B("publicKey", r), n = w(B("message", n), s), "strict" in i) throw Error("options.strict was renamed to lowS");
		let l = c === void 0 ? E(t) : y.fromBytes(B("sig", t), c);
		if (l === !1) return !1;
		try {
			let t = e.fromBytes(r);
			if (a && l.hasHighS()) return !1;
			let { r: i, s } = l, c = x(n), u = o.inv(s), d = o.create(c * u), f = o.create(i * u), p = e.BASE.multiplyUnsafe(d).add(t.multiplyUnsafe(f));
			return !p.is0() && o.create(p.x) === i;
		} catch {
			return !1;
		}
	}
	function ne(e, t, n = {}) {
		let { prehash: r } = dr(n, m);
		return t = w(t, r), y.fromBytes(e, "recovered").recoverPublicKey(t).toBytes();
	}
	return Object.freeze({
		keygen: l,
		getPublicKey: u,
		getSharedSecret: d,
		utils: f,
		lengths: p,
		Point: e,
		sign: ee,
		verify: te,
		recoverPublicKey: ne,
		Signature: y,
		hash: t
	});
}
function xr(e) {
	let t = {
		a: e.a,
		b: e.b,
		p: e.Fp.ORDER,
		n: e.n,
		h: e.h,
		Gx: e.Gx,
		Gy: e.Gy
	}, n = e.Fp, r = e.allowedPrivateKeyLengths ? Array.from(new Set(e.allowedPrivateKeyLengths.map((e) => Math.ceil(e / 2)))) : void 0;
	return {
		CURVE: t,
		curveOpts: {
			Fp: n,
			Fn: Vn(t.n, {
				BITS: e.nBitLength,
				allowedLengths: r,
				modFromBytes: e.wrapPrivateKey
			}),
			allowInfinityPoint: e.allowInfinityPoint,
			endo: e.endo,
			isTorsionFree: e.isTorsionFree,
			clearCofactor: e.clearCofactor,
			fromBytes: e.fromBytes,
			toBytes: e.toBytes
		}
	};
}
function Sr(e) {
	let { CURVE: t, curveOpts: n } = xr(e), r = {
		hmac: e.hmac,
		randomBytes: e.randomBytes,
		lowS: e.lowS,
		bits2int: e.bits2int,
		bits2int_modN: e.bits2int_modN
	};
	return {
		CURVE: t,
		curveOpts: n,
		hash: e.hash,
		ecdsaOpts: r
	};
}
function Cr(e, t) {
	let n = t.Point;
	return Object.assign({}, t, {
		ProjectivePoint: n,
		CURVE: Object.assign({}, e, Bn(n.Fn.ORDER, n.Fn.BITS))
	});
}
function wr(e) {
	let { CURVE: t, curveOpts: n, hash: r, ecdsaOpts: i } = Sr(e);
	return Cr(e, br(gr(t, n), r, i));
}
//#endregion
//#region node_modules/@noble/curves/esm/_shortw_utils.js
function Tr(e, t) {
	let n = (t) => wr({
		...e,
		hash: t
	});
	return {
		...n(t),
		create: n
	};
}
//#endregion
//#region node_modules/@noble/curves/esm/secp256k1.js
var Er = {
	p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
	n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
	h: BigInt(1),
	a: BigInt(0),
	b: BigInt(7),
	Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
	Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
}, Dr = {
	beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
	basises: [[BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")], [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]]
}, Or = /* @__PURE__ */ BigInt(0), kr = /* @__PURE__ */ BigInt(1), Ar = /* @__PURE__ */ BigInt(2);
function jr(e) {
	let t = Er.p, n = BigInt(3), r = BigInt(6), i = BigInt(11), a = BigInt(22), o = BigInt(23), s = BigInt(44), c = BigInt(88), l = e * e * e % t, u = l * l * e % t, d = G(G(G(u, n, t) * u % t, n, t) * u % t, Ar, t) * l % t, f = G(d, i, t) * d % t, p = G(f, a, t) * f % t, m = G(p, s, t) * p % t, h = G(G(G(G(G(G(m, c, t) * m % t, s, t) * p % t, n, t) * u % t, o, t) * f % t, r, t) * l % t, Ar, t);
	if (!Mr.eql(Mr.sqr(h), e)) throw Error("Cannot find square root");
	return h;
}
var Mr = Vn(Er.p, { sqrt: jr }), Nr = Tr({
	...Er,
	Fp: Mr,
	lowS: !0,
	endo: Dr
}, tn), Pr = {};
function Fr(e, ...t) {
	let n = Pr[e];
	if (n === void 0) {
		let t = tn(Wt(e));
		n = F(t, t), Pr[e] = n;
	}
	return tn(F(n, ...t));
}
var Ir = (e) => e.toBytes(!0).slice(1), Lr = Nr.Point, Rr = (e) => e % Ar === Or;
function zr(e) {
	let { Fn: t, BASE: n } = Lr, r = Y(t, e), i = n.multiply(r);
	return {
		scalar: Rr(i.y) ? r : t.neg(r),
		bytes: Ir(i)
	};
}
function Br(e) {
	let t = Mr;
	if (!t.isValidNot0(e)) throw Error("invalid x: Fail if x ≥ p");
	let n = t.create(e * e), r = t.create(n * e + BigInt(7)), i = t.sqrt(r);
	Rr(i) || (i = t.neg(i));
	let a = Lr.fromAffine({
		x: e,
		y: i
	});
	return a.assertValidity(), a;
}
var Vr = z;
function Hr(...e) {
	return Lr.Fn.create(Vr(Fr("BIP0340/challenge", ...e)));
}
function Ur(e) {
	return zr(e).bytes;
}
function Wr(e, t, n = Jt(32)) {
	let { Fn: r } = Lr, i = B("message", e), { bytes: a, scalar: o } = zr(t), s = B("auxRand", n, 32), { bytes: c, scalar: l } = zr(Fr("BIP0340/nonce", r.toBytes(o ^ Vr(Fr("BIP0340/aux", s))), a, i)), u = Hr(c, a, i), d = /* @__PURE__ */ new Uint8Array(64);
	if (d.set(c, 0), d.set(r.toBytes(r.create(l + u * o)), 32), !Gr(d, i, a)) throw Error("sign: Invalid signature produced");
	return d;
}
function Gr(e, t, n) {
	let { Fn: r, BASE: i } = Lr, a = B("signature", e, 64), o = B("message", t), s = B("publicKey", n, 32);
	try {
		let e = Br(Vr(s)), t = Vr(a.subarray(0, 32));
		if (!mn(t, kr, Er.p)) return !1;
		let n = Vr(a.subarray(32, 64));
		if (!mn(n, kr, Er.n)) return !1;
		let c = Hr(r.toBytes(t), Ir(e), o), l = i.multiplyUnsafe(n).add(e.multiplyUnsafe(r.neg(c))), { x: u, y: d } = l.toAffine();
		return !(l.is0() || !Rr(d) || u !== t);
	} catch {
		return !1;
	}
}
var Kr = /* @__PURE__ */ (() => {
	let e = (e = Jt(48)) => Wn(e, Er.n);
	Nr.utils.randomSecretKey;
	function t(t) {
		let n = e(t);
		return {
			secretKey: n,
			publicKey: Ur(n)
		};
	}
	return {
		keygen: t,
		getPublicKey: Ur,
		sign: Wr,
		verify: Gr,
		Point: Lr,
		utils: {
			randomSecretKey: e,
			randomPrivateKey: e,
			taggedHash: Fr,
			lift_x: Br,
			pointToBytes: Ir,
			numberToBytesBE: dn,
			bytesToNumberBE: z,
			mod: W
		},
		lengths: {
			secretKey: 32,
			publicKey: 32,
			publicKeyHasPrefix: !1,
			signature: 64,
			seed: 48
		}
	};
})(), qr = tn, Jr = 2e4, Yr = class {
	servers;
	openSocket;
	handlers = null;
	queue = [];
	stopped = !1;
	constructor(e, t) {
		this.servers = e.map((e) => ({
			url: e,
			socket: null,
			open: !1,
			retryMs: 2e3,
			timer: null
		})), this.openSocket = t;
	}
	start(e) {
		this.handlers = e, this.stopped = !1;
		for (let e of this.servers) this.connect(e);
	}
	broadcast(e) {
		let t = Date.now();
		this.queue = [...this.queue.filter((e) => t - e.at < Jr), {
			text: e,
			at: t
		}];
		for (let t of this.servers) t.open && t.socket?.send(e);
	}
	each(e) {
		for (let t of this.servers) {
			let n = t.socket;
			t.open && n && e((e) => n.send(e), t.url);
		}
	}
	phase() {
		return this.servers.some((e) => e.open) ? "live" : this.servers.some((e) => e.socket) ? "connecting" : "offline";
	}
	stop() {
		this.stopped = !0;
		for (let e of this.servers) e.timer && clearTimeout(e.timer), e.socket?.close(1e3, "Bye"), e.socket = null, e.open = !1;
	}
	connect(e) {
		if (this.stopped) return;
		let t;
		try {
			t = this.openSocket(e.url);
		} catch {
			this.later(e);
			return;
		}
		e.socket = t;
		let n = (e) => t.send(e);
		t.addEventListener("open", () => {
			e.open = !0, e.retryMs = 2e3, this.handlers?.opened(e.url, n);
			let t = Date.now();
			for (let e of this.queue) t - e.at < Jr && n(e.text);
		}), t.addEventListener("message", (t) => {
			typeof t.data == "string" && this.handlers?.message(e.url, t.data, n);
		}), t.addEventListener("close", () => {
			e.socket === t && (e.socket = null, e.open = !1, this.later(e));
		});
	}
	later(e) {
		this.stopped || (e.timer = setTimeout(() => this.connect(e), e.retryMs), e.retryMs = Math.min(e.retryMs * 2, 6e4));
	}
}, Xr = 25331, Zr = [
	"wss://relay.damus.io",
	"wss://nos.lol",
	"wss://relay.primal.net"
], Qr = (e) => [...e].map((e) => e.toString(16).padStart(2, "0")).join("");
function $r(e) {
	return Qr(qr(new TextEncoder().encode(JSON.stringify([
		0,
		e.pubkey,
		e.created_at,
		e.kind,
		e.tags,
		e.content
	]))));
}
function ei(e, t, n, r, i) {
	let a = Qr(Kr.getPublicKey(e)), o = Math.floor(i / 1e3), s = $r({
		pubkey: a,
		created_at: o,
		kind: t,
		tags: n,
		content: r
	});
	return {
		id: s,
		pubkey: a,
		created_at: o,
		kind: t,
		tags: n,
		content: r,
		sig: Qr(Kr.sign(s, e))
	};
}
function ti(e) {
	return typeof e == "object" && !!e && "pubkey" in e && "kind" in e && "tags" in e && "content" in e && typeof e.pubkey == "string" && typeof e.kind == "number" && Array.isArray(e.tags) && typeof e.content == "string";
}
var ni = class {
	name = "nostr";
	pool;
	secretKey = Kr.utils.randomPrivateKey();
	pubkey = Qr(Kr.getPublicKey(this.secretKey));
	subId = `sc${Math.random().toString(36).slice(2, 10)}`;
	topic = "";
	constructor(e, t) {
		this.pool = new Yr(e, t);
	}
	request(e) {
		let t = Math.floor(Date.now() / 1e3) - 60;
		e(JSON.stringify([
			"REQ",
			this.subId,
			{
				kinds: [Xr],
				"#t": [this.topic],
				since: t
			}
		]));
	}
	start(e, t) {
		this.topic = e, this.pool.start({
			opened: (e, t) => this.request(t),
			message: (e, n) => {
				let r;
				try {
					r = JSON.parse(n);
				} catch {
					return;
				}
				if (!Array.isArray(r) || r[0] !== "EVENT" || r[1] !== this.subId) return;
				let i = r[2];
				ti(i) && i.kind === 25331 && i.pubkey !== this.pubkey && i.tags.some((e) => e[0] === "t" && e[1] === this.topic) && t(i.content);
			}
		});
	}
	retopic(e) {
		this.topic = e, this.pool.each((e) => {
			e(JSON.stringify(["CLOSE", this.subId])), this.request(e);
		});
	}
	send(e) {
		let t = ei(this.secretKey, Xr, [["t", this.topic]], e, Date.now());
		this.pool.broadcast(JSON.stringify(["EVENT", t]));
	}
	phase() {
		return this.pool.phase();
	}
	stop() {
		this.pool.stop();
	}
}, ri = ["wss://tracker.openwebtorrent.com", "wss://tracker.webtorrent.dev"], ii = 10, ai = 6e4, oi = (e) => [...crypto.getRandomValues(new Uint8Array(e))].map((e) => "abcdefghijklmnopqrstuvwxyz0123456789"[e % 36]).join("");
function si(e) {
	let t = "";
	for (let n = 0; n < 40; n += 2) t += String.fromCharCode(parseInt(e.slice(n, n + 2), 16));
	return t;
}
var ci = class {
	name = "tracker";
	pool;
	peerId = oi(20);
	infoHash = "";
	timer = null;
	constructor(e, t) {
		this.pool = new Yr(e, t);
	}
	announce(e = {}) {
		return JSON.stringify({
			action: "announce",
			info_hash: this.infoHash,
			peer_id: this.peerId,
			uploaded: 0,
			downloaded: 0,
			numwant: ii,
			...e
		});
	}
	start(e, t) {
		this.infoHash = si(e), this.pool.start({
			opened: (e, t) => t(this.announce({
				event: "started",
				offers: []
			})),
			message: (e, n) => {
				let r;
				try {
					r = JSON.parse(n);
				} catch {
					return;
				}
				if (typeof r != "object" || !r || !("offer" in r) || !("peer_id" in r) || r.peer_id === this.peerId || !("info_hash" in r) || r.info_hash !== this.infoHash) return;
				let i = r.offer;
				typeof i == "object" && i && "sdp" in i && typeof i.sdp == "string" && t(i.sdp);
			}
		}), this.timer = setInterval(() => this.pool.each((e) => e(this.announce({ offers: [] }))), ai);
	}
	retopic(e) {
		this.infoHash = si(e), this.pool.each((e) => e(this.announce({
			event: "started",
			offers: []
		})));
	}
	send(e) {
		let t = Array.from({ length: ii }, () => ({
			offer: {
				type: "offer",
				sdp: e
			},
			offer_id: oi(20)
		}));
		this.pool.broadcast(this.announce({ offers: t }));
	}
	phase() {
		return this.pool.phase();
	}
	stop() {
		this.timer && clearInterval(this.timer), this.pool.stop();
	}
}, li = {
	stage: "",
	collection: "",
	hideOthersEditing: !1
}, ui = class {
	ports;
	engine = null;
	sync = null;
	room = null;
	view;
	listeners = /* @__PURE__ */ new Set();
	disposers = [];
	running = Promise.resolve();
	filter = li;
	filterTimer = null;
	lastDevelopPhoto = null;
	constructor(e) {
		this.ports = e, this.view = {
			mainWindow: e.isMainWindow,
			profile: ge(e.settings),
			room: O(e.settings),
			roomId: "",
			phase: "idle",
			problem: "",
			engine: null,
			relayMode: null,
			socketAccess: e.sockets ? "not-allowed" : "unavailable",
			collections: [],
			filter: li,
			realtime: we(e.settings),
			directAvailable: !!e.createPeer,
			here: e.whereabouts(),
			revision: 0
		};
	}
	start() {
		this.disposers.push(this.ports.settings.onChange((e) => {
			e !== "autoStage" && (e === "realtime" ? (this.update({ realtime: we(this.ports.settings) }), this.restart()) : this.update({
				profile: ge(this.ports.settings),
				room: O(this.ports.settings)
			}));
		}), this.ports.onProjectChange(() => this.restart()), this.ports.onWhereaboutsChange(() => this.whereaboutsChanged()), this.ports.onEditStored((e) => void this.sync?.recordEdit(e))), this.restart();
	}
	async dispose() {
		for (let e of this.disposers.splice(0)) e();
		this.filterTimer && clearTimeout(this.filterTimer), await this.halt();
	}
	subscribe = (e) => (this.listeners.add(e), () => this.listeners.delete(e));
	getView = () => this.view;
	update(e) {
		this.view = {
			...this.view,
			...e,
			revision: this.view.revision + 1
		};
		for (let e of this.listeners) e();
	}
	refresh = () => {
		this.update({
			engine: this.engine?.view() ?? null,
			collections: this.engine ? Ve(this.engine.state) : []
		}), this.filterActive() && !this.filterTimer && (this.filterTimer = setTimeout(() => {
			this.filterTimer = null, this.applyFilter();
		}, 500));
	};
	restart() {
		return this.running = this.running.then(async () => {
			await this.halt();
			let e = O(this.ports.settings);
			if (!e) return this.update({
				room: null,
				phase: "idle",
				problem: "",
				engine: null
			});
			if (!this.ports.isMainWindow) return this.update({
				room: e,
				phase: "idle"
			});
			let t = this.ports.projectKey();
			if (!t) return this.update({
				room: e,
				phase: "no-project"
			});
			if (e.project && e.project !== t) return this.update({
				room: e,
				phase: "other-project"
			});
			await this.run(e);
		}), this.running;
	}
	async halt() {
		let e = this.sync, t = this.engine;
		this.sync = null, this.engine = null, this.room = null, e?.stop(), await t?.stop(), this.ports.setGridFilter(null);
	}
	async transportFor(e, t, n) {
		if (t.transport === "folder") {
			let r = await this.ports.openFolder(t.folderToken);
			if (typeof r == "string") throw Error(r);
			let i = this.ports.folderPollMs;
			return {
				mode: null,
				make: () => new lt({
					root: r,
					roomId: e.roomId,
					memberId: n,
					pollMs: i
				})
			};
		}
		let r = this.ports.sockets, i = r ? await r.status(ye(t.relayUrl)) : "unavailable";
		this.update({ socketAccess: i });
		let a = i === "allowed" ? "socket" : "poll";
		if (a === "poll" && !await this.ports.network.hasAccess(t.relayUrl)) throw Error("Allow the relay's address first: Safelight hasn't been allowed to reach it.");
		return {
			mode: a,
			make: (r) => new _t({
				baseUrl: t.relayUrl,
				roomId: e.roomId,
				token: e.relayToken,
				memberId: n,
				mode: a,
				fetch: (e, t) => this.ports.network.fetch(e, t),
				openSocket: (e) => this.ports.openSocket(e),
				cursor: r
			})
		};
	}
	async codeOf(e) {
		if (!e.keychain) return e.code;
		let t = await this.ports.secrets?.get(pe), n = t ? c(t) : null;
		if (!n) throw Error("The room code kept in this computer's keychain can't be read. Leave the room and join again with its code.");
		return n;
	}
	async run(e) {
		this.update({
			room: e,
			phase: "starting",
			problem: ""
		});
		try {
			let t = await d(await this.codeOf(e)), n = xe(this.ports.settings, t.roomId), r = await this.transportFor(t, e, n), i = {
				mode: r.mode,
				make: this.withDirect(r.make, t, n)
			}, a = null, o = new et({
				room: t,
				memberId: n,
				name: () => ge(this.ports.settings).name || "Someone",
				transport: i.make,
				store: this.ports.localStore,
				appVersion: this.ports.appVersion,
				onApplied: (e) => a?.applied(e),
				onLoaded: () => a?.recordOfflineChanges()
			});
			a = new ze({
				catalog: this.ports.catalog,
				engine: o,
				stepLabel: () => `Studio Collab: ${this.lastAuthorName(o)}`,
				autoStage: () => Se(this.ports.settings)
			}), this.engine = o, this.sync = a, this.room = t, this.update({ roomId: t.roomId }), o.subscribe(this.refresh), a.subscribe(this.refresh), this.update({ relayMode: i.mode }), await o.start(), await a.begin(), this.whereaboutsChanged(), this.update({ phase: "running" }), this.refresh();
		} catch (e) {
			await this.halt(), this.update({
				phase: "problem",
				problem: e instanceof Error ? e.message : String(e)
			});
		}
	}
	withDirect(e, t, n) {
		let r = this.ports.createPeer;
		if (!r) return e;
		let i = we(this.ports.settings), a = [...this.ports.iceServers ?? Et];
		i.turn && a.push({
			urls: i.turn.url,
			username: i.turn.username,
			credential: i.turn.credential
		});
		let o = (e) => this.ports.openSocket(e);
		return (s) => new Mt({
			durable: e(s),
			room: t,
			memberId: n,
			createPeer: r,
			iceServers: a,
			publicBuses: i.publicSignalling ? [new ni(Zr, o), new ci(ri, o)] : [],
			mesh: this.ports.meshTiming
		});
	}
	setRealtime(e) {
		Te(this.ports.settings, e);
	}
	lastAuthorName(e) {
		return e.view().members.filter((e) => e.lastChangeAt !== null).sort((e, t) => (t.lastChangeAt ?? 0) - (e.lastChangeAt ?? 0))[0]?.name ?? "the team";
	}
	whereaboutsChanged() {
		let e = this.ports.whereabouts();
		this.update({ here: e });
		let t = this.engine, n = this.sync;
		if (!t || !n) return;
		let r = e.photoId ? n.keyFor(e.photoId) ?? "" : "";
		t.setPresence({
			role: ge(this.ports.settings).role,
			module: e.module,
			photo: r,
			editing: !!e.developPhotoId && e.developPhotoId === e.photoId
		}), e.developPhotoId !== this.lastDevelopPhoto && (this.lastDevelopPhoto = e.developPhotoId, n.flushDeferred());
	}
	setProfile(e) {
		_e(this.ports.settings, e), this.update({ profile: ge(this.ports.settings) }), this.whereaboutsChanged();
	}
	async createRoom(e) {
		let t = s();
		return await this.joinRoom(t, e), t;
	}
	async joinRoom(e, t) {
		let n = c(e);
		if (!n) throw Error("That isn't a room code: it starts with slc1- and is 48 characters long.");
		let r = this.ports.projectKey();
		if (!r) throw Error("Open the shoot's folder first: the room follows the project it was joined in.");
		let i = this.ports.secrets, a = !!i && await i.available();
		i && a && await i.set(pe, n), be(this.ports.settings, {
			code: a ? "" : n,
			keychain: a,
			project: r,
			...t
		}), await this.restart();
	}
	async leaveRoom() {
		let e = this.room, t = O(this.ports.settings);
		be(this.ports.settings, null), t?.keychain && await this.ports.secrets?.delete(pe), await this.restart(), e && await this.ports.localStore.remove(e.roomId);
	}
	async useOpenProject() {
		let e = O(this.ports.settings), t = this.ports.projectKey();
		e && t && (be(this.ports.settings, {
			...e,
			project: t
		}), await this.restart());
	}
	pickFolder() {
		return this.ports.pickFolder(null);
	}
	autoStage() {
		return Se(this.ports.settings);
	}
	setAutoStage(e) {
		this.ports.settings.set(de, e), this.update({});
	}
	async copyCode() {
		let e = O(this.ports.settings);
		e && await this.ports.copyText(await this.codeOf(e));
	}
	async allowRelay(e) {
		return this.ports.network.requestAccess(e);
	}
	async allowLiveConnection(e) {
		let t = this.ports.sockets;
		if (!t) return "unavailable";
		let n;
		try {
			n = await t.requestAccess(ye(e));
		} catch (e) {
			return this.update({ problem: e instanceof Error ? e.message : String(e) }), "not-allowed";
		}
		return this.update({ socketAccess: n }), n === "allowed" && await this.restart(), n;
	}
	photoInfo(e) {
		let t = this.sync, n = this.engine;
		if (!t || !n) return null;
		let r = t.keyFor(e), i = n.view().members.filter((e) => e.fresh && r && e.photo === r);
		return {
			stage: t.stageOf(e),
			editedBy: i.filter((e) => e.editing).map((e) => e.name),
			viewedBy: i.filter((e) => !e.editing).map((e) => e.name),
			waitingEdit: t.deferred.has(e),
			tooBig: t.oversized.has(e),
			collections: Ve(n.state).filter((n) => Ke(t, e, n.id)).map((e) => e.id)
		};
	}
	photoNameFor(e) {
		return e.replace(/^p:/, "").replace(/#copy:.*$/, "").split("/").pop() ?? "";
	}
	setStage(e, t) {
		this.sync?.setStage(e, t);
	}
	markExported(e) {
		this.sync?.markExported(e);
	}
	applyWaitingEdit(e) {
		return this.sync?.applyEdit(e) ?? Promise.resolve();
	}
	createCollection(e) {
		return this.engine && e.trim() ? He(this.engine, e) : null;
	}
	renameCollection(e, t) {
		this.engine && t.trim() && Ue(this.engine, e, t);
	}
	deleteCollection(e) {
		this.engine && We(this.engine, e), this.filter.collection === e && this.setFilter({
			...this.filter,
			collection: ""
		});
	}
	setInCollection(e, t, n) {
		this.engine && this.sync && Ge(this.sync, this.engine, e, t, n);
	}
	setFilter(e) {
		this.filter = e, this.update({ filter: e }), this.applyFilter();
	}
	filterActive() {
		return !!(this.filter.stage || this.filter.collection || this.filter.hideOthersEditing);
	}
	applyFilter() {
		let e = this.sync, t = this.engine;
		if (!e || !t || !this.filterActive()) {
			this.ports.setGridFilter(null);
			return;
		}
		let { stage: n, collection: r, hideOthersEditing: i } = this.filter, a = new Set(t.view().members.filter((e) => e.fresh && e.editing).map((e) => e.photo));
		this.ports.setGridFilter((t) => !(n && e.stageOf(t) !== n || r && !Ke(e, t, r) || i && a.has(e.keyFor(t) ?? "")));
	}
}, di = "studio-collab", fi = "rooms";
function pi(e) {
	return new Promise((t, n) => {
		e.onsuccess = () => t(e.result), e.onerror = () => n(e.error);
	});
}
function mi(e) {
	return typeof e == "object" && !!e && "state" in e && "cursor" in e && "outbox" in e && "seq" in e && "clock" in e && typeof e.cursor == "number" && Array.isArray(e.outbox) && typeof e.seq == "number" && typeof e.clock == "number";
}
function hi(e = indexedDB) {
	let t = null, n = () => {
		if (!t) {
			let n = e.open(di, 1);
			n.onupgradeneeded = () => n.result.createObjectStore(fi), t = pi(n);
		}
		return t;
	}, r = async (e) => (await n()).transaction(fi, e).objectStore(fi);
	return {
		async load(e) {
			let t = await pi((await r("readonly")).get(e));
			return mi(t) ? t : null;
		},
		async save(e, t) {
			await pi((await r("readwrite")).put(t, e));
		},
		async remove(e) {
			await pi((await r("readwrite")).delete(e));
		}
	};
}
//#endregion
//#region src/transport/folder-like.ts
var gi = (e) => e instanceof Error && (e.name === "NotFoundError" || /ENOENT|not found|no such file/i.test(e.message));
function _i(e) {
	return {
		async list() {
			let t = [];
			for await (let n of e.values()) t.push({
				name: n.name,
				kind: n.kind
			});
			return t;
		},
		async folder(t, n) {
			return !n && !(await this.list()).some((e) => e.name === t && e.kind === "directory") ? null : _i(await e.getDirectoryHandle(t, { create: n }));
		},
		async readText(t) {
			try {
				return await (await (await e.getFileHandle(t)).getFile()).text();
			} catch (e) {
				if (gi(e)) return null;
				throw e;
			}
		},
		async writeText(t, n) {
			let r = await (await e.getFileHandle(t, { create: !0 })).createWritable();
			await r.write(n), await r.close();
		}
	};
}
//#endregion
//#region src/realtime/rtc-adapter.ts
function vi(e) {
	return typeof e == "object" && !!e && "send" in e && "close" in e && "addEventListener" in e && "readyState" in e && typeof e.send == "function" && typeof e.addEventListener == "function";
}
function yi(e) {
	return {
		get readyState() {
			return e.readyState;
		},
		send: (t) => e.send(t),
		close: () => e.close(),
		on: (t, n) => e.addEventListener(t, () => n()),
		onMessage: (t) => e.addEventListener("message", (e) => t("data" in e ? e.data : void 0))
	};
}
function bi(e) {
	return {
		get localDescription() {
			return e.localDescription;
		},
		get iceGatheringState() {
			return e.iceGatheringState;
		},
		get connectionState() {
			return e.connectionState;
		},
		createDataChannel: (t, n) => yi(e.createDataChannel(t, n)),
		createOffer: () => e.createOffer(),
		createAnswer: () => e.createAnswer(),
		setLocalDescription: (t) => e.setLocalDescription(t),
		setRemoteDescription: (t) => e.setRemoteDescription(t),
		close: () => e.close(),
		on: (t, n) => e.addEventListener(t, () => n()),
		onChannel: (t) => e.addEventListener("datachannel", (e) => {
			let n = "channel" in e ? e.channel : null;
			vi(n) && t(yi(n));
		})
	};
}
//#endregion
//#region src/app/host-ports.ts
var xi = "1.0.1", Si = `${se}.filter`, Ci = `${se}-room`, wi = {
	gone: "The room's folder isn't there: its drive or share may not be connected.",
	unwritable: "Safelight can't write into the room's folder.",
	unknown: "Safelight doesn't know the room's folder any more. Choose it again."
};
function Ti(e, t) {
	let { useCatalogStore: n, useUIStore: r, useProjectStore: i } = e.stores, a = () => {
		let e = r.getState(), t = n.getState(), i = e.activeModule === "develop" || e.detached.has("develop") ? t.activePhotoId : null, a = [...t.selectedIds];
		return {
			module: e.activeModule,
			developPhotoId: i,
			photoId: i ?? a[0] ?? t.activePhotoId,
			selectedIds: a
		};
	};
	return {
		settings: {
			get: (t, n) => e.settings.get(t, n),
			set: (t, n) => e.settings.set(t, n),
			onChange: (t) => e.settings.onChange((e) => t(e))
		},
		catalog: {
			photos: () => n.getState().photos,
			onPhotosChange: (e) => n.subscribe((t, n) => {
				t.photos !== n.photos && e();
			}),
			setRating: (e, t) => n.getState().setRating(e, t),
			setFlag: (e, t) => n.getState().setFlag(e, t),
			setColorLabel: (e, t) => n.getState().setColorLabel(e, t),
			addKeyword: (e, t) => n.getState().addKeyword(e, t),
			removeKeyword: (e, t) => n.getState().removeKeyword(e, t),
			getEditState: (t) => e.catalog.getEditState(t),
			putEditState: (t) => e.catalog.putEditState(t),
			editingPhotoId: () => a().developPhotoId
		},
		whereabouts: a,
		onWhereaboutsChange: (e) => {
			let t = r.subscribe((t, n) => {
				(t.activeModule !== n.activeModule || t.detached !== n.detached) && e();
			}), i = n.subscribe((t, n) => {
				(t.activePhotoId !== n.activePhotoId || t.selectedIds !== n.selectedIds) && e();
			});
			return () => {
				t(), i();
			};
		},
		projectKey: () => {
			let { root: t, name: n } = i.getState();
			return t ? e.project.pathOf(t) ?? n : "";
		},
		onProjectChange: (e) => i.subscribe((t, n) => {
			t.root !== n.root && e();
		}),
		pickFolder: async (t) => {
			let n = await e.project.pickKeptDirectory(Ci, t);
			return n ? {
				token: n.token,
				label: e.project.pathOf(n.folder) ?? n.folder.name
			} : null;
		},
		openFolder: async (t) => {
			let n = await e.project.openKeptDirectory(t);
			return "folder" in n ? _i(n.folder) : wi[n.problem];
		},
		network: {
			requestAccess: (t) => e.network.requestAccess(t),
			hasAccess: (t) => e.network.hasAccess(t),
			fetch: (t, n) => e.network.fetch(t, n)
		},
		sockets: {
			requestAccess: (t) => e.sockets.requestAccess(t),
			status: (t) => e.sockets.status(t)
		},
		secrets: {
			available: () => e.secrets.available(),
			get: (t) => e.secrets.get(t),
			set: (t, n) => e.secrets.set(t, n),
			delete: (t) => e.secrets.delete(t)
		},
		openSocket: (e) => new WebSocket(e),
		createPeer: typeof RTCPeerConnection == "function" ? (e) => bi(new RTCPeerConnection(e)) : null,
		localStore: hi(),
		onEditStored: (n) => {
			t.add(n);
			let r = e.events.onBroadcast((e) => {
				e.type === "edit-update" && e.payload.photoId && n(e.payload.photoId);
			});
			return () => {
				t.delete(n), r();
			};
		},
		setGridFilter: (t) => e.registerGridFilter({
			id: Si,
			test: (e) => !t || t(e.id),
			reads: []
		}),
		copyText: (e) => navigator.clipboard.writeText(e),
		appVersion: xi,
		isMainWindow: e.navigation.ownModule() === null
	};
}
//#endregion
//#region src/rt.ts
var X, Z, Q;
function Ei(e, t, n) {
	X = e, Z = t, Q = n;
}
//#endregion
//#region src/ui/Setup.tsx
function Di() {
	let { Button: e, Field: t, SegmentedControl: n, Stack: r, TextInput: i } = Z, [a, o] = X.useState("create"), [s, c] = X.useState("folder"), [l, u] = X.useState(""), [d, f] = X.useState(null), [p, m] = X.useState(""), [h, g] = X.useState(!1), [_, v] = X.useState(!1), [y, b] = X.useState(""), x = ve(p), S = s === "folder" ? d && {
		transport: "folder",
		folderToken: d.token,
		folderLabel: d.label
	} : x && h ? {
		transport: "relay",
		relayUrl: x
	} : null, C = async (e) => {
		v(!0), b("");
		try {
			await e();
		} catch (e) {
			b(e instanceof Error ? e.message : String(e));
		} finally {
			v(!1);
		}
	}, w = () => C(async () => {
		S && (a === "create" ? await Q.createRoom(S) : await Q.joinRoom(l, S));
	});
	return /* @__PURE__ */ X.createElement(r, { gap: 10 }, /* @__PURE__ */ X.createElement(n, {
		value: a,
		onChange: (e) => o(e === "join" ? "join" : "create"),
		options: [{
			value: "create",
			label: "Create a room"
		}, {
			value: "join",
			label: "Join a room"
		}]
	}), a === "join" && /* @__PURE__ */ X.createElement(t, {
		label: "Room code",
		hint: "Ask whoever made the room for its code."
	}, /* @__PURE__ */ X.createElement(i, {
		value: l,
		onChange: u,
		placeholder: "slc1-…",
		"aria-label": "Room code"
	})), /* @__PURE__ */ X.createElement(t, { label: "Shared through" }, /* @__PURE__ */ X.createElement(n, {
		value: s,
		onChange: (e) => c(e === "relay" ? "relay" : "folder"),
		options: [{
			value: "folder",
			label: "Shared folder"
		}, {
			value: "relay",
			label: "Relay"
		}]
	})), s === "folder" ? /* @__PURE__ */ X.createElement(t, {
		label: "Folder",
		hint: "A folder Google Drive, OneDrive, Dropbox, Syncthing or your NAS keeps the same on every computer. Everyone picks their own copy of it. It keeps the room's record; teammates also connect directly, so changes usually arrive at once."
	}, /* @__PURE__ */ X.createElement(e, {
		full: !0,
		onClick: () => void C(async () => f(await Q.pickFolder() ?? d))
	}, d ? d.label : "Choose folder…")) : /* @__PURE__ */ X.createElement(t, {
		label: "Relay address",
		hint: "The relay your studio runs (see the extension's README). Changes arrive within a second or two."
	}, /* @__PURE__ */ X.createElement(r, { gap: 6 }, /* @__PURE__ */ X.createElement(i, {
		value: p,
		onChange: (e) => {
			m(e), g(!1);
		},
		placeholder: "https://relay.your-studio.com",
		"aria-label": "Relay address"
	}), /* @__PURE__ */ X.createElement(e, {
		disabled: !x || _,
		onClick: () => void C(async () => {
			x && g(await Q.allowRelay(x));
		})
	}, h ? "Address allowed" : "Allow address"), p && !x && /* @__PURE__ */ X.createElement("span", { style: {
		fontSize: 10,
		color: Z.tokens.labelRed
	} }, "The address must start with https://"))), /* @__PURE__ */ X.createElement(e, {
		variant: "primary",
		full: !0,
		disabled: !S || _ || a === "join" && !l.trim(),
		onClick: () => void w()
	}, a === "create" ? "Create room" : "Join room"), y && /* @__PURE__ */ X.createElement("span", { style: {
		fontSize: 11,
		color: Z.tokens.labelRed
	} }, y));
}
//#endregion
//#region src/ui/format.ts
var Oi = {
	shooter: "Shooter",
	culler: "Culler",
	editor: "Editor",
	exporter: "Exporter"
}, ki = {
	shot: "Shot",
	culled: "Culled",
	edited: "Edited",
	exported: "Exported"
};
function Ai(e, t) {
	if (e === null) return "not yet";
	let n = Math.max(0, Math.round((t - e) / 1e3));
	if (n < 5) return "just now";
	if (n < 90) return `${n} s ago`;
	let r = Math.round(n / 60);
	return r < 90 ? `${r} min ago` : `${Math.round(r / 60)} h ago`;
}
function ji(e) {
	let t = Math.round(e / 6e4);
	return t < 90 ? `${t} min` : `${Math.round(t / 60)} h`;
}
function Mi(e) {
	if (e.link === "direct") return e.rttMs === null ? "direct" : `direct, ${e.rttMs} ms`;
	let t = e.link === "relay" ? "relay" : "via folder, slower";
	return e.connecting ? `${t} (connecting directly…)` : t;
}
function Ni(e, t, n) {
	return t ? "editing" : e === "library" ? n === "culler" || n === "" ? "culling" : "browsing" : e === "develop" ? "looking at" : e ? `in ${e}` : "here";
}
//#endregion
//#region src/ui/CollabPanel.tsx
var $ = (e) => ({
	fontSize: 10,
	color: e,
	lineHeight: 1.5
});
function Pi() {
	return X.useSyncExternalStore(Q.subscribe, Q.getView);
}
function Fi(e = 5e3) {
	let [t, n] = X.useState(Date.now());
	return X.useEffect(() => {
		let t = setInterval(() => n(Date.now()), e);
		return () => clearInterval(t);
	}, [e]), t;
}
function Ii({ view: e }) {
	let { Field: t, Row: n, Select: r, TextInput: i } = Z, [a, o] = X.useState(e.profile.name);
	return X.useEffect(() => o(e.profile.name), [e.profile.name]), /* @__PURE__ */ X.createElement(n, {
		gap: 8,
		align: "flex-end"
	}, /* @__PURE__ */ X.createElement("div", { style: {
		flex: 1,
		minWidth: 0
	} }, /* @__PURE__ */ X.createElement(t, { label: "Your name" }, /* @__PURE__ */ X.createElement(i, {
		value: a,
		onChange: o,
		onBlur: () => Q.setProfile({
			...e.profile,
			name: a.trim()
		}),
		placeholder: "Shown to the team",
		"aria-label": "Your name"
	}))), /* @__PURE__ */ X.createElement("div", { style: { width: 110 } }, /* @__PURE__ */ X.createElement(t, { label: "Role" }, /* @__PURE__ */ X.createElement(r, {
		value: e.profile.role,
		onChange: (t) => Q.setProfile({
			...e.profile,
			role: y.find((e) => e === t) ?? ""
		}),
		options: [{
			value: "",
			label: "None"
		}, ...y.map((e) => ({
			value: e,
			label: Oi[e]
		}))],
		ariaLabel: "Your role"
	}))));
}
function Li({ view: e, now: t }) {
	let { Badge: n, Button: r, Card: i, Row: a, Stack: o, tokens: s } = Z, c = e.room, l = e.engine;
	if (!c) return null;
	let u = c.transport === "folder" ? `Shared folder: ${c.folderLabel || "chosen folder"}. It keeps the record; through it, changes take seconds to minutes.` : e.relayMode === "socket" ? "Relay, live connection." : "Relay, checked every few seconds.", d = e.phase === "running" ? l?.phase === "live" ? "Connected" : l?.phase === "offline" ? "Offline" : l?.phase === "problem" ? "Problem" : "Connecting" : e.phase === "starting" ? "Starting" : e.phase === "problem" ? "Problem" : "Paused", f = e.phase === "problem" ? e.problem : l?.phase === "live" ? "" : l?.detail ?? "";
	return /* @__PURE__ */ X.createElement(i, null, /* @__PURE__ */ X.createElement(o, { gap: 6 }, /* @__PURE__ */ X.createElement(a, { justify: "space-between" }, /* @__PURE__ */ X.createElement("span", { style: {
		fontSize: 11,
		color: s.textPrimary
	} }, "Room"), /* @__PURE__ */ X.createElement(n, null, d)), /* @__PURE__ */ X.createElement("span", { style: $(s.textSecondary) }, u), f && /* @__PURE__ */ X.createElement("span", { style: $(s.labelRed) }, f), l && l.members.length > 0 && /* @__PURE__ */ X.createElement("span", { style: $(s.textSecondary) }, "Connected directly to ", l.members.filter((e) => e.link === "direct").length, " of ", l.members.length, " ", l.members.length === 1 ? "teammate" : "teammates"), e.phase === "other-project" && /* @__PURE__ */ X.createElement(o, { gap: 6 }, /* @__PURE__ */ X.createElement("span", { style: $(s.textSecondary) }, "This room follows ", c.project || "another project", ". Open it to sync, or let the room follow the project open now."), /* @__PURE__ */ X.createElement(r, {
		size: "sm",
		onClick: () => void Q.useOpenProject()
	}, "Use this project")), e.phase === "no-project" && /* @__PURE__ */ X.createElement("span", { style: $(s.textSecondary) }, "Open the shoot's folder to sync."), l && l.unsent > 0 && /* @__PURE__ */ X.createElement("span", { style: $(s.textSecondary) }, l.unsent, " ", l.unsent === 1 ? "change" : "changes", " waiting to be sent"), l && l.rejected > 0 && /* @__PURE__ */ X.createElement("span", { style: $(s.labelYellow) }, l.rejected, " ", l.rejected === 1 ? "entry" : "entries", " turned away: not sealed with this room's code"), l?.held.map((e) => /* @__PURE__ */ X.createElement("span", {
		key: e.by,
		style: $(s.labelYellow)
	}, e.name, "'s clock runs ", ji(e.aheadMs), " ahead; their changes wait until it is set right.")), c.transport === "relay" && e.phase === "running" && e.relayMode === "poll" && e.socketAccess !== "unavailable" && /* @__PURE__ */ X.createElement(zi, {
		relayUrl: c.relayUrl,
		access: e.socketAccess
	}), /* @__PURE__ */ X.createElement("span", { style: $(s.textMuted) }, "Last change from the team: ", Ai(Ri(e), t)), e.roomId && /* @__PURE__ */ X.createElement("span", { style: {
		...$(s.textMuted),
		fontFamily: s.fontCode,
		userSelect: "text"
	} }, "Room id ", e.roomId)));
}
function Ri(e) {
	let t = (e.engine?.members ?? []).map((e) => e.lastChangeAt).filter((e) => e !== null);
	return t.length ? Math.max(...t) : null;
}
function zi({ relayUrl: e, access: t }) {
	let { Button: n, tokens: r } = Z;
	return t === "after-restart" ? /* @__PURE__ */ X.createElement("span", { style: $(r.textSecondary) }, "Restart Safelight to switch to the live connection.") : /* @__PURE__ */ X.createElement(n, {
		size: "sm",
		onClick: () => void Q.allowLiveConnection(e)
	}, "Use a live connection");
}
function Bi({ view: e, now: t }) {
	let { Section: n, Stack: r, Row: i, tokens: a } = Z, o = e.engine?.members ?? [];
	return /* @__PURE__ */ X.createElement(n, { title: "People" }, o.length === 0 ? /* @__PURE__ */ X.createElement("span", { style: $(a.textMuted) }, "Nobody else has been heard from yet.") : /* @__PURE__ */ X.createElement(r, { gap: 4 }, o.map((e) => /* @__PURE__ */ X.createElement(i, {
		key: e.id,
		gap: 6,
		align: "baseline"
	}, /* @__PURE__ */ X.createElement("span", { style: {
		width: 6,
		height: 6,
		borderRadius: 3,
		flex: "none",
		background: e.fresh ? a.labelGreen : a.textMuted
	} }), /* @__PURE__ */ X.createElement("span", { style: {
		fontSize: 11,
		color: a.textPrimary
	} }, e.name), e.role && /* @__PURE__ */ X.createElement("span", { style: $(a.textMuted) }, Oi[e.role]), /* @__PURE__ */ X.createElement("span", { style: {
		...$(a.textSecondary),
		flex: 1,
		minWidth: 0,
		overflow: "hidden",
		textOverflow: "ellipsis",
		whiteSpace: "nowrap"
	} }, e.fresh ? e.photo ? `${Ni(e.module, e.editing, e.role)} ${Q.photoNameFor(e.photo)}` : Ni(e.module, !1, e.role) : `seen ${Ai(e.seenAt, t)}`), /* @__PURE__ */ X.createElement("span", { style: {
		...$(e.link === "direct" ? a.labelGreen : a.textMuted),
		flex: "none"
	} }, Mi(e))))));
}
function Vi({ view: e }) {
	let { Button: t, Section: n, SegmentedControl: r, Stack: i, tokens: a } = Z, o = e.here.selectedIds.length ? e.here.selectedIds : e.here.photoId ? [e.here.photoId] : [], s = e.here.photoId, c = s ? Q.photoInfo(s) : null;
	return !s || !c ? null : /* @__PURE__ */ X.createElement(n, { title: o.length > 1 ? `${o.length} photos` : "This photo" }, /* @__PURE__ */ X.createElement(i, { gap: 6 }, /* @__PURE__ */ X.createElement(r, {
		size: "sm",
		value: c.stage,
		onChange: (e) => {
			let t = Me(e) ? e : void 0;
			t && Q.setStage(o, t);
		},
		options: Ee.map((e) => ({
			value: e,
			label: ki[e]
		}))
	}), c.editedBy.length > 0 && /* @__PURE__ */ X.createElement("span", { style: $(a.labelYellow) }, "Being edited by ", c.editedBy.join(", ")), c.viewedBy.length > 0 && /* @__PURE__ */ X.createElement("span", { style: $(a.textSecondary) }, "Also open for ", c.viewedBy.join(", ")), c.waitingEdit && /* @__PURE__ */ X.createElement(i, { gap: 4 }, /* @__PURE__ */ X.createElement("span", { style: $(a.textSecondary) }, "Someone changed this photo's edit. It is applied when you leave the photo, or now:"), /* @__PURE__ */ X.createElement(t, {
		size: "sm",
		onClick: () => void Q.applyWaitingEdit(s)
	}, "Apply their edit")), c.tooBig && /* @__PURE__ */ X.createElement("span", { style: $(a.textMuted) }, "Part of this edit is too big to share (over 200 KB) and stays here.")));
}
function Hi({ view: e }) {
	let { Button: t, Row: n, Section: r, Stack: i, TextInput: a, tokens: o } = Z, [s, c] = X.useState(""), [l, u] = X.useState(null), d = e.here.selectedIds.length ? e.here.selectedIds : e.here.photoId ? [e.here.photoId] : [], f = e.here.photoId ? Q.photoInfo(e.here.photoId) : null, p = () => {
		Q.createCollection(s) && c("");
	};
	return /* @__PURE__ */ X.createElement(r, { title: "Team collections" }, /* @__PURE__ */ X.createElement(i, { gap: 4 }, e.collections.map((r) => {
		let i = e.filter.collection === r.id, s = f?.collections.includes(r.id) ?? !1;
		return l?.id === r.id ? /* @__PURE__ */ X.createElement(a, {
			key: r.id,
			value: l.name,
			autoFocus: !0,
			onChange: (e) => u({
				id: r.id,
				name: e
			}),
			onBlur: () => {
				Q.renameCollection(r.id, l.name), u(null);
			},
			onKeyDown: (e) => {
				e.key === "Enter" && e.currentTarget.blur(), e.key === "Escape" && u(null);
			},
			"aria-label": "Collection name"
		}) : /* @__PURE__ */ X.createElement(n, {
			key: r.id,
			gap: 4
		}, /* @__PURE__ */ X.createElement("span", {
			onDoubleClick: () => u({
				id: r.id,
				name: r.name
			}),
			title: "Double-click to rename",
			style: {
				fontSize: 11,
				color: o.textPrimary,
				flex: 1,
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			}
		}, r.name, " ", /* @__PURE__ */ X.createElement("span", { style: { color: o.textMuted } }, r.count)), /* @__PURE__ */ X.createElement(t, {
			size: "sm",
			variant: "ghost",
			active: i,
			title: "Show only this collection in the grid",
			onClick: () => Q.setFilter({
				...e.filter,
				collection: i ? "" : r.id
			})
		}, "Show"), /* @__PURE__ */ X.createElement(t, {
			size: "sm",
			variant: "ghost",
			disabled: d.length === 0,
			title: s ? "Take the selected photos out" : "Add the selected photos",
			onClick: () => Q.setInCollection(d, r.id, !s)
		}, s ? "Remove" : "Add"), /* @__PURE__ */ X.createElement(t, {
			size: "sm",
			variant: "ghost",
			title: "Delete this collection for everyone",
			onClick: () => void Z.confirmDialog({
				title: "Delete team collection",
				message: `Delete “${r.name}” for everyone in the room? The photos stay where they are.`,
				confirmLabel: "Delete",
				variant: "danger"
			}).then((e) => e && Q.deleteCollection(r.id))
		}, "✕"));
	}), /* @__PURE__ */ X.createElement(n, { gap: 4 }, /* @__PURE__ */ X.createElement("div", { style: { flex: 1 } }, /* @__PURE__ */ X.createElement(a, {
		value: s,
		onChange: c,
		onKeyDown: (e) => {
			e.key === "Enter" && p();
		},
		placeholder: "New collection",
		"aria-label": "New collection name"
	})), /* @__PURE__ */ X.createElement(t, {
		size: "sm",
		disabled: !s.trim(),
		onClick: p
	}, "New"))));
}
function Ui({ view: e }) {
	let { Section: t, Select: n, Stack: r, Toggle: i } = Z;
	return /* @__PURE__ */ X.createElement(t, { title: "Grid" }, /* @__PURE__ */ X.createElement(r, { gap: 6 }, /* @__PURE__ */ X.createElement(n, {
		value: e.filter.stage,
		onChange: (t) => Q.setFilter({
			...e.filter,
			stage: Me(t) ? t : ""
		}),
		options: [{
			value: "",
			label: "Every stage"
		}, ...Ee.map((e) => ({
			value: e,
			label: `Only ${ki[e].toLowerCase()}`
		}))],
		ariaLabel: "Show photos at stage"
	}), /* @__PURE__ */ X.createElement(i, {
		checked: e.filter.hideOthersEditing,
		onChange: (t) => Q.setFilter({
			...e.filter,
			hideOthersEditing: t
		}),
		label: "Hide photos others are editing"
	})));
}
function Wi({ view: e }) {
	let { Button: t, Field: n, Section: r, Stack: i, TextInput: a, Toggle: o, tokens: s } = Z, c = e.realtime.turn, [l, u] = X.useState(c?.url ?? ""), [d, f] = X.useState(c?.username ?? ""), [p, m] = X.useState(c?.credential ?? "");
	if (!e.directAvailable) return /* @__PURE__ */ X.createElement(r, { title: "Connections" }, /* @__PURE__ */ X.createElement("span", { style: $(s.textMuted) }, "Direct connections aren't available in this window."));
	let h = Ce(l), g = l !== (c?.url ?? "") || d !== (c?.username ?? "") || p !== (c?.credential ?? "");
	return /* @__PURE__ */ X.createElement(r, { title: "Connections" }, /* @__PURE__ */ X.createElement(i, { gap: 8 }, /* @__PURE__ */ X.createElement(o, {
		checked: e.realtime.publicSignalling,
		onChange: (t) => Q.setRealtime({
			...e.realtime,
			publicSignalling: t
		}),
		label: "Find teammates over the internet"
	}), /* @__PURE__ */ X.createElement("span", { style: $(s.textMuted) }, "Teammates connect directly, so changes arrive at once. To find each other they leave sealed notes on public Nostr relays and WebTorrent trackers, which see your IP address and a room tag that changes daily, never your photos or edits. Off, they find each other through ", e.room?.transport === "relay" ? "your relay" : "the shared folder, which is slower", "."), /* @__PURE__ */ X.createElement(n, {
		label: "TURN server (optional)",
		hint: "For networks that block direct connections, if your studio runs one: turn: or turns: address."
	}, /* @__PURE__ */ X.createElement(i, { gap: 4 }, /* @__PURE__ */ X.createElement(a, {
		value: l,
		onChange: u,
		placeholder: "turns:turn.your-studio.com:5349",
		"aria-label": "TURN server"
	}), /* @__PURE__ */ X.createElement(a, {
		value: d,
		onChange: f,
		placeholder: "User name",
		"aria-label": "TURN user name"
	}), /* @__PURE__ */ X.createElement(a, {
		value: p,
		onChange: m,
		type: "password",
		placeholder: "Password",
		"aria-label": "TURN password"
	}), /* @__PURE__ */ X.createElement(t, {
		size: "sm",
		disabled: !g || l !== "" && !h,
		onClick: () => Q.setRealtime({
			...e.realtime,
			turn: h ? {
				url: h,
				username: d,
				credential: p
			} : null
		})
	}, "Save")))));
}
function Gi({ autoStage: e }) {
	let { Button: t, Row: n, Stack: r, Toggle: i } = Z, [a, o] = X.useState(!1);
	return /* @__PURE__ */ X.createElement(r, { gap: 8 }, /* @__PURE__ */ X.createElement(i, {
		checked: e,
		onChange: (e) => Q.setAutoStage(e),
		label: "Advance stages automatically"
	}), /* @__PURE__ */ X.createElement(n, { gap: 6 }, /* @__PURE__ */ X.createElement(t, {
		size: "sm",
		onClick: () => void Q.copyCode().then(() => {
			o(!0), setTimeout(() => o(!1), 2e3);
		})
	}, a ? "Copied" : "Copy room code"), /* @__PURE__ */ X.createElement(t, {
		size: "sm",
		variant: "danger",
		onClick: () => void Z.confirmDialog({
			title: "Leave room",
			message: "Stop syncing with this room on this computer? Your catalogue keeps everything it has. You can join again with the room code.",
			confirmLabel: "Leave"
		}).then((e) => e ? Q.leaveRoom() : void 0)
	}, "Leave room")));
}
function Ki() {
	let { Stack: e, tokens: t } = Z, n = Pi(), r = Fi();
	return n.mainWindow ? /* @__PURE__ */ X.createElement("div", { style: { padding: 10 } }, /* @__PURE__ */ X.createElement(e, { gap: 14 }, /* @__PURE__ */ X.createElement(Ii, { view: n }), n.room ? /* @__PURE__ */ X.createElement(X.Fragment, null, /* @__PURE__ */ X.createElement(Li, {
		view: n,
		now: r
	}), n.phase === "running" && /* @__PURE__ */ X.createElement(X.Fragment, null, /* @__PURE__ */ X.createElement(Bi, {
		view: n,
		now: r
	}), /* @__PURE__ */ X.createElement(Vi, { view: n }), /* @__PURE__ */ X.createElement(Hi, { view: n }), /* @__PURE__ */ X.createElement(Ui, { view: n }), /* @__PURE__ */ X.createElement(Wi, { view: n })), /* @__PURE__ */ X.createElement(Gi, { autoStage: Q.autoStage() })) : /* @__PURE__ */ X.createElement(Di, null))) : /* @__PURE__ */ X.createElement("div", { style: {
		padding: 10,
		...$(t.textSecondary)
	} }, "Studio Collab runs in the main window. What you change here reaches the room through it.");
}
//#endregion
//#region src/ui/PresenceBar.tsx
function qi() {
	let { tokens: e } = Z, t = Pi(), n = (t.engine?.members ?? []).filter((e) => e.fresh);
	return t.phase !== "running" || n.length === 0 ? null : /* @__PURE__ */ X.createElement("div", { style: {
		display: "flex",
		gap: 14,
		padding: "3px 10px",
		fontSize: 11,
		color: e.textSecondary,
		borderBottom: `1px solid ${e.borderSubtle}`,
		overflow: "hidden",
		whiteSpace: "nowrap"
	} }, n.map((t) => /* @__PURE__ */ X.createElement("span", {
		key: t.id,
		style: {
			display: "inline-flex",
			alignItems: "center",
			gap: 5
		}
	}, /* @__PURE__ */ X.createElement("span", { style: {
		width: 6,
		height: 6,
		borderRadius: 3,
		background: t.editing ? e.labelYellow : e.labelGreen
	} }), /* @__PURE__ */ X.createElement("span", { style: { color: e.textPrimary } }, t.name), t.photo && /* @__PURE__ */ X.createElement("span", null, Ni(t.module, t.editing, t.role), " ", Q.photoNameFor(t.photo)))));
}
//#endregion
//#region src/index.tsx
var Ji = `${se}.panel`, Yi = null;
function Xi(e) {
	let t = /* @__PURE__ */ new Set(), n = new ui(Ti(e, t));
	Yi = n, Ei(e.react, e.ui, n), e.registerPanel({
		id: Ji,
		title: "Studio Collab",
		component: Ki,
		defaultDock: {
			module: "library",
			direction: "right"
		}
	}), e.registerSlot({
		id: `${se}.presence`,
		slot: "library-subbar",
		component: qi
	}), e.registerCatalogHooks({
		id: `${se}.edits`,
		onEditCommit: async ({ photo: e }) => {
			for (let n of t) n(e.id);
		}
	}), e.registerExportProcessor({
		id: `${se}.exported`,
		label: "Studio Collab",
		settings: [{
			key: "markExported",
			label: "Mark exported photos as Exported for the team",
			type: "boolean",
			default: !0
		}],
		process: async (e, t, r) => (r.markExported !== !1 && n.markExported(t.id), e)
	}), n.start();
}
function Zi() {
	Yi?.dispose(), Yi = null;
}
//#endregion
export { Ji as PANEL_ID, Xi as activate, Zi as deactivate };

//# sourceMappingURL=index.js.map