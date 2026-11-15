/* Bookshelf front end: vanilla JS, hash routing, no build step. */
'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const view = $('#view');

let CONFIG = { owners: [], formats: [], tags: [], locations: [], count: 0 };
const state = {
  q: '',                                   // last search query
  lib: { owner: '', tag: '', sort: 'recent' },
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
  results.innerHTML = `<p class="stats">${CONFIG.count} book${CONFIG.count === 1 ? '' : 's'} in your library</p>
    <h2>Recently added</h2><div class="list">${recent.map(bookItem).join('')}</div>`;
}

// ---------- Library ----------

async function renderLibrary() {
  await loadConfig();
  const s = state.lib;
  const ownerList = CONFIG.owners;
  view.innerHTML = `
    <div class="topbar"><h1>Library</h1><span class="stats" id="libcount"></span></div>
    <div class="filters" id="ownerFilters">
      <button data-owner="" class="${s.owner ? '' : 'on'}">Everyone</button>
      ${ownerList.map((o) => `<button data-owner="${esc(o)}" class="${s.owner === o ? 'on' : ''}">${esc(o)}</button>`).join('')}
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
    const qs = new URLSearchParams({ owner: s.owner, tag: s.tag, sort: s.sort });
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
    s.owner = btn.dataset.owner;
    $$('#ownerFilters button').forEach((b) => b.classList.toggle('on', b === btn));
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
      <a class="btn primary" href="#/book/${b.id}/edit">Edit</a>
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
  const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };

  if ('BarcodeDetector' in window) {
    const detector = new BarcodeDetector({ formats: ['ean_13'] });
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();
    const timer = setInterval(async () => {
      if (done || video.readyState < 2) return;
      try { (await detector.detect(video)).forEach((c) => accept(c.rawValue)); } catch { /* frame not ready */ }
    }, 150);
    stopScanner = () => { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); video.srcObject = null; };
    return;
  }

  // Fallback (iPhone Safari etc.): bundled ZXing decoder.
  await loadScript('/static/vendor/zxing.min.js');
  const hints = new Map([[ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13]],
                         [ZXing.DecodeHintType.TRY_HARDER, true]]);
  const reader = new ZXing.BrowserMultiFormatReader(hints, 200);
  stopScanner = () => reader.reset();
  await reader.decodeFromConstraints(constraints, video, (result) => { if (result) accept(result.getText()); });
}

function renderBarcode() {
  view.innerHTML = `
    <h1>Scan a barcode</h1>
    <div id="camwrap" class="camwrap">
      <video id="cam" playsinline muted></video>
      <div class="reticle"></div>
      <p class="camhint">Point at the barcode on the back cover</p>
    </div>
    <form class="row" id="isbnForm" style="margin:12px 0">
      <input id="isbnIn" type="text" inputmode="numeric" placeholder="…or type the ISBN" autocomplete="off">
      <button class="btn" type="submit" style="flex:none">Look up</button>
    </form>
    <div id="scanResult"></div>
`;

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
    showScanResult(result, data, resume);
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
  begin();
}

function showScanResult(result, data, resume) {
  const b = data.book;
  const owned = data.existing.length > 0;
  const card = `<div class="item" style="margin-bottom:12px">${coverHTML({ cover: b.cover_url, title: b.title })}
      <div class="meta"><div class="title">${esc(b.title || 'Unknown title')}</div>
      <div class="authors">${esc(b.authors)}</div>
      <div class="small muted">${esc([b.publisher, b.published_year, b.isbn13].filter(Boolean).join(' · '))}</div></div></div>`;

  let html = owned
    ? `<div class="verdict own"><span class="mark">✓</span><div>You own this
         <div class="sub">${esc(data.existing.map((e) => (e.owner || 'In library') + (e.edition ? ` · ${e.edition}` : '')).join(', '))}</div></div></div>
       <div class="list" style="margin-bottom:12px">${data.existing.map(bookItem).join('')}</div>`
    : `<div class="verdict none"><span class="mark">✗</span><div>Not in your library
         <div class="sub">${data.found ? 'Add it if you buy it' : `No online match for ${esc(b.isbn13)}`}</div></div></div>`;
  if (!owned && data.found) html += card;

  if (!owned) {
    if (data.found) {
      const tag = (b.categories || [])[0];
      html += `<div class="card form" style="margin-bottom:12px">
        <div class="grid2">
          <div class="field"><label for="s_owner">Owner</label><select id="s_owner">${ownerOptions(store('lastOwner') || '')}</select></div>
          <div class="field"><label for="s_loc">Location</label><input type="text" id="s_loc" list="locs" value="${esc(store('lastLocation') || '')}"></div>
        </div>
        <div class="field"><label for="s_edition">Special edition details</label>
          <input type="text" id="s_edition" placeholder="e.g. signed, Folio Society, sprayed edges"></div>
        <div class="field" style="margin:0"><label for="s_tags">Tags</label>
          <input type="text" id="s_tags" value="${esc(tag ? tag.toLowerCase() : '')}" placeholder="fantasy, gift"></div>
        ${datalist('locs', CONFIG.locations)}
      </div>
      <button class="btn primary block big" id="addScanned">Add to library</button>`;
    } else {
      html += `<button class="btn primary block" id="manual">Enter details by hand</button>`;
    }
  }
  html += `<button class="btn block" id="next" style="margin-top:10px">Scan next</button>`;
  result.innerHTML = html;
  $('#next').onclick = resume;

  if ($('#manual')) $('#manual').onclick = () => { state.draft = { isbn13: b.isbn13, isbn10: b.isbn10 }; location.hash = '#/add'; };
  if ($('#addScanned')) $('#addScanned').onclick = async () => {
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
