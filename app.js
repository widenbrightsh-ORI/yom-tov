/* יום טוב — שלב 1+2: מסך ראשי, ניקוד, שמירה, סגירת יום, טיימר כתיבה */
(() => {
  'use strict';

  // ───────── settings ─────────
  const DEFAULT_SETTINGS = {
    times: {
      screenOff: '22:30',
      sleep: '23:00',
      wake: '06:00',
      writing: '20:30',
      // מהשעה הזו בלוק "ערב קודם" נקשר ליום המחר (כדי שתסמן אותו לפני השינה)
      eveningStart: '20:00',
    },
    weights: {
      prayer: 2, work: 2, writing: 2,
      sleepEarly: 1, wake: 1, workout: 1,
      calories: 0.5, home: 0.5,
      screenOff: 0,
    },
    goodThreshold: 8,      // מעל זה (וגם ליבה) = "טוב"
    writingMinutes: 10,
    togglUrl: 'toggl://',  // deep link לאפליקציית Toggl Track
    reminders: {           // עד 4 ביום
      prev:    { on: true,  time: '21:30', text: 'ערב קודם: כיבוי מסך ב־22:30, ולהגדיר על מה עובדים מחר' },
      morning: { on: true,  time: '06:00', text: 'בוקר: תפילה ואימון' },
      day:     { on: false, time: '12:00', text: 'יום: בלוק עבודה, קלוריות, קשר עם הבית' },
      evening: { on: true,  time: '20:30', text: 'ערב: 10 דקות כתיבה, ואז סגירת יום' },
    },
  };
  const ITEM_HE = { prayer: 'תפילה', work: 'בלוק עבודה', writing: 'כתיבה', sleepEarly: 'שינה מוקדמת', wake: 'התעוררות מוקדמת', workout: 'אימון', calories: 'רישום קלוריות', home: 'קשר עם הבית', screenOff: 'כיבוי מסך' };
  const ITEM_ORDER = ['prayer', 'work', 'writing', 'sleepEarly', 'wake', 'workout', 'calories', 'home', 'screenOff'];

  // ───────── storage ─────────
  const KEY = { days: 'yt:days', weeks: 'yt:weeks', settings: 'yt:settings', timer: 'yt:timer' };
  const load = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const drop = (k) => { try { localStorage.removeItem(k); } catch {} };

  function deepMerge(a, b) {
    const out = { ...a };
    for (const k of Object.keys(b || {})) {
      out[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k] || {}, b[k]) : b[k];
    }
    return out;
  }
  const state = {
    days: load(KEY.days, {}),
    weeks: load(KEY.weeks, {}),
    settings: deepMerge(DEFAULT_SETTINGS, load(KEY.settings, {})),
    timer: load(KEY.timer, null), // { date, endsAt, total }
    view: 'today',
  };
  const persistDays = () => save(KEY.days, state.days);
  const persistWeeks = () => save(KEY.weeks, state.weeks);
  const persistSettings = () => save(KEY.settings, state.settings);

  // ───────── dates ─────────
  // לבדיקה: ?now=2026-09-14T21:45 מדמה שעה אחרת
  const NOW = () => { const q = new URLSearchParams(location.search).get('now'); const d = q ? new Date(q) : null; return d && !isNaN(d) ? d : new Date(); };
  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const mins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const nowMins = (d) => d.getHours() * 60 + d.getMinutes();
  const fmtDate = new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });

  function emptyDay(date) {
    return {
      date,
      items: { screenOff: false, sleepEarly: false, wake: false, prayer: false, workout: false, calories: false, home: false, writing: false },
      workBlocks: 0,
      focus: '',          // "על מה אני עובד היום" — נכתב אתמול בערב
      closing: null,      // { boundary: 'yes'|'partial'|'no', worked, failed, closedAt }
      score: 0,
      status: 'fell',
    };
  }
  function getDay(date) {
    if (!state.days[date]) state.days[date] = emptyDay(date);
    const d = state.days[date];
    d.items = { ...emptyDay(date).items, ...(d.items || {}) };
    return d;
  }

  // ───────── scoring ─────────
  function scoreDay(day) {
    const w = state.settings.weights;
    let s = 0;
    for (const k of Object.keys(w)) {
      if (k === 'work') { if (day.workBlocks > 0) s += w.work; }
      else if (day.items[k]) s += w[k];
    }
    const max = Object.values(w).reduce((a, b) => a + b, 0);
    const core = day.items.prayer && day.workBlocks > 0 && day.items.writing;
    const status = core && s >= state.settings.goodThreshold ? 'good' : core ? 'ok' : 'fell';
    day.score = Math.round(s * 10) / 10;
    day.status = status;
    return { score: day.score, max, status, core };
  }
  const STATUS_HE = { good: 'טוב', ok: 'בסדר', fell: 'נפל' };
  const RING_R = 48, RING_C = 2 * Math.PI * RING_R;
  const BOUNDARY_HE = { yes: 'כן', partial: 'חלקית', no: 'לא' };

  // ───────── time windows ─────────
  function timeWindows(now) {
    const t = state.settings.times;
    const wake = mins(t.wake), writing = mins(t.writing), eve = mins(t.eveningStart);
    const screenOff = mins(t.screenOff);
    const n = nowMins(now);
    const morningEnd = wake + 4 * 60;
    const prevStart = Math.max(eve, screenOff - 60);
    let active;
    if (n >= prevStart || n < wake) active = 'prev';
    else if (n < morningEnd) active = 'morning';
    else if (n < writing) active = 'day';
    else active = 'evening';
    return { active, bindPrevToTomorrow: n >= eve, wake, morningEnd, writing, prevStart };
  }

  // ───────── helpers ─────────
  const CHECK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path class="tick" d="M3 8.5l3.2 3L13 4.5" pathLength="1"/></svg>';
  const LINK_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3H3v10h10v-3M9 3h4v4M13 3L7 9"/></svg>';
  const PLAY_SVG = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtW = (w) => (w % 1 ? w.toFixed(1) : String(w));
  const fmtScore = (s) => (s % 1 ? s.toFixed(1) : String(s));
  const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };

  function checkRow({ key, day, label, sub, extra = '' }) {
    const w = state.settings.weights[key] ?? 0;
    const done = !!day.items[key];
    return `
      <div class="row ${done ? 'done' : ''}" data-row="${key}">
        <button class="hit" data-act="toggle" data-day="${day.date}" data-key="${key}" aria-pressed="${done}" aria-label="${label.replace(/<[^>]+>/g, '').trim()}">
          <span class="check">${CHECK_SVG}</span>
          <span class="lbl"><b>${label}</b>${sub ? `<span>${sub}</span>` : ''}</span>
          <span class="w">${w ? '+' + fmtW(w) : ''}</span>
        </button>
        ${extra}
      </div>`;
  }

  // ───────── render (DOM morph keeps transitions alive) ─────────
  function morph(from, to) {
    const a = Array.from(from.childNodes), b = Array.from(to.childNodes);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i], y = b[i];
      if (!y) { x.remove(); continue; }
      if (!x) { from.appendChild(y); continue; }
      if (x.nodeType !== y.nodeType || x.nodeName !== y.nodeName || (x.dataset && x.dataset.key !== y.dataset.key)) { from.replaceChild(y, x); continue; }
      if (x.nodeType === 3) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue; }
      if (x.nodeType !== 1) continue;
      for (const at of Array.from(x.attributes)) if (!y.hasAttribute(at.name)) x.removeAttribute(at.name);
      for (const at of Array.from(y.attributes)) if (x.getAttribute(at.name) !== at.value) x.setAttribute(at.name, at.value);
      if (x.tagName === 'INPUT' && document.activeElement !== x && x.value !== y.value) x.value = y.value;
      if (x.tagName === 'SVG' || x.tagName === 'svg') { if (x.innerHTML !== y.innerHTML) x.innerHTML = y.innerHTML; continue; }
      morph(x, y);
    }
  }

  let lastScore = null;
  const TABS = [['today', 'היום', 'M4 12l8-8 8 8M6 10v10h12V10'], ['week', 'שבוע', 'M4 20V10M10 20V4M16 20V13M22 20H2'], ['settings', 'הגדרות', 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z']];
  function tabbar() {
    const i = TABS.findIndex(([k]) => k === state.view);
    return `<nav class="tabbar" style="--i:${i}"><span class="ind"></span>${TABS.map(([k, label, d]) => `
      <button class="tab ${state.view === k ? 'on' : ''}" data-act="view" data-view="${k}" aria-label="${label}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg><span>${label}</span>
      </button>`).join('')}</nav>`;
  }

  function render() {
    if (state.view === 'week') return commit(renderWeek());
    if (state.view === 'settings') return commit(renderSettings());
    renderToday();
  }
  function commit(html, after) {
    const app = document.getElementById('app');
    const tpl = document.createElement('div');
    tpl.innerHTML = html + tabbar();
    if (!app.dataset.rendered) { app.dataset.rendered = '1'; app.innerHTML = tpl.innerHTML; }
    else morph(app, tpl);
    app.dataset.view = state.view;
    if (after) after(app);
  }

  function renderToday() {
    const now = NOW();
    const todayKey = dateKey(now);
    const today = getDay(todayKey);
    const tw = timeWindows(now);
    const t = state.settings.times;
    const prevDay = tw.bindPrevToTomorrow ? getDay(dateKey(addDays(now, 1))) : today;
    const focusToday = today.focus || '';
    const { score, max, status, core } = scoreDay(today);
    persistDays();

    const timerLive = state.timer && state.timer.date === todayKey && state.timer.endsAt > Date.now();
    const closing = today.closing;

    const blocks = {
      prev: {
        title: 'ערב קודם',
        time: tw.bindPrevToTomorrow ? 'הלילה · לקראת מחר' : 'אתמול בלילה',
        rows: [
          checkRow({ key: 'screenOff', day: prevDay, label: 'כיבוי מסך', sub: `עד <bdi>${t.screenOff}</bdi>` }),
          checkRow({ key: 'sleepEarly', day: prevDay, label: 'לישון מוקדם', sub: `עד <bdi>${t.sleep}</bdi>` }),
          `<div class="row static ${prevDay.focus ? 'done' : ''}" data-row="focus">
             <span class="lbl" style="flex:none"><b>${tw.bindPrevToTomorrow ? 'מחר אני עובד על' : 'היום אני עובד על'}</b></span>
             <input class="field" data-act="focus" data-day="${prevDay.date}" value="${esc(prevDay.focus)}" placeholder="שורה אחת…" maxlength="120" enterkeyhint="done">
           </div>`,
        ],
        done: prevDay.items.screenOff && prevDay.items.sleepEarly && !!prevDay.focus,
      },
      morning: {
        title: 'בוקר',
        time: `<bdi>${t.wake}–${pad(Math.floor(tw.morningEnd / 60))}:00</bdi>`,
        rows: [
          checkRow({ key: 'wake', day: today, label: 'התעוררות מוקדמת', sub: `עד <bdi>${t.wake}</bdi>` }),
          checkRow({ key: 'prayer', day: today, label: 'תפילה <em class="tag">ליבה</em>' }),
          checkRow({ key: 'workout', day: today, label: 'אימון' }),
        ],
        done: today.items.wake && today.items.prayer && today.items.workout,
      },
      day: {
        title: 'יום',
        time: `<bdi>${pad(Math.floor(tw.morningEnd / 60))}:00–${t.writing}</bdi>`,
        rows: [
          checkRow({ key: 'calories', day: today, label: 'רשמתי קלוריות', sub: 'באפליקציית התזונה' }),
          `<div class="row work ${today.workBlocks > 0 ? 'done' : ''}" data-row="work">
             <div class="hit top">
               <button class="check" data-act="work" data-dir="${today.workBlocks > 0 ? '0' : '1'}" aria-label="סמן בלוק עבודה">${CHECK_SVG}</button>
               <span class="lbl">
                 <b>בלוק עבודה <em class="tag">ליבה</em></b>
                 <span class="focus ${focusToday ? '' : 'empty'}">${focusToday ? esc(focusToday) : 'לא הוגדר אתמול — מה הדבר האחד?'}</span>
               </span>
               <span class="w">${today.workBlocks > 0 ? '+' + fmtW(state.settings.weights.work) : ''}</span>
             </div>
             <div class="tools">
               <span class="counter" aria-label="מספר בלוקים">
                 <button data-act="work" data-dir="-1" aria-label="פחות">−</button>
                 <span class="n"><span class="nv" data-n="${today.workBlocks}">${today.workBlocks}</span></span>
                 <button data-act="work" data-dir="+1" aria-label="עוד">+</button>
               </span>
               <a class="toggl" href="${esc(state.settings.togglUrl)}" rel="noopener">${LINK_SVG} פתח Toggl</a>
             </div>
           </div>`,
          checkRow({ key: 'home', day: today, label: 'קשר עם הבית', sub: 'שיחה או הודעה' }),
        ],
        done: today.items.calories && today.workBlocks > 0 && today.items.home,
      },
      evening: {
        title: 'ערב',
        time: `מ־<bdi>${t.writing}</bdi>`,
        rows: [
          checkRow({
            key: 'writing', day: today, label: 'כתיבה <em class="tag">ליבה</em>',
            sub: timerLive ? `רץ · <bdi class="timer-left">${mmss(state.timer.endsAt - Date.now())}</bdi>` : `${state.settings.writingMinutes} דקות`,
            extra: today.items.writing ? '' : `<button class="mini ${timerLive ? 'live' : ''}" data-act="timer" aria-label="הפעל טיימר כתיבה">${timerLive ? `<bdi class="timer-left">${mmss(state.timer.endsAt - Date.now())}</bdi>` : PLAY_SVG + ' ' + state.settings.writingMinutes + ' דק׳'}</button>`,
          }),
          `<div class="row ${closing ? 'done' : ''}" data-row="closing">
             <button class="hit" data-act="closing" aria-label="סגירת יום">
               <span class="check">${CHECK_SVG}</span>
               <span class="lbl"><b>סגירת יום</b><span>${closing ? `גבול: ${BOUNDARY_HE[closing.boundary]} · ${esc(closing.worked || '—')}` : '4 שאלות · דקה אחת'}</span></span>
               <span class="chev">›</span>
             </button>
           </div>`,
        ],
        done: today.items.writing && !!closing,
      },
    };

    const order = [tw.active, ...['prev', 'morning', 'day', 'evening'].filter((k) => k !== tw.active)];

    const html = `
      <header class="head">
        <div>
          <p class="kicker">יום טוב</p>
          <h1 class="date">${fmtDate.format(now)}</h1>
          <p class="sub">${core ? 'הליבה בוצעה' : 'ליבה: תפילה · עבודה · כתיבה'}
            <span class="core" title="תפילה · עבודה · כתיבה">
              <i class="${today.items.prayer ? 'on' : ''}"></i><i class="${today.workBlocks > 0 ? 'on' : ''}"></i><i class="${today.items.writing ? 'on' : ''}"></i>
            </span>
          </p>
        </div>
        <div class="ring ${status}" aria-label="ציון יומי ${score} מתוך ${max}">
          <svg viewBox="0 0 108 108"><circle class="track" cx="54" cy="54" r="${RING_R}"/><circle class="bar" cx="54" cy="54" r="${RING_R}" stroke-dasharray="${RING_C.toFixed(1)}" stroke-dashoffset="${(RING_C * (1 - score / max)).toFixed(1)}"/></svg>
          <div class="in">
            <div class="num"><span class="nv" data-n="${score}">${fmtScore(score)}</span><small>/${max}</small></div>
            <span class="badge ${status}" data-key="badge-${status}">${STATUS_HE[status]}</span>
          </div>
        </div>
      </header>
      <section class="blocks">
        ${order.map((k) => {
          const b = blocks[k];
          const active = k === tw.active;
          return `
            <article class="block ${active ? 'active' : ''} ${b.done ? 'done-all' : ''}" data-key="block-${k}">
              <div class="block-head">
                <h2>${b.title}${active ? '<span class="now-tag">עכשיו</span>' : ''}</h2>
                <span class="time">${b.time}</span>
              </div>
              ${b.rows.join('')}
            </article>`;
        }).join('')}
      </section>
      <p class="foot">נשמר מקומית במכשיר<span class="dot">·</span>${Object.keys(state.days).length} ימים בארכיון</p>
    `;

    const app = document.getElementById('app');
    const first = !app.dataset.rendered || app.dataset.view !== 'today';
    app.classList.toggle('first', first);
    if (first) setTimeout(() => app.classList.remove('first'), 1200);
    commit(html, () => {
      if (!first && lastScore !== score) countUp(app.querySelector('.ring .nv'), lastScore, score);
      lastScore = score;
    });
  }

  // ───────── week ─────────
  const DAY_LETTER = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  function weekKeyOf(d) { const s = addDays(d, -d.getDay()); return dateKey(s); } // ראשון של אותו שבוע
  function weekStats(now) {
    const keys = Object.keys(state.days).sort();
    const firstKey = keys[0];
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(now, -i), k = dateKey(d);
      const rec = state.days[k];
      const counted = !!rec || (firstKey && k > firstKey);
      let score = 0, status = 'fell', items = null;
      if (rec) { const r = scoreDay(rec); score = r.score; status = r.status; items = rec; }
      days.push({ key: k, d, counted, score, status, rec: items });
    }
    const counted = days.filter((x) => x.counted);
    const avg = counted.length ? counted.reduce((a, x) => a + x.score, 0) / counted.length : 0;
    const tally = { good: 0, ok: 0, fell: 0 };
    counted.forEach((x) => tally[x.status]++);
    const w = state.settings.weights;
    let worst = null;
    for (const k of ITEM_ORDER) {
      if (!w[k]) continue;
      const missed = counted.filter((x) => !x.rec || (k === 'work' ? !(x.rec.workBlocks > 0) : !x.rec.items[k])).length;
      if (!worst || missed > worst.missed || (missed === worst.missed && w[k] > w[worst.key])) worst = { key: k, missed };
    }
    const max = Object.values(w).reduce((a, b) => a + b, 0);
    return { days, counted: counted.length, avg: Math.round(avg * 10) / 10, tally, worst, max };
  }
  function renderWeek() {
    const now = NOW();
    const st = weekStats(now);
    const wk = weekKeyOf(now);
    const rec = state.weeks[wk] || { answer: '' };
    const bars = st.days.map((x, i) => {
      const h = st.max ? Math.max(x.counted ? 4 : 0, (x.score / st.max) * 100) : 0;
      return `<div class="bar-col ${x.key === dateKey(now) ? 'today' : ''}" style="--i:${i}">
        <div class="bar-wrap"><div class="bar ${x.status} ${x.counted ? '' : 'none'}" style="height:${h}%"></div></div>
        <span class="bar-v">${x.counted ? fmtScore(x.score) : '·'}</span>
        <span class="bar-l">${DAY_LETTER[x.d.getDay()]}</span>
      </div>`;
    }).join('');
    return `
      <header class="head plain">
        <div><p class="kicker">7 ימים אחרונים</p><h1 class="date">סיכום שבועי</h1>
        <p class="sub">${st.counted ? `${st.counted} ימים נמדדו` : 'עדיין אין ימים במדידה'}</p></div>
        <div class="avg"><div class="num"><span class="nv">${fmtScore(st.avg)}</span><small>ממוצע</small></div></div>
      </header>
      <section class="card chart" data-key="chart">
        <div class="bars">${bars}</div>
      </section>
      <section class="stats" data-key="stats">
        <div class="stat good"><b>${st.tally.good}</b><span>טוב</span></div>
        <div class="stat ok"><b>${st.tally.ok}</b><span>בסדר</span></div>
        <div class="stat fell"><b>${st.tally.fell}</b><span>נפל</span></div>
      </section>
      <section class="card worst" data-key="worst">
        <p class="kicker">הסעיף שנפל הכי הרבה</p>
        ${st.worst && st.counted ? `<h2>${ITEM_HE[st.worst.key]}</h2><p class="sub">נפל ${st.worst.missed} מתוך ${st.counted} ימים</p>` : `<h2 class="dim">—</h2><p class="sub">אחרי יום אחד יהיה כאן מה לראות</p>`}
        <label class="q"><span>למה הסעיף הזה נפל, ומה משנים בשבוע הבא?</span>
          <input data-act="week-answer" data-week="${wk}" value="${esc(rec.answer)}" placeholder="שורה אחת…" maxlength="160" enterkeyhint="done"></label>
        <p class="saved ${rec.answer ? 'on' : ''}">נשמר לשבוע שמתחיל ב־<bdi>${wk.slice(8)}.${wk.slice(5, 7)}</bdi></p>
      </section>
    `;
  }

  // ───────── settings ─────────
  function renderSettings() {
    const s = state.settings, t = s.times, w = s.weights, r = s.reminders;
    const timeRow = (label, path, val, hint) => `<label class="srow"><span><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</span><input type="time" data-set="${path}" value="${val}"></label>`;
    const numRow = (label, path, val, step = 0.5, min = 0, max = 10) => `<label class="srow"><span><b>${label}</b></span><input type="number" inputmode="decimal" data-set="${path}" value="${val}" step="${step}" min="${min}" max="${max}"></label>`;
    const remRow = (k, label) => `<div class="srow rem"><label class="sw"><input type="checkbox" data-set="reminders.${k}.on" ${r[k].on ? 'checked' : ''}><i></i></label><span><b>${label}</b><small>${esc(r[k].text)}</small></span><input type="time" data-set="reminders.${k}.time" value="${r[k].time}" ${r[k].on ? '' : 'disabled'}></div>`;
    const notifState = !('Notification' in window) ? 'none' : Notification.permission;
    return `
      <header class="head plain"><div><p class="kicker">יום טוב</p><h1 class="date">הגדרות</h1></div></header>

      <section class="card group" data-key="g-times"><h3>שעות</h3>
        ${timeRow('כיבוי מסך', 'times.screenOff', t.screenOff)}
        ${timeRow('לישון עד', 'times.sleep', t.sleep)}
        ${timeRow('התעוררות עד', 'times.wake', t.wake)}
        ${timeRow('כתיבה', 'times.writing', t.writing, 'תחילת בלוק הערב')}
        ${timeRow('מעבר ל"מחר"', 'times.eveningStart', t.eveningStart, 'מהשעה הזו "ערב קודם" שייך למחר')}
      </section>

      <section class="card group" data-key="g-weights"><h3>משקלים <small>סה״כ ${fmtScore(Object.values(w).reduce((a, b) => a + b, 0))}</small></h3>
        ${ITEM_ORDER.map((k) => numRow(ITEM_HE[k], 'weights.' + k, w[k])).join('')}
        ${numRow('סף "טוב" (עם ליבה)', 'goodThreshold', s.goodThreshold, 0.5, 0, 20)}
        ${numRow('דקות כתיבה', 'writingMinutes', s.writingMinutes, 1, 1, 120)}
        <label class="srow"><span><b>קישור Toggl</b></span><input type="text" data-set="togglUrl" value="${esc(s.togglUrl)}" dir="ltr" autocapitalize="off"></label>
      </section>

      <section class="card group" data-key="g-rem"><h3>תזכורות <small>עד 4 ביום</small></h3>
        ${remRow('prev', 'ערב קודם')}
        ${remRow('morning', 'בוקר')}
        ${remRow('day', 'יום')}
        ${remRow('evening', 'ערב')}
        <div class="note">
          ${notifState === 'granted' ? '✓ התראות מאושרות — יופיעו כשהאפליקציה פתוחה.' : notifState === 'denied' ? 'התראות נחסמו בדפדפן.' : notifState === 'none' ? 'הדפדפן הזה לא תומך בהתראות.' : '<button class="link" data-act="notif-ask">אשר התראות</button> (יופיעו כשהאפליקציה פתוחה)'}
          <br>באייפון, PWA לא יכולה להפעיל תזכורת מתוזמנת כשהיא סגורה. הפתרון: ייצוא ליומן — 4 אירועים יומיים עם התראה, פעם אחת.
        </div>
        <button class="secondary" data-act="export-ics">הוסף תזכורות ליומן (.ics)</button>
      </section>

      <section class="card group" data-key="g-export"><h3>נתונים <small>${Object.keys(state.days).length} ימים</small></h3>
        <div class="two">
          <button class="secondary" data-act="export-json">ייצוא JSON</button>
          <button class="secondary" data-act="export-csv">ייצוא CSV</button>
        </div>
        <button class="link danger" data-act="reset-all">מחק את כל הנתונים</button>
      </section>
      <p class="foot">יום טוב · גרסה 3 · שמור מקומית</p>
    `;
  }
  function setPath(obj, path, val) {
    const parts = path.split('.'); let o = obj;
    for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
    o[parts[parts.length - 1]] = val;
  }

  // ───────── export ─────────
  function exportJSON() {
    const data = { app: 'yom-tov', exportedAt: new Date().toISOString(), days: state.days, weeks: state.weeks, settings: state.settings };
    deliver(JSON.stringify(data, null, 2), `yom-tov-${dateKey(NOW())}.json`, 'application/json');
  }
  function exportCSV() {
    const cols = ['date', ...ITEM_ORDER.filter((k) => k !== 'work'), 'workBlocks', 'score', 'status', 'focus', 'boundary', 'worked', 'failed'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = Object.keys(state.days).sort().map((k) => {
      const d = state.days[k]; scoreDay(d);
      return [d.date, ...ITEM_ORDER.filter((x) => x !== 'work').map((x) => (d.items[x] ? 1 : 0)), d.workBlocks, d.score, d.status, d.focus, d.closing?.boundary ?? '', d.closing?.worked ?? '', d.closing?.failed ?? ''].map(q).join(',');
    });
    deliver('\ufeff' + [cols.join(','), ...rows].join('\r\n'), `yom-tov-${dateKey(NOW())}.csv`, 'text/csv');
  }
  function exportICS() {
    const r = state.settings.reminders;
    const ic = (t) => String(t).replace(/([,;\\])/g, '\\$1');
    const ev = Object.keys(r).filter((k) => r[k].on).map((k) => {
      const [h, m] = r[k].time.split(':');
      const d = NOW(); const start = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${h}${m}00`;
      return ['BEGIN:VEVENT', `UID:yom-tov-${k}@local`, `DTSTAMP:${start}`, `DTSTART:${start}`, 'DURATION:PT5M', 'RRULE:FREQ=DAILY', `SUMMARY:יום טוב · ${ic(r[k].text.split(':')[0])}`, `DESCRIPTION:${ic(r[k].text)}`, 'BEGIN:VALARM', 'TRIGGER:PT0S', 'ACTION:DISPLAY', `DESCRIPTION:${ic(r[k].text)}`, 'END:VALARM', 'END:VEVENT'].join('\r\n');
    });
    deliver(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//yom-tov//he', 'X-WR-CALNAME:יום טוב', ...ev, 'END:VCALENDAR'].join('\r\n'), 'yom-tov-reminders.ics', 'text/calendar');
  }
  async function deliver(text, name, type) {
    const file = new File([text], name, { type });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const url = URL.createObjectURL(file);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ───────── reminders (while the app is open) ─────────
  function checkReminders() {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const now = NOW(), hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`, today = dateKey(now);
    const fired = load('yt:fired', {});
    for (const [k, r] of Object.entries(state.settings.reminders)) {
      if (!r.on || r.time !== hhmm || fired[k] === today) continue;
      fired[k] = today; save('yt:fired', fired);
      navigator.serviceWorker?.ready.then((reg) => reg.showNotification('יום טוב', { body: r.text, icon: 'icons/icon-180.png', tag: 'yt-' + k })).catch(() => { try { new Notification('יום טוב', { body: r.text }); } catch {} });
    }
  }

  // Apple-style number roll: counts from old to new with ease-out
  function countUp(el, from, to) {
    if (!el || from == null) return;
    const t0 = performance.now(), dur = 550;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      const v = from + (to - from) * e;
      el.textContent = fmtScore(Math.round(v * 10) / 10);
      if (p < 1) requestAnimationFrame(step); else el.textContent = fmtScore(to);
    };
    requestAnimationFrame(step);
  }

  // ───────── sheets (iOS-style bottom sheet) ─────────
  function openSheet(html, { onClose } = {}) {
    closeSheet(true);
    const el = document.createElement('div');
    el.className = 'sheet-wrap';
    el.innerHTML = `<div class="backdrop" data-act="sheet-close"></div><div class="sheet" role="dialog"><div class="handle" data-act="sheet-close"></div>${html}</div>`;
    document.body.appendChild(el);
    document.body.classList.add('has-sheet');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
    el._onClose = onClose;
    return el;
  }
  function closeSheet(immediate) {
    const el = document.querySelector('.sheet-wrap');
    if (!el) return;
    document.body.classList.remove('has-sheet');
    if (el._onClose) el._onClose();
    if (immediate) { el.remove(); return; }
    el.classList.remove('open');
    el.classList.add('closing');
    setTimeout(() => el.remove(), 420);
  }

  // ───────── closing day ─────────
  function openClosing() {
    const now = NOW();
    const today = getDay(dateKey(now));
    const tomorrow = getDay(dateKey(addDays(now, 1)));
    const c = today.closing || { boundary: '', worked: '', failed: '' };
    const seg = (v, label) => `<button type="button" class="seg-btn ${c.boundary === v ? 'on' : ''}" data-seg="${v}">${label}</button>`;
    openSheet(`
      <form class="closing" data-form="closing" autocomplete="off">
        <h3>סגירת יום</h3>
        <p class="lead">${fmtDate.format(now)}</p>

        <fieldset class="q" style="--i:0">
          <legend>החזקתי את הגבול היום?</legend>
          <p class="hint">לא עניתי לטלפון בזמן בלוק עבודה אלא אם דחוף</p>
          <div class="seg" data-name="boundary" data-value="${c.boundary}">
            <span class="seg-pill"></span>
            ${seg('yes', 'כן')}${seg('partial', 'חלקית')}${seg('no', 'לא')}
          </div>
        </fieldset>

        <label class="q" style="--i:1"><span>מה עבד היום?</span>
          <input name="worked" value="${esc(c.worked)}" placeholder="שורה אחת…" maxlength="140" enterkeyhint="next"></label>
        <label class="q" style="--i:2"><span>מה לא עבד?</span>
          <input name="failed" value="${esc(c.failed)}" placeholder="שורה אחת…" maxlength="140" enterkeyhint="next"></label>
        <label class="q" style="--i:3"><span>על מה אני עובד מחר?</span>
          <input name="tomorrow" value="${esc(tomorrow.focus)}" placeholder="הדבר האחד…" maxlength="120" enterkeyhint="done"></label>

        <button type="submit" class="primary" style="--i:4">${today.closing ? 'עדכן' : 'סגור את היום'}</button>
      </form>
    `);
    positionSegPill();
  }
  function positionSegPill() {
    const seg = document.querySelector('.seg');
    if (!seg) return;
    const on = seg.querySelector('.seg-btn.on');
    const pill = seg.querySelector('.seg-pill');
    if (!on) { pill.style.opacity = '0'; return; }
    pill.style.opacity = '1';
    pill.style.width = on.offsetWidth + 'px';
    pill.style.transform = `translateX(${on.offsetLeft - 4}px)`;
  }

  function submitClosing(form) {
    const now = NOW();
    const today = getDay(dateKey(now));
    const tomorrow = getDay(dateKey(addDays(now, 1)));
    const boundary = form.querySelector('.seg').dataset.value;
    if (!boundary) { form.querySelector('.seg').classList.add('shake'); setTimeout(() => form.querySelector('.seg').classList.remove('shake'), 500); return; }
    today.closing = {
      boundary,
      worked: form.worked.value.trim(),
      failed: form.failed.value.trim(),
      closedAt: new Date().toISOString(),
    };
    tomorrow.focus = form.tomorrow.value.trim();
    persistDays();
    form.classList.add('sent');
    setTimeout(() => { closeSheet(); render(); }, 520);
  }

  // ───────── writing timer ─────────
  let tickHandle = null;
  function startTimer() {
    const total = state.settings.writingMinutes * 60 * 1000;
    state.timer = { date: dateKey(NOW()), endsAt: Date.now() + total, total };
    save(KEY.timer, state.timer);
    unlockAudio();
  }
  function stopTimer() { state.timer = null; drop(KEY.timer); }

  function openTimer() {
    if (!state.timer || state.timer.endsAt <= Date.now()) startTimer();
    const el = openSheet(`
      <div class="timer">
        <h3>כתיבה</h3>
        <p class="lead">${state.settings.writingMinutes} דקות. רק לכתוב.</p>
        <div class="tring">
          <svg viewBox="0 0 200 200"><circle class="track" cx="100" cy="100" r="90"/><circle class="bar" cx="100" cy="100" r="90" stroke-dasharray="${(2 * Math.PI * 90).toFixed(1)}" stroke-dashoffset="0"/></svg>
          <div class="in"><div class="clock">--:--</div><div class="state">רץ</div></div>
        </div>
        <div class="tactions">
          <button type="button" class="ghost" data-act="timer-cancel">בטל</button>
          <button type="button" class="primary" data-act="timer-done">סיימתי</button>
        </div>
      </div>
    `, { onClose: () => { clearInterval(tickHandle); tickHandle = null; } });
    tickTimer(el);
    tickHandle = setInterval(() => tickTimer(el), 250);
  }
  function tickTimer(el) {
    if (!state.timer) return;
    const left = state.timer.endsAt - Date.now();
    const clock = el.querySelector('.clock'), bar = el.querySelector('.tring .bar');
    if (clock) clock.textContent = mmss(left);
    if (bar) bar.style.strokeDashoffset = ((2 * Math.PI * 90) * (1 - Math.max(0, left) / state.timer.total)).toFixed(1);
    document.querySelectorAll('.timer-left').forEach((n) => (n.textContent = mmss(left)));
    if (left <= 0) finishTimer(el, true);
  }
  function finishTimer(el, auto) {
    clearInterval(tickHandle); tickHandle = null;
    const day = getDay(state.timer ? state.timer.date : dateKey(NOW()));
    day.items.writing = true;
    stopTimer();
    persistDays();
    if (el) {
      el.querySelector('.timer').classList.add('finished');
      const st = el.querySelector('.state'); if (st) st.textContent = auto ? 'הושלם' : 'סומן';
      const ck = el.querySelector('.clock'); if (ck) ck.textContent = '00:00';
      if (auto) chime();
      setTimeout(() => { closeSheet(); render(); }, auto ? 1400 : 500);
    } else render();
  }
  // אם הטיימר נגמר בזמן שהאפליקציה הייתה ברקע — סמן בכניסה
  function reconcileTimer() {
    if (state.timer && state.timer.endsAt <= Date.now()) finishTimer(null, true);
  }

  // soft two-note chime (Web Audio, unlocked on the start gesture)
  let audio = null;
  function unlockAudio() { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch {} }
  function chime() {
    if (!audio) return;
    try {
      const t = audio.currentTime;
      [[660, 0], [880, 0.18]].forEach(([f, d]) => {
        const o = audio.createOscillator(), g = audio.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(0.25, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.7);
        o.connect(g).connect(audio.destination); o.start(t + d); o.stop(t + d + 0.75);
      });
    } catch {}
  }

  // ───────── events ─────────
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act], [data-seg]');
    if (!el) return;
    if (el.dataset.seg !== undefined) {
      const seg = el.closest('.seg');
      seg.dataset.value = el.dataset.seg;
      seg.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('on', b === el));
      positionSegPill();
      return;
    }
    const act = el.dataset.act;
    if (act === 'toggle') {
      const d = getDay(el.dataset.day);
      d.items[el.dataset.key] = !d.items[el.dataset.key];
      if (el.dataset.key === 'writing' && !d.items.writing) stopTimer();
      pop(el.querySelector('.check')); render();
    } else if (act === 'work') {
      const d = getDay(dateKey(NOW()));
      const dir = el.dataset.dir;
      if (dir === '+1') d.workBlocks += 1;
      else if (dir === '-1') d.workBlocks = Math.max(0, d.workBlocks - 1);
      else d.workBlocks = dir === '1' ? Math.max(1, d.workBlocks) : 0;
      pop(el.closest('.row').querySelector('.check')); render();
    } else if (act === 'view') { state.view = el.dataset.view; window.scrollTo({ top: 0 }); render(); }
    else if (act === 'export-json') exportJSON();
    else if (act === 'export-csv') exportCSV();
    else if (act === 'export-ics') exportICS();
    else if (act === 'notif-ask') Notification.requestPermission().then(() => render());
    else if (act === 'reset-all') { if (confirm('למחוק את כל הימים, השבועות וההגדרות? אין דרך חזרה.')) { localStorage.clear(); location.reload(); } }
    else if (act === 'closing') openClosing();
    else if (act === 'timer') openTimer();
    else if (act === 'timer-cancel') { stopTimer(); closeSheet(); render(); }
    else if (act === 'timer-done') finishTimer(document.querySelector('.sheet-wrap'), false);
    else if (act === 'sheet-close') closeSheet();
  });
  const pop = (el) => { if (!el) return; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); };

  document.addEventListener('submit', (e) => {
    if (e.target.dataset.form === 'closing') { e.preventDefault(); submitClosing(e.target); }
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el.dataset.set) return;
    let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    if (el.type === 'number' && isNaN(v)) return;
    if (el.type === 'time' && !/^\d{2}:\d{2}$/.test(v)) return;
    setPath(state.settings, el.dataset.set, v);
    persistSettings();
    render();
  });
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.act === 'week-answer') {
      state.weeks[el.dataset.week] = { ...(state.weeks[el.dataset.week] || {}), answer: el.value.trim(), updatedAt: new Date().toISOString() };
      persistWeeks();
      el.closest('.worst').querySelector('.saved').classList.toggle('on', !!el.value.trim());
    }
    if (el.dataset.act === 'focus') {
      getDay(el.dataset.day).focus = el.value.trim();
      persistDays();
      el.closest('.row').classList.toggle('done', !!el.value.trim());
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target.dataset?.act === 'focus' || e.target.dataset?.act === 'week-answer')) { e.target.blur(); render(); }
    if (e.key === 'Escape') closeSheet();
  });
  document.addEventListener('focusout', (e) => { if (e.target.dataset?.act === 'focus') render(); });
  window.addEventListener('resize', positionSegPill);

  document.addEventListener('visibilitychange', () => { if (!document.hidden) { reconcileTimer(); render(); } });
  setInterval(() => {
    reconcileTimer();
    checkReminders();
    if (!document.querySelector('.sheet-wrap') && (!document.activeElement || document.activeElement.tagName !== 'INPUT')) render();
  }, 30 * 1000);

  reconcileTimer();
  checkReminders();
  render();

  // ───────── PWA ─────────
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }
})();
