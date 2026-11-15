/* Bookshelf front end: vanilla JS, hash routing, no build step. */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = $('#view');

let CONFIG = { owners: [], formats: [], tags: [], locations: [], count: 0 };
const state = {
  q: '',                                   // last search query
  lib: { owner: '', tag: '', sort: 'recent', missing: false },
  draft: null,                             // prefilled book for the Add form
  scan: null,                              // last scan results, so going back keeps them
};

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* private mode etc. */ }
  return null;
}

async function api(path, opts = {}) {
  const init = { ...opts };
  if (opts.json !== undefined) {
    init.method = init.method || 'POST';
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const detail = data && data.detail;
    throw new Error(typeof detail === 'string' ? detail : `Request failed (${res.status})`);
  }
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, error ? 5000 : 2600);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function coverHTML(b, cls = 'cover') {
  const src = b.cover || b.cover_url;
  if (src) return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'${cls} placeholder',textContent:${esc(JSON.stringify(b.title || ''))}}))">`;
  return `<div class="${cls} placeholder">${esc(b.title)}</div>`;
}

function chips(b) {
  const out = [];
  if (b.owner) out.push(`<span class="chip owner">${esc(b.owner)}</span>`);
  if (b.format) out.push(`<span class="chip">${esc(b.format)}</span>`);
  if (b.edition) out.push(`<span class="chip edition">${esc(b.edition.length > 40 ? b.edition.slice(0, 38) + '…' : b.edition)}</span>`);
  if (b.copies > 1) out.push(`<span class="chip">${b.copies} copies</span>`);
  return out.join('');
}

function bookItem(b) {
  return `<a class="item" href="#/book/${b.id}">
    ${coverHTML(b)}
    <div class="meta">
      <div class="title">${esc(b.title)}${b.subtitle ? `<span class="muted" style="font-weight:500">: ${esc(b.subtitle)}</span>` : ''}</div>
      <div class="authors">${esc(b.authors)}</div>
      <div class="chips">${chips(b)}</div>
    </div>
  </a>`;
}

/** Downscale a phone photo before upload (used for custom cover photos). */
async function shrink(file, max = 2576) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 3_500_000 && file.type === 'image/jpeg') return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88));
    return blob || file;
  } catch {
    return file; // let the server deal with it
  }
}

const ICON_CAMERA = '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>';

function filePicker(onFile, { capture = true } = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  if (capture) input.capture = 'environment';
  input.onchange = () => { if (input.files[0]) onFile(input.files[0]); };
  input.click();
}

async function loadConfig() {
  try { CONFIG = await api('/api/config'); } catch { /* keep defaults */ }
}

function ownerOptions(selected) {
  const owners = [...new Set([...CONFIG.owners, ...(selected ? [selected] : [])])];
  return `<option value="">—</option>` + owners.map((o) =>
    `<option ${o === selected ? 'selected' : ''}>${esc(o)}</option>`).join('');
}

function datalist(id, values) {
  return `<datalist id="${id}">${values.map((v) => `<option value="${esc(v)}">`).join('')}</datalist>`;
}

// ---------- router ----------

const routes = [
  [/^#\/?$/, renderSearch, 'search'],
  [/^#\/library$/, renderLibrary, 'library'],
  [/^#\/scan$/, renderBarcode, 'scan'],
  [/^#\/add$/, renderAdd, 'add'],
  [/^#\/book\/(\d+)\/edit$/, renderEdit, 'library'],
  [/^#\/book\/(\d+)$/, renderBook, 'library'],
];

function route() {
  stopCamera();
  const [path, query] = (location.hash || '#/').split('?');
  const params = new URLSearchParams(query || '');
  for (const [re, fn, tab] of routes) {
    const m = path.match(re);
    if (m) {
      $$('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
      window.scrollTo(0, 0);
      fn(m, params);
      return;
    }
  }
  location.hash = '#/';
}

window.addEventListener('hashchange', route);

// ---------- Search (home) ----------

function renderSearch() {
  view.innerHTML = `
    <div class="searchbox">
      <div class="field">
        <svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input id="q" type="search" placeholder="Do we own…? Title, author, ISBN" autocomplete="off"
               autocapitalize="off" spellcheck="false" enterkeyhint="search" value="${esc(state.q)}">
        <button class="clear ${state.q ? '' : 'hidden'}" id="clear" aria-label="Clear">×</button>
      </div>
    </div>
    <a class="btn block" href="#/scan">${ICON_CAMERA} Scan a barcode</a>
    <div id="results" style="margin-top:14px"></div>`;

  const input = $('#q');
  const results = $('#results');
  const clear = $('#clear');

  const run = async () => {
    const q = input.value.trim();
    state.q = input.value;
    clear.classList.toggle('hidden', !q);
    if (!q) return showHome(results);
    try {
      const books = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (input.value.trim() !== q) return; // a newer search is in flight
      results.innerHTML = books.length
        ? `<div class="verdict own"><span class="mark">✓</span><div>You own ${books.length === 1 ? 'this' : `${books.length} matches`}
             <div class="sub">${books.length === 1 ? esc(books[0].owner ? `${books[0].owner}'s copy` : 'In your library') : 'Tap one for details'}</div></div></div>
           <div class="list">${books.map(bookItem).join('')}</div>`
        : `<div class="verdict none"><span class="mark">✗</span><div>Not in your library
             <div class="sub">No title, author or ISBN matches “${esc(q)}”</div></div></div>
           <a class="btn block" href="#/add?q=${encodeURIComponent(q)}">Look it up &amp; add it</a>`;
    } catch (e) {
      results.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    }
  };
  input.addEventListener('input', debounce(run, 120));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  clear.onclick = () => { input.value = ''; run(); input.focus(); };
  run();
  if (!state.q && matchMedia('(pointer: fine)').matches) input.focus();
}

async function showHome(results) {
  await loadConfig();
  if (!CONFIG.count) {
    results.innerHTML = `<div class="empty"><div class="big">📚</div>
      <p>Your library is empty.</p>
      <p><a class="btn primary" href="#/scan">Scan a barcode</a></p>
      <p class="small">or <a href="#/add">add a book by hand</a></p></div>`;
    return;
  }
  const recent = await api('/api/books?sort=recent&limit=5');
  const nudge = CONFIG.missing_isbn
    ? `<a class="verdict maybe" href="#/library?missing=1" style="text-decoration:none"><span class="mark">▮▯▮</span>
         <div>${CONFIG.missing_isbn} book${CONFIG.missing_isbn === 1 ? '' : 's'} still need a barcode scan
         <div class="sub">Tap to see them, then scan to fill in ISBN and edition</div></div></a>` : '';
  results.innerHTML = `${nudge}<p class="stats">${CONFIG.count} book${CONFIG.count === 1 ? '' : 's'} in your library</p>
    <h2>Recently added</h2><div class="list">${recent.map(bookItem).join('')}</div>`;
}

// ---------- Library ----------

async function renderLibrary(_m, params) {
  await loadConfig();
  const s = state.lib;
  if (params && params.get('missing')) s.missing = true;
  const ownerList = CONFIG.owners;
  view.innerHTML = `
    <div class="topbar"><h1>Library</h1><span class="stats" id="libcount"></span></div>
    <div class="filters" id="ownerFilters">
      <button data-owner="" class="${s.owner ? '' : 'on'}">Everyone</button>
      ${ownerList.map((o) => `<button data-owner="${esc(o)}" class="${s.owner === o ? 'on' : ''}">${esc(o)}</button>`).join('')}
      ${CONFIG.missing_isbn || s.missing ? `<button data-missing="1" class="${s.missing ? 'on' : ''}">Needs ISBN (${CONFIG.missing_isbn})</button>` : ''}
    </div>
    <div class="row" style="margin-bottom:14px">
      <select id="tag" aria-label="Tag"><option value="">All tags</option>
        ${CONFIG.tags.map((t) => `<option ${t === s.tag ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
      <select id="sort" aria-label="Sort">
        <option value="recent" ${s.sort === 'recent' ? 'selected' : ''}>Recently added</option>
        <option value="title" ${s.sort === 'title' ? 'selected' : ''}>Title A–Z</option>
        <option value="author" ${s.sort === 'author' ? 'selected' : ''}>Author A–Z</option>
      </select>
    </div>
    <div id="grid"></div>
    <p class="small muted" style="margin-top:24px;text-align:center"><a href="/api/export.csv">Export CSV</a></p>`;

  const load = async () => {
    const qs = new URLSearchParams({ owner: s.owner, tag: s.tag, sort: s.sort, missing_isbn: s.missing });
    const books = await api(`/api/books?${qs}`);
    $('#libcount').textContent = `${books.length} book${books.length === 1 ? '' : 's'}`;
    $('#grid').innerHTML = books.length
      ? `<div class="grid">${books.map((b) => `<a href="#/book/${b.id}">${coverHTML(b)}
           <div class="gt">${esc(b.title)}</div><div class="ga">${esc(b.authors)}</div></a>`).join('')}</div>`
      : `<div class="empty"><div class="big">📭</div><p>No books here yet.</p>
           <p><a class="btn primary" href="#/scan">Scan a barcode</a></p></div>`;
  };
  $('#ownerFilters').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if ('missing' in btn.dataset) {
      s.missing = !s.missing;
      btn.classList.toggle('on', s.missing);
    } else {
      s.owner = btn.dataset.owner;
      $$('#ownerFilters button[data-owner]').forEach((b) => b.classList.toggle('on', b === btn));
    }
    load();
  };
  $('#tag').onchange = (e) => { s.tag = e.target.value; load(); };
  $('#sort').onchange = (e) => { s.sort = e.target.value; load(); };
  load();
}

// ---------- Book detail ----------

async function renderBook(m) {
  let b;
  try { b = await api(`/api/books/${m[1]}`); } catch (e) {
    view.innerHTML = `<a class="back" href="#/library">‹ Library</a><p>${esc(e.message)}</p>`;
    return;
  }
  const fact = (label, value) => (value ? `<dt>${label}</dt><dd>${esc(value)}</dd>` : '');
  view.innerHTML = `
    <a class="back" href="javascript:history.back()">‹ Back</a>
    <div class="detail-head">
      ${coverHTML(b)}
      <div>
        <h1>${esc(b.title)}</h1>
        ${b.subtitle ? `<p class="muted">${esc(b.subtitle)}</p>` : ''}
        <p><strong>${esc(b.authors)}</strong></p>
        <div>${chips(b)}</div>
        <div style="margin-top:4px">${b.tags.map((t) => `<span class="chip">#${esc(t)}</span>`).join('')}</div>
      </div>
    </div>
    <div class="card"><dl class="facts">
      ${fact('Edition', b.edition)}
      ${fact('Series', [b.series, b.series_number && `#${b.series_number}`].filter(Boolean).join(' '))}
      ${fact('Owner', b.owner)}
      ${fact('Location', b.location)}
      ${fact('Format', b.format)}
      ${fact('Publisher', b.publisher)}
      ${fact('Published', b.published_year)}
      ${fact('Pages', b.page_count)}
      ${fact('ISBN-13', b.isbn13)}
      ${fact('ISBN-10', b.isbn10)}
      ${fact('Copies', b.copies > 1 ? b.copies : '')}
      ${fact('Added', (b.created_at || '').slice(0, 10))}
    </dl></div>
    ${b.notes ? `<h2>Notes</h2><div class="card description">${esc(b.notes)}</div>` : ''}
    ${b.description ? `<h2>Description</h2><div class="card description small">${esc(b.description)}</div>` : ''}
    <div class="actions">
      <a class="btn primary" href="#/scan?book=${b.id}">${ICON_CAMERA} ${b.isbn13 || b.isbn10 ? 'Re-scan barcode' : 'Scan barcode'}</a>
    </div>
    <div class="actions">
      <a class="btn" href="#/book/${b.id}/edit">Edit</a>
      <button class="btn danger" id="del">Delete</button>
    </div>`;
  $('#del').onclick = async () => {
    if (!confirm(`Delete “${b.title}” from your library?`)) return;
    try {
      await api(`/api/books/${b.id}`, { method: 'DELETE' });
      toast('Deleted');
      location.hash = '#/library';
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- Add / Edit ----------

const EMPTY = {
  title: '', subtitle: '', authors: '', isbn13: '', isbn10: '', publisher: '', published_year: '',
  series: '', series_number: '', edition: '', format: '', page_count: null, description: '',
  owner: '', location: '', tags: [], notes: '', cover_url: '', copies: 1,
};

function bookForm(b) {
  const f = (name, label, attrs = '') => `<div class="field"><label for="f_${name}">${label}</label>
      <input type="text" id="f_${name}" name="${name}" value="${esc(b[name] ?? '')}" ${attrs}></div>`;
  return `
  <form class="form" id="bookForm" autocomplete="off">
    <div class="row" style="align-items:flex-start;margin-bottom:12px">
      <div style="flex:none" id="coverPrev">${coverHTML(b)}</div>
      <div>${f('title', 'Title *', 'required')}</div>
    </div>
    ${f('subtitle', 'Subtitle')}
    ${f('authors', 'Author(s)', 'placeholder="Separate with commas"')}
    <div class="grid2">${f('series', 'Series')}${f('series_number', 'Series #', 'inputmode="decimal"')}</div>
    <div class="field"><label for="f_edition">Special edition details</label>
      <input type="text" id="f_edition" name="edition" value="${esc(b.edition)}"
             placeholder="e.g. Signed first edition, Folio Society, sprayed edges">
    </div>
    <div class="grid2">
      <div class="field"><label for="f_owner">Owner</label><select id="f_owner" name="owner">${ownerOptions(b.owner)}</select></div>
      <div class="field"><label for="f_format">Format</label><select id="f_format" name="format">
        <option value="">—</option>${CONFIG.formats.map((x) => `<option ${x === b.format ? 'selected' : ''}>${esc(x)}</option>`).join('')}
      </select></div>
    </div>
    <div class="grid2">
      ${f('location', 'Location / shelf', 'list="locs" placeholder="Living room, top shelf"')}
      <div class="field"><label for="f_copies">Copies</label>
        <input type="number" id="f_copies" name="copies" min="1" value="${esc(b.copies || 1)}" inputmode="numeric"></div>
    </div>
    <div class="field"><label for="f_tags">Tags</label>
      <input type="text" id="f_tags" name="tags" value="${esc((b.tags || []).join(', '))}" placeholder="fantasy, to-read, gift">
      <div class="hint" id="tagSuggest">${CONFIG.tags.slice(0, 12).map((t) => `<button type="button" class="chip" data-tag="${esc(t)}" style="border:0;cursor:pointer">+ ${esc(t)}</button>`).join('')}</div>
    </div>
    <div class="grid2">${f('isbn13', 'ISBN-13', 'inputmode="numeric"')}${f('isbn10', 'ISBN-10')}</div>
    <div class="grid2">${f('publisher', 'Publisher')}${f('published_year', 'Year', 'inputmode="numeric"')}</div>
    <div class="grid2">
      <div class="field"><label for="f_page_count">Pages</label>
        <input type="number" id="f_page_count" name="page_count" value="${esc(b.page_count ?? '')}" inputmode="numeric"></div>
      ${f('cover_url', 'Cover image URL', 'type="url"')}
    </div>
    <div class="field"><label for="f_notes">Notes</label><textarea id="f_notes" name="notes">${esc(b.notes)}</textarea></div>
    <div class="field"><label for="f_description">Description</label><textarea id="f_description" name="description">${esc(b.description)}</textarea></div>
    ${datalist('locs', CONFIG.locations)}
    <div class="sticky-actions"><button class="btn primary block big" type="submit">Save book</button></div>
  </form>`;
}

function wireForm(onSubmit) {
  const form = $('#bookForm');
  $('#tagSuggest').onclick = (e) => {
    const tag = e.target.dataset.tag;
    if (!tag) return;
    const input = form.tags;
    const tags = input.value.split(',').map((t) => t.trim()).filter(Boolean);
    if (!tags.includes(tag)) tags.push(tag);
    input.value = tags.join(', ');
  };
  form.cover_url.addEventListener('change', () => {
    $('#coverPrev').innerHTML = coverHTML({ cover: form.cover_url.value, title: form.title.value });
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.tags = data.tags.split(',').map((t) => t.trim()).filter(Boolean);
    data.page_count = data.page_count ? parseInt(data.page_count, 10) : null;
    data.copies = parseInt(data.copies, 10) || 1;
    if (data.owner) store('lastOwner', data.owner);
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try { await onSubmit(data); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; }
  };
}

function fillForm(b) {
  const form = $('#bookForm');
  for (const [k, v] of Object.entries(b)) {
    const el = form.elements[k];
    if (!el || v == null || v === '') continue;
    if (k === 'tags') {
      const merged = new Set([...el.value.split(',').map((t) => t.trim()).filter(Boolean), ...v]);
      el.value = [...merged].join(', ');
    } else if (el.tagName === 'SELECT') {
      if (![...el.options].some((o) => o.value === v)) el.add(new Option(v, v));
      el.value = v;
    } else {
      el.value = v;
    }
  }
  $('#coverPrev').innerHTML = coverHTML({ cover: b.cover_url, title: b.title });
}

async function renderAdd(_m, params) {
  await loadConfig();
  const draft = { ...EMPTY, owner: store('lastOwner') || '', ...(state.draft || {}) };
  state.draft = null;
  view.innerHTML = `
    <h1>Add a book</h1>
    <div class="card" style="margin-bottom:16px">
      <label class="small muted" for="lq" style="font-weight:600">Autofill from Google Books / Open Library</label>
      <div class="row" style="margin-top:6px">
        <input id="lq" type="search" placeholder="Title, author, or ISBN" enterkeyhint="search" value="${esc(params.get('q') || '')}">
        <button class="btn" id="lgo" style="flex:none">Find</button>
      </div>
      <div id="cands" class="candidates"></div>
    </div>
    ${bookForm(draft)}`;

  const lookupRun = async () => {
    const q = $('#lq').value.trim();
    if (!q) return;
    const cands = $('#cands');
    cands.innerHTML = '<div class="spinner"></div>';
    try {
      const found = await api(`/api/lookup?q=${encodeURIComponent(q)}`);
      cands.innerHTML = found.length ? found.map((c, i) => `<button type="button" class="item" data-i="${i}">
          ${coverHTML({ cover: c.cover_url, title: c.title })}
          <div class="meta"><div class="title">${esc(c.title)}</div><div class="authors">${esc(c.authors)}</div>
          <div class="small muted">${esc([c.publisher, c.published_year, c.isbn13].filter(Boolean).join(' · '))}</div></div>
        </button>`).join('') : '<p class="muted small">Nothing found. Fill in the form by hand.</p>';
      cands.onclick = (e) => {
        const btn = e.target.closest('[data-i]');
        if (!btn) return;
        const c = found[+btn.dataset.i];
        fillForm({ ...c, tags: (c.categories || []).slice(0, 2).map((t) => t.toLowerCase()) });
        cands.innerHTML = '<p class="small" style="color:var(--good);font-weight:600">✓ Filled in. Check the details, then save.</p>';
      };
    } catch (err) { cands.innerHTML = `<p class="muted small">${esc(err.message)}</p>`; }
  };
  $('#lgo').onclick = lookupRun;
  $('#lq').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookupRun(); } });
  if (params.get('q') && !draft.title) lookupRun();

  wireForm(async (data) => {
    // Warn about duplicates before saving.
    const probe = data.isbn13 || data.isbn10 || data.title;
    const dupes = await api(`/api/search?q=${encodeURIComponent(probe)}&limit=5`);
    const same = dupes.filter((d) => d.title.toLowerCase() === data.title.trim().toLowerCase()
      || (data.isbn13 && d.isbn13 === data.isbn13.replace(/[^0-9X]/gi, '')));
    if (same.length && !confirm(`You already have “${same[0].title}”${same[0].owner ? ` (${same[0].owner})` : ''}. Add it anyway?`)) return;
    const book = await api('/api/books', { json: data });
    toast('Book added');
    location.hash = `#/book/${book.id}`;
  });
}

async function renderEdit(m) {
  await loadConfig();
  const b = await api(`/api/books/${m[1]}`);
  view.innerHTML = `
    <a class="back" href="#/book/${b.id}">‹ Cancel</a>
    <div class="topbar"><h1>Edit book</h1>
      <button class="btn" id="coverPhoto" style="flex:none">${ICON_CAMERA} Cover photo</button></div>
    ${bookForm(b)}`;
  wireForm(async (data) => {
    await api(`/api/books/${b.id}`, { method: 'PUT', json: data });
    toast('Saved');
    location.hash = `#/book/${b.id}`;
  });
  $('#coverPhoto').onclick = () => filePicker(async (file) => {
    const fd = new FormData();
    fd.append('image', await shrink(file, 1600), 'cover.jpg');
    try {
      const updated = await api(`/api/books/${b.id}/cover`, { method: 'POST', body: fd });
      $('#coverPrev').innerHTML = coverHTML(updated);
      $('#bookForm').cover_url.value = '';
      toast('Cover updated');
    } catch (e) { toast(e.message, true); }
  });
}

// ---------- Barcode scanner ----------

let stopScanner = null;
function stopCamera() {
  if (stopScanner) { try { stopScanner(); } catch { /* already stopped */ } stopScanner = null; }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some((s) => s.src.endsWith(src))) return resolve();
    const el = document.createElement('script');
    el.src = src; el.onload = resolve; el.onerror = () => reject(new Error('Could not load barcode library'));
    document.head.appendChild(el);
  });
}

const ISBN_BARCODE = /^97[89]\d{10}$/;

/** Start the rear camera and call onCode(isbn13) once for the first book barcode seen. */
async function startScanner(video, onCode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(window.isSecureContext
      ? 'This browser cannot access the camera.'
      : 'The camera needs a secure (https) connection. Open the app through your https address, or type the ISBN below.');
  }
  let done = false;
  const accept = (text) => {
    if (done || !ISBN_BARCODE.test(text)) return;
    done = true;
    if (navigator.vibrate) navigator.vibrate(60);
    onCode(text);
  };
  const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false };

  if ('BarcodeDetector' in window) {
    // Some devices misbehave when formats are filtered, so ask for what's supported and filter ourselves.
    let formats = ['ean_13', 'upc_a', 'ean_8'];
    try { const sup = await BarcodeDetector.getSupportedFormats(); formats = formats.filter((f) => sup.includes(f)); } catch { /* keep default */ }
    const detector = formats.length ? new BarcodeDetector({ formats }) : new BarcodeDetector();
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    focusContinuously(stream);
    const timer = setInterval(async () => {
      if (done || video.readyState < 2) return;
      try { (await detector.detect(video)).forEach((c) => accept(c.rawValue)); } catch { /* frame not ready */ }
    }, 100);
    stopScanner = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
    return;
  }

  // Fallback (iPhone, any browser): bundled ZXing decoder, fed by our own frame loop.
  await loadScript('/static/vendor/zxing.min.js');
  const reader = zxingReader();
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = stream;
  await video.play();
  focusContinuously(stream);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let n = 0;
  const timer = setInterval(() => {
    if (done || video.readyState < 2 || !video.videoWidth) return;
    // Alternate between the middle band (where you aim) and the whole frame.
    const vw = video.videoWidth, vh = video.videoHeight;
    const full = n++ % 3 === 2;
    const sw = full ? vw : Math.round(vw * 0.9), sh = full ? vh : Math.round(vh * 0.4);
    const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
    const scale = Math.min(1, 1280 / sw);
    canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    const text = decodeCanvas(canvas, reader);
    if (text) accept(text);
  }, 120);
  stopScanner = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
}

function zxingReader() {
  const hints = new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.UPC_A]],
                         [ZXing.DecodeHintType.TRY_HARDER, true]]);
  const reader = new ZXing.MultiFormatReader();
  reader.setHints(hints);
  return reader;
}

/** Decode a canvas with ZXing, trying two binarizers. Returns the text or ''. */
function decodeCanvas(canvas, reader) {
  const source = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
  for (const Binarizer of [ZXing.HybridBinarizer, ZXing.GlobalHistogramBinarizer]) {
    try { return reader.decode(new ZXing.BinaryBitmap(new Binarizer(source))).getText(); } catch { /* not found, try next */ }
  }
  return '';
}

/** Decode a still photo (taken with the phone's own camera app, which focuses far better than a video feed). */
async function decodePhoto(file) {
  await loadScript('/static/vendor/zxing.min.js');
  const reader = zxingReader();
  const bmp = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (const maxSide of [1600, 1000, 2400, 700]) {
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    for (const crop of [1, 0.6]) { // whole photo, then the middle
      const sw = bmp.width * crop, sh = bmp.height * crop;
      canvas.width = Math.round(sw * scale); canvas.height = Math.round(sh * scale);
      ctx.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
      const text = decodeCanvas(canvas, reader);
      if (ISBN_BARCODE.test(text)) return text;
    }
  }
  return '';
}

/** Ask the camera for continuous autofocus (barcodes are small, so a soft image never decodes). */
function focusContinuously(stream) {
  try {
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const adv = {};
    if (caps.focusMode?.includes('continuous')) adv.focusMode = 'continuous';
    if (Object.keys(adv).length) track.applyConstraints({ advanced: [adv] });
  } catch { /* not supported */ }
}

async function renderBarcode(_m, params) {
  // ?book=ID means "this scan is for that specific record".
  const targetId = params && params.get('book');
  let target = null;
  if (targetId) {
    try { target = await api(`/api/books/${targetId}`); } catch { /* fall back to normal scanning */ }
  }
  view.innerHTML = `
    ${target ? `<a class="back" href="#/book/${target.id}">‹ Cancel</a>` : ''}
    <h1>${target ? 'Update from barcode' : 'Scan a barcode'}</h1>
    ${target ? `<div class="item" style="margin-bottom:12px">${coverHTML(target)}<div class="meta">
        <div class="title">${esc(target.title)}</div><div class="authors">${esc(target.authors)}</div>
        <div class="small muted">Scan the barcode of your copy to fill in its ISBN and edition details.</div></div></div>` : ''}
    <div id="camwrap" class="camwrap">
      <video id="cam" playsinline muted></video>
      <div class="reticle"></div>
      <p class="camhint">Point at the barcode on the back cover</p>
    </div>
    <div class="actions" style="margin:12px 0 0"><button class="btn" id="photoBtn" type="button">📷 Take a photo of the barcode</button>
      <input id="photoIn" type="file" accept="image/*" capture="environment" hidden></div>
    <form class="row" id="isbnForm" style="margin:12px 0">
      <input id="isbnIn" type="text" inputmode="numeric" placeholder="…or type the ISBN" autocomplete="off">
      <button class="btn" type="submit" style="flex:none">Look up</button>
    </form>
    <div id="scanResult"></div>`;

  const result = $('#scanResult');
  const resume = () => { result.innerHTML = ''; $('#camwrap').classList.remove('hidden'); begin(); };

  async function handle(isbn) {
    stopCamera();
    $('#camwrap').classList.add('hidden');
    result.innerHTML = '<div class="empty"><div class="spinner"></div><p>Looking it up…</p></div>';
    let data;
    try { data = await api(`/api/isbn/${encodeURIComponent(isbn)}`); } catch (e) {
      result.innerHTML = `<div class="warnbox">${esc(e.message)}</div>
        <div class="actions"><button class="btn primary" id="next">Scan next</button></div>`;
      $('#next').onclick = resume;
      return;
    }
    if (target) {
      // The user said which record this is, so offer exactly that one, whatever the title lookup returned.
      data.candidates = data.exact.some((b) => b.id === target.id) ? [] : [target];
      data.other_editions = [];
    }
    showScanResult(result, data, resume, target);
  }

  async function begin() {
    try {
      await startScanner($('#cam'), handle);
    } catch (e) {
      $('#camwrap').classList.add('hidden');
      result.innerHTML = `<div class="warnbox">${esc(e.name === 'NotAllowedError' ? 'Camera permission was denied. Allow it in your browser settings, or type the ISBN.' : e.message)}</div>`;
    }
  }

  $('#isbnForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('#isbnIn').value.trim();
    if (v) { $('#isbnIn').value = ''; $('#isbnIn').blur(); handle(v); }
  };
  $('#photoBtn').onclick = () => $('#photoIn').click();
  $('#photoIn').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    stopCamera();
    $('#camwrap').classList.add('hidden');
    result.innerHTML = '<div class="empty"><div class="spinner"></div><p>Reading the barcode…</p></div>';
    let isbn = '';
    try { isbn = await decodePhoto(file); } catch { /* fall through to the message */ }
    if (isbn) return handle(isbn);
    result.innerHTML = `<div class="warnbox">Couldn't read a barcode in that photo. Get closer, keep the barcode flat and sharp, or type the ISBN.</div>
      <div class="actions"><button class="btn primary" id="next">Try again</button></div>`;
    $('#next').onclick = resume;
  };
  begin();
}

function showScanResult(result, data, resume, target) {
  const b = data.book;
  const exact = data.exact;
  const candidates = data.candidates;
  const bookCard = `<div class="item" style="margin-bottom:12px">${coverHTML({ cover: b.cover_url, title: b.title })}
      <div class="meta"><div class="title">${esc(b.title || 'Unknown title')}</div>
      <div class="authors">${esc(b.authors)}</div>
      <div class="small muted">${esc([b.publisher, b.published_year, b.isbn13].filter(Boolean).join(' · '))}</div></div></div>`;

  let html = '';
  if (exact.length) {
    html += `<div class="verdict own"><span class="mark">✓</span><div>${target && exact.some((e) => e.id === target.id) ? 'Already up to date' : 'You own this'}
        <div class="sub">${esc(exact.map((e) => (e.owner || 'In library') + (e.edition ? ` · ${e.edition}` : '')).join(', '))}</div></div></div>
      <div class="list" style="margin-bottom:12px">${exact.map(bookItem).join('')}</div>`;
    if (data.found) html += `<button class="btn block" data-refresh="${exact[0].id}" style="margin-bottom:10px">Refresh its details from this scan</button>`;
  } else if (candidates.length) {
    html += `<div class="verdict maybe"><span class="mark">?</span><div>${target ? 'Update this record?' : 'Is this one of yours?'}
        <div class="sub">${target ? 'This attaches the scanned ISBN and edition details' : 'Matches a book in your library that has no ISBN yet'}</div></div></div>
      ${data.found ? bookCard : ''}
      ${candidates.map((c) => `<div class="card" style="margin-bottom:10px">
          <div class="list">${bookItem(c)}</div>
          <button class="btn primary block" data-apply="${c.id}" style="margin-top:10px">Yes, update “${esc(c.title.length > 28 ? c.title.slice(0, 26) + '…' : c.title)}”</button>
        </div>`).join('')}`;
  } else {
    html += `<div class="verdict none"><span class="mark">✗</span><div>Not in your library
        <div class="sub">${data.found ? 'Add it if you buy it' : `No online match for ${esc(b.isbn13)}`}</div></div></div>`;
    if (data.found) html += bookCard;
  }
  if (data.other_editions.length) {
    html += `<div class="warnbox" style="margin-bottom:10px">You own a different edition:
      ${data.other_editions.map((o) => `<a href="#/book/${o.id}">${esc(o.title)}</a>${o.edition ? ` (${esc(o.edition)})` : ''}`).join(', ')}</div>`;
  }

  // Adding a brand-new record is the fallback, tucked away when a match was offered.
  if (!exact.length) {
    const form = data.found
      ? `<div class="card form" style="margin-bottom:12px">
          <div class="grid2">
            <div class="field"><label for="s_owner">Owner</label><select id="s_owner">${ownerOptions(store('lastOwner') || '')}</select></div>
            <div class="field"><label for="s_loc">Location</label><input type="text" id="s_loc" list="locs" value="${esc(store('lastLocation') || '')}"></div>
          </div>
          <div class="field"><label for="s_edition">Special edition details</label>
            <input type="text" id="s_edition" placeholder="e.g. signed, Folio Society, sprayed edges"></div>
          <div class="field" style="margin:0"><label for="s_tags">Tags</label>
            <input type="text" id="s_tags" value="${esc(((b.categories || [])[0] || '').toLowerCase())}" placeholder="fantasy, gift"></div>
          ${datalist('locs', CONFIG.locations)}
        </div>
        <button class="btn ${candidates.length ? '' : 'primary'} block big" id="addScanned">Add as a new book</button>`
      : `<button class="btn primary block" id="manual">Enter details by hand</button>`;
    html += candidates.length && !target
      ? `<details style="margin-top:6px"><summary class="small muted" style="cursor:pointer;padding:6px 0">None of these: it's a different book</summary>${form}</details>`
      : (candidates.length ? '' : form);
  }
  html += `<button class="btn block" id="next" style="margin-top:10px">Scan next</button>`;
  result.innerHTML = html;
  $('#next').onclick = resume;

  const applyTo = async (id, btn) => {
    btn.disabled = true;
    try {
      const updated = await api(`/api/books/${id}/apply-isbn`, { json: { isbn: b.isbn13 } });
      toast(`Updated “${updated.title}”`);
      if (target) location.hash = `#/book/${updated.id}`;   // came from a record: go back to it
      else resume();                                         // batch mode: keep scanning
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  };
  $$('[data-apply]', result).forEach((btn) => { btn.onclick = () => applyTo(btn.dataset.apply, btn); });
  $$('[data-refresh]', result).forEach((btn) => { btn.onclick = () => applyTo(btn.dataset.refresh, btn); });

  if ($('#manual', result)) $('#manual').onclick = () => { state.draft = { isbn13: b.isbn13, isbn10: b.isbn10 }; location.hash = '#/add'; };
  if ($('#addScanned', result)) $('#addScanned').onclick = async () => {
    const btn = $('#addScanned');
    btn.disabled = true;
    const owner = $('#s_owner').value;
    const loc = $('#s_loc').value.trim();
    if (owner) store('lastOwner', owner);
    store('lastLocation', loc);
    const { categories, source, ...book } = b;
    try {
      const saved = await api('/api/books', { json: {
        ...book, owner, location: loc, edition: $('#s_edition').value.trim(),
        tags: $('#s_tags').value.split(',').map((t) => t.trim()).filter(Boolean),
      } });
      toast(`Added “${saved.title}”`);
      resume();
    } catch (e) { toast(e.message, true); btn.disabled = false; }
  };
}

// ---------- boot ----------

(async () => {
  await loadConfig();
  route();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
})();
