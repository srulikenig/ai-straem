'use strict';

/* Management UI. No framework: h() builds DOM nodes, so user data is always
 * text content and never parsed as HTML. Routes live in the hash. */

const app = document.getElementById('app');
let me = null;

/* ------------------------------- helpers -------------------------------- */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(method, path, body, raw) {
  const headers = {};
  if (method !== 'GET') headers['x-requested-with'] = 'fetch';
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: raw ? body : body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 401 && path !== '/api/login') {
    me = null;
    render();
    throw new Error('נדרשת התחברות');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `שגיאה ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 2800);
}

/** Runs an async action from a button, disabling it meanwhile and reporting errors. */
async function act(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

const fmtDate = (iso) =>
  new Date(iso).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const isUrgent = (a) => a.urgency && a.urgency.includes('דחוף') && !a.urgency.includes('לא');

function copy(text, what) {
  navigator.clipboard.writeText(text).then(() => toast(`${what} הועתק`), () => toast('ההעתקה נכשלה', true));
}

/* -------------------------------- shell --------------------------------- */

const ROUTES = {
  requests: { title: 'פניות', view: viewRequests },
  contacts: { title: 'אנשי קשר', view: viewContacts },
  settings: { title: 'הנחיה', view: viewSettings },
  admin: { title: 'ניהול', view: viewAdmin, admin: true },
  account: { title: 'החשבון שלי', view: viewAccount, hidden: true },
};

function current() {
  const name = location.hash.replace(/^#\/?/, '').split('/')[0];
  const r = ROUTES[name];
  return r && (!r.admin || me.role === 'admin') ? name : 'requests';
}

async function render() {
  app.replaceChildren();
  if (!me) {
    app.append(viewLogin());
    return;
  }
  const name = current();
  const nav = h(
    'nav',
    { class: 'nav' },
    Object.entries(ROUTES)
      .filter(([, r]) => !r.hidden && (!r.admin || me.role === 'admin'))
      .map(([k, r]) => h('a', { href: `#/${k}`, class: k === name ? 'active' : '' }, r.title)),
  );
  const top = h(
    'header',
    { class: 'topbar' },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), h('span', { class: 'hide-sm' }, 'מענה טלפוני')),
    nav,
    h(
      'div',
      { class: 'who' },
      h('a', { href: '#/account' }, me.name),
      h('button', { class: 'btn ghost small', onclick: logout }, 'יציאה'),
    ),
  );
  const main = h('main');
  app.append(top, main);
  document.title = `${ROUTES[name].title} · מענה טלפוני`;
  try {
    await ROUTES[name].view(main);
  } catch (e) {
    main.append(h('p', { class: 'error' }, e.message));
  }
}

async function logout() {
  await api('POST', '/api/logout').catch(() => {});
  me = null;
  render();
}

window.addEventListener('hashchange', render);

/* -------------------------------- login --------------------------------- */

function viewLogin() {
  const err = h('p', { class: 'error' });
  const email = h('input', { type: 'email', autocomplete: 'username', required: true, class: 'ltr' });
  const pass = h('input', { type: 'password', autocomplete: 'current-password', required: true, class: 'ltr' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'כניסה');
  const form = h(
    'form',
    {
      class: 'card login stack',
      onsubmit: async (e) => {
        e.preventDefault();
        btn.disabled = true;
        err.textContent = '';
        try {
          me = (await api('POST', '/api/login', { email: email.value, password: pass.value })).user;
          render();
        } catch (ex) {
          err.textContent = ex.message;
        } finally {
          btn.disabled = false;
        }
      },
    },
    h('div', { class: 'brand' }, h('img', { src: 'favicon.svg', alt: '' }), 'מענה טלפוני'),
    h('label', { class: 'field' }, h('span', {}, 'מייל'), email),
    h('label', { class: 'field' }, h('span', {}, 'סיסמה'), pass),
    err,
    btn,
  );
  setTimeout(() => email.focus());
  return h('div', { class: 'login-wrap' }, form);
}

/* ------------------------------- requests ------------------------------- */

let requestFilter = 'new';
let selectedRequest = null;

async function viewRequests(main) {
  const { requests, labels } = await api('GET', `/api/requests${requestFilter === 'all' ? '' : `?status=${requestFilter}`}`);
  const chips = h(
    'div',
    { class: 'chips' },
    [
      ['new', 'חדשות'],
      ['done', 'טופלו'],
      ['all', 'הכל'],
    ].map(([k, t]) =>
      h('button', { class: `chip${requestFilter === k ? ' on' : ''}`, onclick: () => ((requestFilter = k), render()) }, t),
    ),
  );
  main.append(
    h('div', { class: 'row' }, h('div', {}, h('h1', {}, 'פניות'), h('p', { class: 'sub' }, 'כל השיחות שהגיעו לקו שלך, עם ההקלטה והתמלול.')), h('div', { class: 'spacer' }), chips),
  );

  if (!requests.length) {
    main.append(h('div', { class: 'card empty' }, requestFilter === 'new' ? 'אין פניות חדשות.' : 'אין פניות להצגה.'));
    return;
  }

  const detail = h('div', { class: 'card detail' }, h('p', { class: 'empty' }, 'בחר פנייה כדי לראות את הפרטים.'));
  const list = h(
    'div',
    { class: 'card list' },
    requests.map((r) => {
      const who = r.answers.caller_name || r.contactName || r.caller || 'מספר חסוי';
      const preview = r.answers.message || r.answers.request || r.firstWords || '—';
      const item = h(
        'button',
        { class: `item${r.status === 'done' ? ' done' : ''}`, onclick: () => select(r.id, item) },
        h(
          'div',
          { class: 'top' },
          h('span', { class: 'name' }, who),
          r.status === 'new' && h('span', { class: 'badge new' }, 'חדש'),
          isUrgent(r.answers) && h('span', { class: 'badge urgent' }, 'דחוף'),
          h('span', { class: 'when' }, fmtDate(r.startedAt)),
        ),
        h('div', { class: 'preview' }, preview),
      );
      if (r.id === selectedRequest) setTimeout(() => select(r.id, item));
      return item;
    }),
  );
  main.append(h('div', { class: 'split' }, list, detail));

  async function select(id, item) {
    selectedRequest = id;
    list.querySelectorAll('.item').forEach((el) => el.classList.remove('sel'));
    item.classList.add('sel');
    const { request: r } = await api('GET', `/api/requests/${id}`);
    const known = Object.keys(labels).filter((k) => r.answers[k]);
    const other = Object.keys(r.answers).filter((k) => !(k in labels));
    const toggle = h(
      'button',
      {
        class: r.status === 'new' ? 'btn' : 'btn ghost',
        onclick: (e) =>
          act(e.target, async () => {
            await api('PATCH', `/api/requests/${id}`, { status: r.status === 'new' ? 'done' : 'new' });
            render();
          }),
      },
      r.status === 'new' ? 'סמן כטופל' : 'החזר לחדשות',
    );
    detail.replaceChildren(h(
      'div',
      {},
      h(
        'div',
        { class: 'row' },
        h('div', {}, h('h2', {}, r.contactName || r.caller || 'מספר חסוי'), h('div', { class: 'hint' }, `${fmtDate(r.startedAt)} · ${fmtDur(r.durationMs)} דקות${r.emailed ? ' · נשלח במייל' : ''}`)),
        h('div', { class: 'spacer' }),
        r.caller && h('a', { class: 'btn ghost', href: `tel:${r.caller}` }, 'חיוג חוזר'),
        toggle,
      ),
      known.length + other.length
        ? h(
            'dl',
            {},
            r.caller && [h('dt', {}, 'טלפון'), h('dd', { class: 'ltr' }, r.caller)],
            known.map((k) => [h('dt', {}, labels[k]), h('dd', {}, r.answers[k])]),
            other.map((k) => [h('dt', {}, k), h('dd', {}, r.answers[k])]),
          )
        : h('p', { class: 'notice' }, 'הבוט לא שמר פרטים בשיחה הזו — ראה תמלול.'),
      r.hasRecording && h('audio', { controls: true, preload: 'none', src: `/api/requests/${id}/recording` }),
      h('h2', {}, 'תמלול'),
      h(
        'div',
        { class: 'transcript' },
        r.transcript.length
          ? r.transcript.map((t) => h('div', { class: `bubble ${t.role}` }, h('small', {}, t.role === 'caller' ? 'מתקשר' : 'מענה'), t.text.trim()))
          : h('p', { class: 'hint' }, 'אין תמלול.'),
      ),
    ));
  }
}

/* ------------------------------- contacts ------------------------------- */

async function viewContacts(main) {
  const { contacts } = await api('GET', '/api/contacts');

  const name = h('input', { type: 'text', placeholder: 'שם', required: true });
  const phone = h('input', { type: 'tel', placeholder: 'טלפון', required: true, class: 'ltr' });
  const notes = h('input', { type: 'text', placeholder: 'הערה פנימית (לא תוקרא למתקשר)' });
  const addBtn = h('button', { class: 'btn', type: 'submit' }, 'הוספה');
  const addForm = h(
    'form',
    {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        act(addBtn, async () => {
          await api('POST', '/api/contacts', { name: name.value, phone: phone.value, notes: notes.value });
          render();
        }, 'איש הקשר נוסף');
      },
    },
    h('div', { class: 'spacer' }, name),
    h('div', { class: 'spacer' }, phone),
    h('div', { class: 'spacer' }, notes),
    addBtn,
  );

  const file = h('input', {
    type: 'file',
    accept: '.xlsx,.csv',
    hidden: true,
    onchange: () =>
      act(null, async () => {
        const f = file.files[0];
        if (!f) return;
        const r = await api('POST', '/api/contacts/import', await f.arrayBuffer(), true);
        file.value = '';
        toast(`נוספו ${r.added}, עודכנו ${r.updated}${r.skipped ? `, דולגו ${r.skipped} שורות בלי מספר תקין` : ''}`);
        setTimeout(render, 400);
      }),
  });

  const search = h('input', { type: 'search', placeholder: 'חיפוש לפי שם או מספר' });
  const tbody = h('tbody');
  const fill = () => {
    const q = search.value.trim();
    const rows = contacts.filter((c) => !q || c.name.includes(q) || c.phone.includes(q.replace(/\D/g, '') || q));
    tbody.replaceChildren(...rows.map(contactRow));
  };
  search.addEventListener('input', fill);
  fill();

  main.append(
    h('h1', {}, 'אנשי קשר'),
    h('p', { class: 'sub' }, 'מתקשר שהמספר שלו כאן יזוהה בשמו בפנייה. אם הפעלת זאת בהנחיה, המענה גם יפנה אליו בשמו.'),
    h('div', { class: 'card' }, h('h2', {}, 'הוספת איש קשר'), addForm),
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h('h2', {}, `${contacts.length} אנשי קשר`),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn ghost', onclick: () => file.click() }, 'ייבוא מאקסל / CSV'),
        file,
      ),
      h('p', { class: 'hint' }, 'בקובץ צריכות להיות עמודות "שם" ו"טלפון" (ואפשר גם "הערות"). בלי שורת כותרות: עמודה A שם, עמודה B טלפון. מספר שכבר קיים יתעדכן.'),
      contacts.length > 8 && search,
      contacts.length
        ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'שם'), h('th', {}, 'טלפון'), h('th', { class: 'hide-sm' }, 'הערה'), h('th'))), tbody)
        : h('p', { class: 'empty' }, 'עדיין אין אנשי קשר.'),
    ),
  );
}

function contactRow(c) {
  const tr = h('tr');
  const show = () =>
    tr.replaceChildren(
      h('td', {}, c.name),
      h('td', { class: 'ltr' }, c.phone),
      h('td', { class: 'hide-sm' }, c.notes),
      h(
        'td',
        {},
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn ghost small', onclick: edit }, 'עריכה'),
          h('button', {
            class: 'btn danger small',
            onclick: (e) => {
              if (!confirm(`למחוק את ${c.name}?`)) return;
              act(e.target, async () => {
                await api('DELETE', `/api/contacts/${c.id}`);
                tr.remove();
              }, 'נמחק');
            },
          }, 'מחיקה'),
        ),
      ),
    );
  const edit = () => {
    const name = h('input', { type: 'text', value: c.name });
    const phone = h('input', { type: 'tel', value: c.phone, class: 'ltr' });
    const notes = h('input', { type: 'text', value: c.notes });
    tr.replaceChildren(
      h('td', {}, name),
      h('td', {}, phone),
      h('td', { class: 'hide-sm' }, notes),
      h(
        'td',
        {},
        h(
          'div',
          { class: 'row' },
          h('button', {
            class: 'btn small',
            onclick: (e) =>
              act(e.target, async () => {
                c = (await api('PUT', `/api/contacts/${c.id}`, { name: name.value, phone: phone.value, notes: notes.value })).contact;
                show();
              }, 'נשמר'),
          }, 'שמירה'),
          h('button', { class: 'btn ghost small', onclick: show }, 'ביטול'),
        ),
      ),
    );
  };
  show();
  return tr;
}

/* ------------------------------- settings ------------------------------- */

async function viewSettings(main) {
  let s = await api('GET', '/api/settings');

  const greeting = h('input', { type: 'text', value: s.greeting, placeholder: 'שלום, הגעתם לשירות ההודעות של ...' });
  const instructions = h('textarea', { class: 'tall', value: s.instructions });
  const greetByName = h('input', { type: 'checkbox', checked: s.greetByName });
  const voice = h('select', {}, s.voices.map((v) => h('option', { value: v.id, selected: v.id === s.voice }, v.label)));
  const notifyEmail = h('input', { type: 'email', value: s.notifyEmail, class: 'ltr', placeholder: 'name@example.com' });
  const save = h('button', { class: 'btn', type: 'submit' }, 'שמירה');

  const form = h(
    'form',
    {
      class: 'card stack',
      onsubmit: (e) => {
        e.preventDefault();
        act(save, async () => {
          s = await api('PUT', '/api/settings', {
            greeting: greeting.value,
            instructions: instructions.value,
            greetByName: greetByName.checked,
            voice: voice.value,
            notifyEmail: notifyEmail.value.trim(),
          });
        }, 'ההנחיה נשמרה. היא תחול מהשיחה הבאה.');
      },
    },
    h('label', { class: 'field' }, h('span', {}, 'משפט פתיחה'), greeting, h('div', { class: 'hint' }, 'המענה יאמר אותו בתחילת כל שיחה. ריק — הפתיחה תיקבע לפי ההנחיות.')),
    h(
      'label',
      { class: 'field' },
      h('span', {}, 'הנחיות למענה'),
      instructions,
      h('div', { class: 'hint' }, 'מה לשאול, אילו פרטים לקבל ואיך לסיים. לדוגמה: "קבל את ההודעה בצורה טכנית, בלי לחזור אחרי המתקשר. שאל אם לחזור למספר הזה או לאחר."'),
    ),
    h('div', { class: 'row' }, h('button', { class: 'btn link', type: 'button', onclick: () => (instructions.value = s.defaultInstructions) }, 'החזר להנחיה לדוגמה')),
    h('label', { class: 'check' }, greetByName, h('span', {}, 'לפנות בשמו למתקשר שנמצא באנשי הקשר', h('div', { class: 'hint' }, 'למשל "שלום שלמה". כבוי — המענה לא יראה שהוא מזהה את המתקשר.'))),
    h(
      'div',
      { class: 'grid2' },
      h('label', { class: 'field' }, h('span', {}, 'קול'), voice),
      h('label', { class: 'field' }, h('span', {}, 'מייל לקבלת פניות'), notifyEmail, h('div', { class: 'hint' }, 'כל פנייה תישלח לכאן עם ההקלטה. ריק — בלי מייל.')),
    ),
    h('p', { class: 'notice' }, 'כללי המערכת שקבע המנהל גוברים תמיד על ההנחיות שלך: המענה רק רושם פניות, לא נותן מידע ולא מבצע פעולות.'),
    h('div', { class: 'row' }, save),
  );

  const url = `wss://${location.host}${s.channel.path}`;
  const secret = h('div', { class: 'secret' }, '••••••••••••••••');
  let shown = false;
  const channel = h(
    'div',
    { class: 'card stack' },
    h('h2', {}, 'חיבור למרכזייה'),
    h('p', { class: 'hint' }, 'במרכזייה: מודולים ← סטרימינג ← ערוץ סטרימינג חדש. הדבק את הכתובת ואת הסוד.'),
    h('div', {}, h('div', { class: 'hint' }, 'נקודת קצה'), h('div', { class: 'row' }, h('div', { class: 'secret' }, url), h('button', { class: 'btn ghost small', onclick: () => copy(url, 'הכתובת') }, 'העתקה'))),
    h(
      'div',
      {},
      h('div', { class: 'hint' }, 'סוד אימות'),
      h(
        'div',
        { class: 'row' },
        secret,
        h('button', { class: 'btn ghost small', onclick: (e) => ((shown = !shown), (secret.textContent = shown ? s.channel.secret : '••••••••••••••••'), (e.target.textContent = shown ? 'הסתרה' : 'הצגה')) }, 'הצגה'),
        h('button', { class: 'btn ghost small', onclick: () => copy(s.channel.secret, 'הסוד') }, 'העתקה'),
        h('button', {
          class: 'btn danger small',
          onclick: (e) => {
            if (!confirm('ליצור סוד חדש? הסוד הישן יפסיק לעבוד מיד, וצריך לעדכן אותו במרכזייה.')) return;
            act(e.target, async () => {
              s = await api('POST', '/api/settings/rotate-secret');
              shown = true;
              secret.textContent = s.channel.secret;
            }, 'נוצר סוד חדש — עדכן אותו במרכזייה');
          },
        }, 'סוד חדש'),
      ),
    ),
  );

  main.append(h('h1', {}, 'הנחיה'), h('p', { class: 'sub' }, 'איך המענה מתנהג בשיחות שמגיעות לקו שלך.'), form, channel);
}

/* -------------------------------- account ------------------------------- */

async function viewAccount(main) {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', class: 'ltr' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', class: 'ltr' });
  const btn = h('button', { class: 'btn', type: 'submit' }, 'החלפת סיסמה');
  main.append(
    h('h1', {}, 'החשבון שלי'),
    h('p', { class: 'sub' }, `${me.name} · ${me.email}`),
    h(
      'form',
      {
        class: 'card stack',
        onsubmit: (e) => {
          e.preventDefault();
          act(btn, async () => {
            await api('POST', '/api/me/password', { current: cur.value, next: next.value });
            cur.value = next.value = '';
          }, 'הסיסמה הוחלפה');
        },
      },
      h('div', { class: 'grid2' }, h('label', { class: 'field' }, h('span', {}, 'סיסמה נוכחית'), cur), h('label', { class: 'field' }, h('span', {}, 'סיסמה חדשה'), next, h('div', { class: 'hint' }, '8 תווים לפחות'))),
      h('div', { class: 'row' }, btn),
    ),
  );
}

/* --------------------------------- admin -------------------------------- */

async function viewAdmin(main) {
  const [{ users }, prompt] = await Promise.all([api('GET', '/api/admin/users'), api('GET', '/api/admin/prompt')]);

  const fields = {
    name: h('input', { type: 'text', placeholder: 'שם', required: true }),
    email: h('input', { type: 'email', placeholder: 'מייל', required: true, class: 'ltr' }),
    password: h('input', { type: 'text', placeholder: 'סיסמה ראשונית (8+ תווים)', required: true, class: 'ltr' }),
    role: h('select', {}, h('option', { value: 'user' }, 'משתמש'), h('option', { value: 'admin' }, 'מנהל')),
  };
  const addBtn = h('button', { class: 'btn', type: 'submit' }, 'הוספת משתמש');
  const addForm = h(
    'form',
    {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        act(addBtn, async () => {
          await api('POST', '/api/admin/users', Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value])));
          render();
        }, 'המשתמש נוסף');
      },
    },
    h('div', { class: 'grid2' }, fields.name, fields.email, fields.password, fields.role),
    h('div', { class: 'row' }, addBtn, h('span', { class: 'hint' }, 'מסור למשתמש את המייל והסיסמה. הוא יוכל להחליף סיסמה ב"החשבון שלי".')),
  );

  const userRow = (u) => {
    const self = u.id === me.id;
    const patch = (btn, body, msg) =>
      act(btn, async () => {
        await api('PATCH', `/api/admin/users/${u.id}`, body);
        render();
      }, msg);
    return h(
      'tr',
      {},
      h('td', {}, u.name, self && h('span', { class: 'hint' }, ' (את/ה)')),
      h('td', { class: 'ltr' }, u.email),
      h('td', {}, h('span', { class: 'badge' }, u.role === 'admin' ? 'מנהל' : 'משתמש'), ' ', !u.active && h('span', { class: 'badge urgent' }, 'מושבת')),
      h(
        'td',
        {},
        h(
          'div',
          { class: 'row' },
          !self && h('button', { class: 'btn ghost small', onclick: (e) => patch(e.target, { role: u.role === 'admin' ? 'user' : 'admin' }, 'ההרשאה עודכנה') }, u.role === 'admin' ? 'הפוך למשתמש' : 'הפוך למנהל'),
          h('button', {
            class: 'btn ghost small',
            onclick: (e) => {
              const p = prompt_(`סיסמה חדשה ל${u.name} (8 תווים לפחות):`);
              if (p) patch(e.target, { password: p }, 'הסיסמה הוחלפה');
            },
          }, 'איפוס סיסמה'),
          !self && h('button', { class: u.active ? 'btn danger small' : 'btn ghost small', onclick: (e) => patch(e.target, { active: !u.active }, u.active ? 'המשתמש הושבת' : 'המשתמש הופעל') }, u.active ? 'השבתה' : 'הפעלה'),
        ),
      ),
    );
  };

  const promptBox = h('textarea', { class: 'tall', value: prompt.prompt });
  const savePrompt = h('button', { class: 'btn', type: 'submit' }, 'שמירת כללי המערכת');

  main.append(
    h('h1', {}, 'ניהול'),
    h('p', { class: 'sub' }, 'משתמשים וכללי המערכת שחלים על כל הקווים.'),
    h('div', { class: 'card' }, h('h2', {}, 'הוספת משתמש'), addForm),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, `${users.length} משתמשים`),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'שם'), h('th', {}, 'מייל'), h('th', {}, 'הרשאה'), h('th'))), h('tbody', {}, users.map(userRow))),
    ),
    h(
      'form',
      {
        class: 'card stack',
        onsubmit: (e) => {
          e.preventDefault();
          act(savePrompt, () => api('PUT', '/api/admin/prompt', { prompt: promptBox.value }), 'כללי המערכת נשמרו. הם יחולו מהשיחה הבאה בכל הקווים.');
        },
      },
      h('h2', {}, 'כללי המערכת'),
      h('p', { class: 'notice' }, 'הכללים האלה מגיעים לפני ההנחיות של כל משתמש, והמענה מונחה שהם גוברים בכל סתירה. משתמשים לא רואים ולא יכולים לשנות אותם.'),
      promptBox,
      h('div', { class: 'row' }, savePrompt, h('button', { class: 'btn link', type: 'button', onclick: () => (promptBox.value = prompt.defaultPrompt) }, 'החזר לברירת המחדל'), prompt.isDefault && h('span', { class: 'hint' }, 'כרגע בשימוש: ברירת המחדל')),
    ),
  );
}

// window.prompt, named apart from the admin "prompt" data above.
const prompt_ = (msg) => window.prompt(msg);

/* --------------------------------- boot --------------------------------- */

(async () => {
  try {
    me = (await api('GET', '/api/me')).user;
  } catch {
    me = null;
  }
  render();
})();
