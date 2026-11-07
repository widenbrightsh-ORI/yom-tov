// גמד וענק — הגרלה מוצפנת שאף אחד (כולל המארגן) לא יכול לראות.
//
// איך זה עובד:
// 1. המארגן יוצר אירוע עם רשימת שמות ושולח קישור הצטרפות לקבוצה.
// 2. כל משתתף פותח את הקישור בטלפון שלו, בוחר את שמו ובוחר קוד סודי (PIN).
//    הטלפון יוצר זוג מפתחות (ECDH P-256). המפתח הפרטי נשמר רק בטלפון, מוצפן ב-PIN.
//    המשתתף שולח למארגן "קוד הרשמה" שמכיל רק את המפתח הציבורי.
// 3. כשכולם נרשמו, המארגן מגריל: סבב אחד שסוגר את כל המשפחה (כל אחד נותן
//    בדיוק לאחד ומקבל בדיוק מאחד, אף אחד לא מקבל את עצמו). שם הענק של כל אחד
//    מוצפן במפתח הציבורי שלו. ההגרלה לא מוצגת ולא נשמרת אצל המארגן.
// 4. המארגן שולח קישור תוצאות אחד לכולם. כל אחד מפענח רק את השורה שלו.
'use strict';

const $app = document.getElementById('app');
const enc = new TextEncoder();
const dec = new TextDecoder();
const PAD = 96;            // אורך קבוע לשם המוצפן — כדי שאורך ההצפנה לא יסגיר את השם
const MAX_NAME = 30;
const PBKDF2_ITER = 310000;
const RESULT_VER = 1;
const REG_PREFIX = 'GMD1-';

// ───────── helpers ─────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function b64u(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const cleanName = (s) => s.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
const baseUrl = () => location.origin + location.pathname;

function store(key, val) {
  try {
    if (val === undefined) return JSON.parse(localStorage.getItem(key) || 'null');
    if (val === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(val));
  } catch (_) { return null; }
}
const orgKey = (e) => 'gamad:org:' + e;
const meKey = (e) => 'gamad:me:' + e;
function listIds(prefix) {
  const ids = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith(prefix)) ids.push(k.slice(prefix.length));
    }
  } catch (_) { /* no storage */ }
  return ids;
}

function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 1800);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('הועתק'); }
  catch (_) { prompt('העתיקו:', text); }
}
async function share(text, url) {
  if (navigator.share) {
    try { await navigator.share({ text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  copy(url ? text + '\n' + url : text);
}
function waPhone(p) {
  let d = (p || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '972' + d.slice(1);
  return d;
}
const waLink = (phone, text) => 'https://wa.me/' + (phone ? waPhone(phone) : '') + '?text=' + encodeURIComponent(text);

// ───────── crypto ─────────
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
async function pinKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: PBKDF2_ITER, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function newIdentity(pin) {
  const kp = await crypto.subtle.generateKey(ECDH, true, ['deriveKey']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const salt = rand(16), iv = rand(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await pinKey(pin, salt), pkcs8));
  return { pub: b64u(pub), salt: b64u(salt), iv: b64u(iv), priv: b64u(ct) };
}
async function unlockIdentity(id, pin) {
  const k = await pinKey(pin, unb64u(id.salt));
  const pkcs8 = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(id.iv) }, k, unb64u(id.priv)); // throws on wrong PIN
  return crypto.subtle.importKey('pkcs8', pkcs8, ECDH, false, ['deriveKey']);
}
const sharedKey = (priv, pubBytes) => crypto.subtle.importKey('raw', pubBytes, ECDH, false, [])
  .then((pub) => crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, priv, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
const entryId = async (pubBytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', pubBytes)).slice(0, 8);

// מספר אקראי הוגן בטווח [0, n)
function randInt(n) {
  const lim = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= lim);
  return buf[0] % n;
}
// סבב יחיד: כל אחד נותן לבא אחריו, האחרון לראשון. אין מעגלים סגורים, אין "עצמי".
function drawCycle(names) {
  const a = names.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.map((gamad, i) => [gamad, a[(i + 1) % a.length]]);
}

// קוד הרשמה: eventId(8) | pub(65) | name(utf8)
function makeRegCode(eventId, name, pubB64) {
  return REG_PREFIX + b64u(concat(unb64u(eventId), unb64u(pubB64), enc.encode(name)));
}
function parseRegCode(code) {
  const raw = unb64u(code.slice(REG_PREFIX.length));
  if (raw.length < 8 + 65 + 1) throw new Error('short');
  return { e: b64u(raw.slice(0, 8)), pub: b64u(raw.slice(8, 73)), name: dec.decode(raw.slice(73)) };
}

// קישור תוצאות: ver(1) | eventId(8) | ephemeralPub(65) | entries[id(8) | iv(12) | ct(PAD+16)] ממוינות לפי id
async function encryptDraw(org) {
  const pairs = drawCycle(org.names);
  const eph = await crypto.subtle.generateKey(ECDH, false, ['deriveKey']);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const aad = unb64u(org.e);
  const entries = [];
  for (const [gamad, giant] of pairs) {
    const pub = unb64u(org.regs[gamad]);
    const key = await sharedKey(eph.privateKey, pub);
    const pt = new Uint8Array(PAD);
    pt.set(enc.encode(giant).slice(0, PAD));
    const iv = rand(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, pt));
    entries.push(concat(await entryId(pub), iv, ct));
  }
  pairs.length = 0; // לא שומרים את ההגרלה
  // מיון לפי מזהה — כך שסדר השורות לא מסגיר את הסבב
  entries.sort((x, y) => { for (let i = 0; i < 8; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });
  return b64u(concat(new Uint8Array([RESULT_VER]), aad, ephPub, ...entries));
}
async function decryptMine(resultB64, identity, pin) {
  const raw = unb64u(resultB64);
  if (raw[0] !== RESULT_VER) throw new Error('ver');
  const aad = raw.slice(1, 9), ephPub = raw.slice(9, 74);
  const myPub = unb64u(identity.pub);
  const myId = await entryId(myPub);
  const size = 8 + 12 + PAD + 16;
  const priv = await unlockIdentity(identity, pin).catch(() => { throw new Error('pin'); });
  for (let o = 74; o + size <= raw.length; o += size) {
    if (!eq(raw.slice(o, o + 8), myId)) continue;
    const key = await sharedKey(priv, ephPub);
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(o + 8, o + 20), additionalData: aad }, key, raw.slice(o + 20, o + size)));
    let end = pt.indexOf(0); if (end < 0) end = pt.length;
    return dec.decode(pt.slice(0, end));
  }
  throw new Error('missing');
}
const resultEventId = (resultB64) => b64u(unb64u(resultB64).slice(1, 9));

// ───────── routing ─────────
function parseHash() {
  const h = location.hash.slice(1);
  const i = h.indexOf('=');
  return i < 0 ? { k: h, v: '' } : { k: h.slice(0, i), v: h.slice(i + 1) };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
window.addEventListener('hashchange', render);

function render() {
  if (!window.crypto || !crypto.subtle) {
    $app.innerHTML = `<h1>🎁 גמד וענק</h1><div class="msg err">הדף חייב להיפתח בכתובת מאובטחת (https) כדי שההצפנה תעבוד.</div>`;
    return;
  }
  const { k, v } = parseHash();
  try {
    if (k === 'j' && v) return viewJoin(JSON.parse(dec.decode(unb64u(v))));
    if (k === 'r' && v) return viewResult(v);
    if (k === 'org' && v) return viewOrg(v);
    if (k === 'new') return viewNew();
  } catch (e) {
    $app.innerHTML = `<h1>🎁 גמד וענק</h1><div class="msg err">הקישור פגום. בקשו מהמארגן לשלוח אותו שוב.</div><a class="btn" href="#">לדף הבית</a>`;
    return;
  }
  viewHome();
}

// ───────── views ─────────
function viewHome() {
  const orgs = listIds('gamad:org:').map((e) => store(orgKey(e))).filter(Boolean);
  const mine = listIds('gamad:me:').map((e) => ({ e, ...store(meKey(e)) })).filter((m) => m.regs);
  $app.innerHTML = `
    <h1>🎁 גמד וענק</h1>
    <p class="sub">הגרלה משפחתית סודית — כל אחד רואה רק את הענק שלו. גם המארגן לא יודע מי קיבל את מי.</p>
    <div class="card">
      <h2>איך זה עובד</h2>
      <ol class="steps">
        <li>המארגן מכניס את רשימת השמות ושולח קישור הצטרפות לקבוצה.</li>
        <li>כל אחד בוחר את השם שלו, קובע קוד סודי (PIN) ושולח למארגן קוד הרשמה.</li>
        <li>כשכולם נרשמו — מגרילים. כל אחד מקבל שם, ואף אחד לא מקבל את עצמו.</li>
        <li>קישור תוצאות אחד לכולם; כל אחד פותח רק את שלו, עם ה-PIN, בטלפון שלו.</li>
      </ol>
      <a class="btn primary" href="#new">ארגון הגרלה חדשה</a>
    </div>
    ${orgs.length ? `<div class="card"><h2>הגרלות שאני מארגן/ת</h2>${orgs.map((o) =>
      `<a class="btn ghost" href="#org=${esc(o.e)}">${esc(o.t)} · ${Object.keys(o.regs).length}/${o.names.length} נרשמו</a>`).join('')}</div>` : ''}
    ${mine.length ? `<div class="card"><h2>הגרלות שנרשמתי אליהן</h2>${mine.map((m) =>
      `<p>${esc(m.t)} — ${Object.keys(m.regs).map(esc).join(', ')}</p>`).join('')}
      <p class="small">כדי לראות את הענק, פתחו את קישור התוצאות שהמארגן שלח.</p></div>` : ''}`;
}

function viewNew() {
  $app.innerHTML = `
    <a class="link small" href="#">→ חזרה</a>
    <h1>הגרלה חדשה</h1>
    <div class="card">
      <label for="t">שם האירוע</label>
      <input id="t" value="גמד וענק — משפחה" maxlength="60">
      <label for="p">הוואטסאפ שלך (כדי שישלחו לך את קודי ההרשמה) — לא חובה</label>
      <input id="p" type="tel" inputmode="tel" placeholder="050-0000000" dir="ltr">
      <label for="n">משתתפים — שם אחד בכל שורה (כולל את עצמך, אם משתתף/ת)</label>
      <textarea id="n" placeholder="אבא&#10;אמא&#10;דני&#10;..."></textarea>
      <div id="m"></div>
      <button class="btn primary" id="go">יצירה</button>
    </div>`;
  document.getElementById('go').onclick = () => {
    const t = cleanName(document.getElementById('t').value) || 'גמד וענק';
    const p = document.getElementById('p').value.trim();
    const names = document.getElementById('n').value.split('\n').map(cleanName).filter(Boolean);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    const m = document.getElementById('m');
    if (names.length < 3) { m.innerHTML = '<div class="msg err">צריך לפחות 3 משתתפים.</div>'; return; }
    if (dup) { m.innerHTML = `<div class="msg err">השם "${esc(dup)}" מופיע פעמיים. הוסיפו הבחנה (למשל "דני ק." ו"דני ש.").</div>`; return; }
    const e = b64u(rand(8));
    store(orgKey(e), { e, t, p, names, regs: {}, result: null });
    go('#org=' + e);
  };
}

function joinLink(o) {
  return baseUrl() + '#j=' + b64u(enc.encode(JSON.stringify({ e: o.e, t: o.t, p: o.p, n: o.names })));
}

function viewOrg(e, flash) {
  const o = store(orgKey(e));
  if (!o) return go('#');
  const missing = o.names.filter((n) => !o.regs[n]);
  const jl = joinLink(o);
  const rl = o.result ? baseUrl() + '#r=' + o.result : '';
  $app.innerHTML = `
    <a class="link small" href="#">→ דף הבית</a>
    <h1>${esc(o.t)}</h1>
    <p class="sub">🔒 המסך הזה לעולם לא מציג מי קיבל את מי — גם לא לך.</p>
    ${flash || ''}

    <div class="card">
      <h2>1 · שליחת קישור הצטרפות</h2>
      <p class="small">שלחו לקבוצת המשפחה. כל אחד יבחר את שמו ויקבל קוד הרשמה לשלוח אליך.</p>
      <a class="btn wa" target="_blank" rel="noopener" href="${esc(waLink('', `🎁 ${o.t}\nהיכנסו, בחרו את השם שלכם ושלחו לי את קוד ההרשמה:\n${jl}`))}">שליחה בוואטסאפ</a>
      <div class="row"><button class="btn ghost" id="shareJ">שיתוף…</button><button class="btn ghost" id="copyJ">העתקה</button></div>
    </div>

    <div class="card">
      <h2>2 · קודי הרשמה (${o.names.length - missing.length}/${o.names.length})</h2>
      <label for="codes">הדביקו כאן את מה שקיבלתם (אפשר כמה הודעות ביחד)</label>
      <textarea id="codes" placeholder="GMD1-…" dir="ltr" style="min-height:80px"></textarea>
      <button class="btn" id="add">הוספה</button>
      <ul class="list">${o.names.map((n) => `<li><span>${esc(n)}</span>
        <span>${o.regs[n] ? '<span class="ok">✓ נרשם/ה</span>' : '<span class="wait">ממתין</span>'}
        <button class="x" data-del="${esc(n)}" title="הסרה מהרשימה">✕</button></span></li>`).join('')}</ul>
      <div class="row"><input id="newName" placeholder="הוספת משתתף/ת" maxlength="${MAX_NAME}"><button class="btn" id="addName" style="width:auto;margin-top:0">+</button></div>
      <p class="small">אם הוספתם שם — שלחו לו/ה שוב את קישור ההצטרפות (הוא מתעדכן).</p>
    </div>

    <div class="card">
      <h2>3 · הגרלה</h2>
      ${missing.length
        ? `<div class="msg info">ממתינים ל: ${missing.map(esc).join(', ')}. אי אפשר להגריל עד שכולם נרשמו — כדי שאף אחד לא יפוספס.</div>`
        : (o.result ? '' : '<div class="msg good">כולם נרשמו! אפשר להגריל.</div>')}
      ${o.result ? `
        <div class="msg good">ההגרלה בוצעה. כל ${o.names.length} המשתתפים מקבלים שם, בסבב אחד שסוגר את כולם.</div>
        <p class="small">שלחו את קישור התוצאות לקבוצה. כל אחד יפתח אותו בטלפון שבו נרשם ויכניס את ה-PIN שלו.</p>
        <a class="btn wa" target="_blank" rel="noopener" href="${esc(waLink('', `🎁 ${o.t} — ההגרלה בוצעה!\nפתחו בטלפון שבו נרשמתם והכניסו את הקוד הסודי שלכם:\n${rl}`))}">שליחת התוצאות בוואטסאפ</a>
        <div class="row"><button class="btn ghost" id="shareR">שיתוף…</button><button class="btn ghost" id="copyR">העתקה</button></div>
        <button class="btn danger" id="redraw">הגרלה מחדש</button>`
        : `<button class="btn primary" id="draw" ${missing.length ? 'disabled' : ''}>🎲 הגרלה</button>`}
    </div>
    <button class="btn danger" id="delEvt">מחיקת האירוע מהמכשיר</button>`;

  const save = () => store(orgKey(e), o);
  document.getElementById('shareJ').onclick = () => share(`🎁 ${o.t} — בחרו את השם שלכם ושלחו לי את קוד ההרשמה`, jl);
  document.getElementById('copyJ').onclick = () => copy(jl);
  document.getElementById('add').onclick = () => {
    const text = document.getElementById('codes').value;
    const found = text.match(/GMD1-[A-Za-z0-9_-]+/g) || [];
    const msgs = [];
    let added = 0;
    for (const c of found) {
      let r;
      try { r = parseRegCode(c); } catch (_) { msgs.push('קוד אחד פגום — בקשו לשלוח שוב.'); continue; }
      if (r.e !== o.e) { msgs.push(`הקוד של "${r.name}" שייך להגרלה אחרת.`); continue; }
      if (!o.names.includes(r.name)) { msgs.push(`"${r.name}" לא ברשימה — הוסיפו את השם ואז הדביקו שוב.`); continue; }
      if (o.regs[r.name] && o.regs[r.name] !== r.pub) msgs.push(`"${r.name}" נרשם/ה מחדש — הקוד עודכן.`);
      o.regs[r.name] = r.pub; added++;
    }
    if (!found.length) msgs.push('לא נמצא קוד הרשמה בטקסט.');
    if (added && o.result) { o.result = null; msgs.push('ההרשמות השתנו — צריך להגריל שוב.'); }
    save();
    viewOrg(e, (added ? `<div class="msg good">נוספו ${added} קודים.</div>` : '') + msgs.map((m) => `<div class="msg err">${esc(m)}</div>`).join(''));
  };
  document.getElementById('addName').onclick = () => {
    const n = cleanName(document.getElementById('newName').value);
    if (!n || o.names.includes(n)) return;
    o.names.push(n); o.result = null; save(); viewOrg(e);
  };
  $app.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
    const n = b.dataset.del;
    if (!confirm(`להסיר את "${n}" מההגרלה?`)) return;
    o.names = o.names.filter((x) => x !== n); delete o.regs[n]; o.result = null; save(); viewOrg(e);
  });
  const draw = async () => {
    if (o.names.length < 3) { viewOrg(e, '<div class="msg err">צריך לפחות 3 משתתפים.</div>'); return; }
    o.result = await encryptDraw(o); save();
    viewOrg(e);
  };
  const d = document.getElementById('draw');
  if (d) d.onclick = draw;
  const rd = document.getElementById('redraw');
  if (rd) rd.onclick = () => { if (confirm('הגרלה מחדש תבטל את הקודמת. צריך לשלוח לכולם את הקישור החדש. להמשיך?')) draw(); };
  if (rl) {
    document.getElementById('shareR').onclick = () => share(`🎁 ${o.t} — ההגרלה בוצעה! פתחו והכניסו את הקוד הסודי שלכם`, rl);
    document.getElementById('copyR').onclick = () => copy(rl);
  }
  document.getElementById('delEvt').onclick = () => { if (confirm('למחוק את האירוע מהמכשיר הזה?')) { store(orgKey(e), null); go('#'); } };
}

function viewJoin(ev, selected) {
  const me = store(meKey(ev.e)) || { t: ev.t, regs: {} };
  const sel = selected || null;
  $app.innerHTML = `
    <h1>🎁 ${esc(ev.t)}</h1>
    <p class="sub">בחרו את השם שלכם וקבעו קוד סודי. רק אתם תוכלו לראות את הענק שלכם — בטלפון הזה, עם הקוד הזה.</p>
    <div class="card">
      <h2>מי את/ה?</h2>
      <div class="names">${ev.n.map((n) => `<button class="name-btn ${n === sel ? 'sel' : ''}" data-n="${esc(n)}">${esc(n)}${me.regs[n] ? '<span class="tag">✓ נרשם בטלפון הזה</span>' : ''}</button>`).join('')}</div>
    </div>
    <div id="step"></div>`;
  $app.querySelectorAll('[data-n]').forEach((b) => b.onclick = () => viewJoin(ev, b.dataset.n));
  if (!sel) return;
  const step = document.getElementById('step');
  if (me.regs[sel]) return showRegCode(ev, sel, me.regs[sel], step, true);
  step.innerHTML = `
    <div class="card">
      <h2>קוד סודי ל${esc(sel)}</h2>
      <p class="small">לפחות 4 ספרות. תצטרכו אותו כדי לראות את הענק — אל תגלו לאף אחד.</p>
      <label for="p1">קוד סודי</label><input id="p1" class="pin" type="password" inputmode="numeric" autocomplete="new-password">
      <label for="p2">שוב, לאימות</label><input id="p2" class="pin" type="password" inputmode="numeric" autocomplete="new-password">
      <div id="m"></div>
      <button class="btn primary" id="reg">הרשמה</button>
    </div>`;
  document.getElementById('reg').onclick = async (evt) => {
    const p1 = document.getElementById('p1').value, p2 = document.getElementById('p2').value;
    const m = document.getElementById('m');
    if (p1.length < 4) { m.innerHTML = '<div class="msg err">הקוד קצר מדי.</div>'; return; }
    if (p1 !== p2) { m.innerHTML = '<div class="msg err">הקודים לא תואמים.</div>'; return; }
    evt.target.disabled = true; evt.target.textContent = 'יוצר מפתח…';
    const id = await newIdentity(p1);
    me.t = ev.t; me.regs[sel] = id;
    store(meKey(ev.e), me);
    if (!store(meKey(ev.e))) { m.innerHTML = '<div class="msg err">לא ניתן לשמור בדפדפן הזה (אולי מצב גלישה בסתר?). פתחו בדפדפן רגיל.</div>'; return; }
    showRegCode(ev, sel, id, step, false);
  };
}

function showRegCode(ev, name, id, el, existing) {
  const code = makeRegCode(ev.e, name, id.pub);
  const text = `קוד ההרשמה של ${name} ל"${ev.t}":\n${code}`;
  el.innerHTML = `
    <div class="card">
      <h2>${existing ? '' : '✓ '}${esc(name)} — ${existing ? 'כבר נרשמת בטלפון הזה' : 'נרשמת!'}</h2>
      <p>עכשיו שלחו את הקוד הזה למארגן. הוא לא מגלה שום דבר סודי.</p>
      <div class="code">${esc(code)}</div>
      ${ev.p ? `<a class="btn wa" target="_blank" rel="noopener" href="${esc(waLink(ev.p, text))}">שליחה למארגן בוואטסאפ</a>` : ''}
      <div class="row"><button class="btn ghost" id="shareC">שיתוף…</button><button class="btn ghost" id="copyC">העתקה</button></div>
      <div class="msg info">חשוב: את הענק תוכלו לראות רק <b>בטלפון הזה ובדפדפן הזה</b>, עם הקוד הסודי שבחרתם. אל תמחקו נתוני גלישה עד אחרי ההגרלה.</div>
      ${existing ? '<button class="btn danger" id="rereg">שכחתי את הקוד — הרשמה מחדש</button>' : ''}
    </div>`;
  document.getElementById('shareC').onclick = () => share(text);
  document.getElementById('copyC').onclick = () => copy(text);
  const rr = document.getElementById('rereg');
  if (rr) rr.onclick = () => {
    if (!confirm('הרשמה מחדש תיצור קוד הרשמה חדש, ותצטרכו לשלוח אותו שוב למארגן. אם כבר הוגרל — המארגן יצטרך להגריל שוב. להמשיך?')) return;
    const me = store(meKey(ev.e));
    delete me.regs[name]; store(meKey(ev.e), me);
    viewJoin(ev, name);
  };
}

function viewResult(r, chosen) {
  let e;
  try { e = resultEventId(r); } catch (_) { throw new Error('bad'); }
  const me = store(meKey(e));
  const names = me ? Object.keys(me.regs) : [];
  if (!names.length) {
    $app.innerHTML = `
      <h1>🎁 גמד וענק</h1>
      <div class="card"><div class="lock">🔒</div>
      <p>לא נמצאה הרשמה בטלפון/דפדפן הזה.</p>
      <p class="small">פתחו את הקישור באותו טלפון ובאותו דפדפן שבהם נרשמתם (אם נפתח בתוך וואטסאפ — נסו "פתיחה בדפדפן"). אם עדיין לא מסתדר, פנו למארגן.</p></div>`;
    return;
  }
  const sel = chosen || (names.length === 1 ? names[0] : null);
  $app.innerHTML = `
    <h1>🎁 ${esc(me.t || 'גמד וענק')}</h1>
    ${names.length > 1 ? `<div class="card"><h2>מי את/ה?</h2><div class="names">${names.map((n) =>
      `<button class="name-btn ${n === sel ? 'sel' : ''}" data-n="${esc(n)}">${esc(n)}</button>`).join('')}</div></div>` : ''}
    <div id="step"></div>`;
  $app.querySelectorAll('[data-n]').forEach((b) => b.onclick = () => viewResult(r, b.dataset.n));
  if (!sel) return;
  const step = document.getElementById('step');
  step.innerHTML = `
    <div class="card">
      <div class="lock">🔒</div>
      <h2 style="text-align:center">${esc(sel)}, הכניסו את הקוד הסודי</h2>
      <p class="small" style="text-align:center">ודאו שאף אחד לא מסתכל על המסך 👀</p>
      <input id="pin" class="pin" type="password" inputmode="numeric" autocomplete="off">
      <div id="m"></div>
      <button class="btn primary" id="open">גלה לי את הענק שלי</button>
    </div>`;
  const pinEl = document.getElementById('pin');
  pinEl.focus();
  const open = async (evt) => {
    const btn = document.getElementById('open');
    const m = document.getElementById('m');
    btn.disabled = true; btn.textContent = 'מפענח…';
    try {
      const giant = await decryptMine(r, me.regs[sel], pinEl.value);
      step.innerHTML = `
        <div class="card reveal">
          <div class="lbl">${esc(sel)}, את/ה הגמד/ה של</div>
          <div class="giant">${esc(giant)}</div>
          <div class="lbl">🤫 שמרו בסוד!</div>
          <button class="btn ghost" id="hide">הסתרה</button>
        </div>`;
      document.getElementById('hide').onclick = () => viewResult(r, sel);
    } catch (err) {
      btn.disabled = false; btn.textContent = 'גלה לי את הענק שלי';
      m.innerHTML = `<div class="msg err">${err.message === 'pin' ? 'קוד שגוי.'
        : err.message === 'missing' ? 'לא נמצאת בהגרלה הזו — כנראה ההרשמה שלך לא הגיעה למארגן לפני ההגרלה, או שנרשמת מחדש. פנו למארגן.'
        : 'הקישור פגום. בקשו מהמארגן לשלוח אותו שוב.'}</div>`;
    }
  };
  document.getElementById('open').onclick = open;
  pinEl.onkeydown = (ev) => { if (ev.key === 'Enter') open(); };
}

render();
