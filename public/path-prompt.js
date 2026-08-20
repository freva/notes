// The folder picker behind "New note in…" and "Move to…".
//
// It is also the only way to make a folder: a path that matches nothing is
// offered as "Create …", and the folders along it come into being when the note
// lands there. That is why there is no New folder button.
//
// A plain script rather than something under src/ — everything there is bundled
// into the editor, and this is chrome around the editor, not part of it.

window.PathPrompt = (function () {
  const dialog = document.getElementById('path-prompt');
  const titleEl = document.getElementById('path-prompt-title');
  const input = document.getElementById('path-prompt-input');
  const errorEl = document.getElementById('path-prompt-error');
  const listEl = document.getElementById('path-prompt-list');

  let settle = null;    // resolve of the promise the current open() handed out
  let chosen = null;    // the path picked, set just before the dialog closes
  let folders = [];     // every existing folder path, root excluded
  let validate = null;  // caller's veto: destination -> error message or null
  let rows = [];        // what the list is showing
  let active = 0;
  let emptyMessage = '';

  /// A loose mirror of the server's sanitizeRelPath. The server has the last
  /// word on the name a folder ends up with; this exists so that the "Create …"
  /// row can show the path you are actually going to get.
  function cleanPath(text) {
    return text
      .split('/')
      .filter(seg => seg.trim() !== '.' && seg.trim() !== '..')
      .map(seg => seg.replace(/[\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('/');
  }

  /// Ranks a folder against what has been typed, lower being better, or null
  /// for no match at all. Slashes are matched like any other character, so
  /// "jou/26" reaches journal/2026 without having to be spelled out.
  function rank(folder, query) {
    if (!query) return 0;
    const path = folder.toLowerCase();
    const q = query.toLowerCase();
    const at = path.indexOf(q);
    if (at === 0) return 0;
    if (at > 0) return 1;
    let i = 0;
    for (const ch of path) if (ch === q[i] && ++i === q.length) return 2;
    return null;
  }

  function buildRows() {
    // A trailing slash means "inside this one" rather than being part of the
    // name, so it is not matched against: after Tab completes to "journal/",
    // journal itself still has to be offered.
    const query = input.value.trim().replace(/\/+$/, '');
    const typed = cleanPath(input.value);
    rows = [];

    // Create comes first: a path that is not there yet is almost certainly what
    // you meant by typing it, so Enter should take it without any arrowing.
    if (typed && !folders.includes(typed)) {
      rows.push({ value: typed, label: typed, kind: 'create', error: validate(typed) });
    }

    const matches = [];
    for (const folder of folders) {
      const score = rank(folder, query);
      if (score === null || validate(folder)) continue;
      matches.push({ value: folder, label: folder, kind: 'folder', score, exact: folder === typed });
    }
    matches.sort((a, b) =>
      (b.exact - a.exact) ||
      (a.score - b.score) ||
      // Nothing typed means the list is being browsed rather than searched, so
      // it is left in the order the tree walk produced it — sort is stable. Once
      // there is a query the shortest match is the likeliest one.
      (query ? (a.value.length - b.value.length) || a.value.localeCompare(b.value) : 0));
    rows.push(...matches);

    // The root has no text to type, so it is offered whenever the box is empty
    // — which, for a move, is one Backspace-held away.
    if (!query && !validate('')) {
      rows.unshift({ value: '', label: 'Notes root', kind: 'root' });
    }

    // An empty list has to say why. The typed path can be missing from it either
    // because nothing is like it or because the caller ruled it out — moving a
    // folder into one of its own children being the case that gets there.
    emptyMessage = rows.length ? '' : (validate(typed) || 'No folder matches');

    active = 0;
    render();
  }

  const ICONS = { create: '＋', folder: '🗀', root: '/' };

  function render() {
    listEl.innerHTML = '';
    rows.forEach((row, i) => {
      const el = document.createElement('div');
      el.className = 'picker-row';
      if (i === active) el.classList.add('is-active');
      if (row.error) el.classList.add('is-invalid');

      const icon = document.createElement('span');
      icon.className = 'picker-row-icon';
      icon.textContent = ICONS[row.kind];
      el.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'picker-row-label';
      label.textContent = row.label;
      el.appendChild(label);

      if (row.kind === 'create') {
        const tag = document.createElement('span');
        tag.className = 'picker-row-tag';
        tag.textContent = 'new folder';
        el.appendChild(tag);
      }

      // mousedown, not click: the input must not lose focus first, and clicking
      // a row is meant to pick it outright rather than only highlight it.
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        active = i;
        submit();
      });
      listEl.appendChild(el);
    });

    const row = rows[active];
    errorEl.textContent = row ? (row.error || '') : emptyMessage;
    if (row) listEl.children[active].scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    if (!rows.length) return;
    active = (active + delta + rows.length) % rows.length;
    render();
  }

  function submit() {
    const row = rows[active];
    if (!row || row.error) return;
    chosen = row.value;
    dialog.close();
  }

  input.addEventListener('input', buildRows);

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Tab') {
      // Fill the box with the highlighted folder instead of picking it, so that
      // Tab-then-type walks down into a subfolder.
      e.preventDefault();
      const row = rows[active];
      if (!row) return;
      input.value = row.value ? row.value + '/' : '';
      buildRows();
    }
  });

  document.getElementById('path-prompt-close')
    .addEventListener('click', () => dialog.close());

  // Escape and the backdrop both come out here, with chosen still null.
  dialog.addEventListener('close', () => {
    const done = settle;
    settle = null;
    listEl.innerHTML = '';
    if (done) done(chosen);
  });

  dialog.addEventListener('mousedown', e => {
    if (e.target === dialog) dialog.close();
  });

  /// Resolves with a folder path — '' for the notes root — or null if it was
  /// dismissed. The path may well not exist yet; whoever asked passes it on to
  /// the server, which creates it.
  function open(options) {
    if (dialog.open) return Promise.resolve(null);
    chosen = null;
    folders = options.folders || [];
    validate = options.validate || (() => null);
    titleEl.textContent = options.title;
    input.value = options.value ? options.value + '/' : '';
    buildRows();
    dialog.showModal();
    input.focus();
    // Caret at the end rather than a selected value: the prefilled path is
    // where you already are, and typing continues from it.
    input.setSelectionRange(input.value.length, input.value.length);
    return new Promise(resolve => { settle = resolve; });
  }

  return { open, isOpen: () => dialog.open };
})();
