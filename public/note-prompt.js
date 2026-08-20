// The note switcher behind Mod-Alt-O.
//
// A sibling of path-prompt.js: the same dialog, the same rows and the same keys,
// over notes instead of folders. Simpler, because there is nothing to create and
// nothing to veto — every row is a note that can be opened.
//
// A plain script rather than something under src/ for the same reason as the
// folder picker: everything there is bundled into the editor, and this is chrome
// around the editor, not part of it.

window.NotePrompt = (function () {
  const dialog = document.getElementById('note-prompt');
  const input = document.getElementById('note-prompt-input');
  const listEl = document.getElementById('note-prompt-list');
  const errorEl = document.getElementById('note-prompt-error');

  let settle = null;  // resolve of the promise the current open() handed out
  let chosen = null;  // the path picked, set just before the dialog closes
  let notes = [];     // every note that can be switched to
  let rows = [];      // what the list is showing
  let active = 0;

  /// Ranks a note against what has been typed, lower being better, or null for
  /// no match at all. The same three tiers as path-prompt.js, and matched over
  /// "folder/name" so that naming the folder narrows the list the same way.
  function rank(haystack, query) {
    if (!query) return 0;
    const at = haystack.indexOf(query);
    if (at === 0) return 0;
    if (at > 0) return 1;
    let i = 0;
    for (const ch of haystack) if (ch === query[i] && ++i === query.length) return 2;
    return null;
  }

  function buildRows() {
    const query = input.value.trim().toLowerCase();
    rows = notes.filter(note => (note.score = rank(note.haystack, query)) !== null);
    // Nothing typed means the list is being browsed rather than searched, so it
    // keeps the order of the tree — sort is stable. Once there is a query, the
    // better tier wins and the shortest match breaks the tie, since that is the
    // note whose name is closest to what was typed.
    rows.sort((a, b) =>
      (a.score - b.score) ||
      (query ? (a.haystack.length - b.haystack.length) || a.haystack.localeCompare(b.haystack) : 0));

    errorEl.textContent = rows.length
      ? ''
      : (notes.length ? 'No note matches' : 'No other notes yet');
    active = 0;
    render();
  }

  function render() {
    listEl.innerHTML = '';
    rows.forEach((note, i) => {
      const el = document.createElement('div');
      el.className = 'picker-row';
      if (i === active) el.classList.add('is-active');

      const icon = document.createElement('span');
      icon.className = 'picker-row-icon';
      icon.textContent = '·'; // The tree marks notes the same way.
      el.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'picker-row-label';
      label.textContent = note.name;
      el.appendChild(label);

      // Two notes can share a name in different folders, so where it lives is
      // part of telling them apart.
      if (note.folder) {
        const aside = document.createElement('span');
        aside.className = 'picker-row-aside';
        aside.textContent = note.folder;
        el.appendChild(aside);
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

    if (rows.length) listEl.children[active].scrollIntoView({ block: 'nearest' });
  }

  function move(delta) {
    if (!rows.length) return;
    active = (active + delta + rows.length) % rows.length;
    render();
  }

  function submit() {
    const note = rows[active];
    if (!note) return;
    chosen = note.path;
    dialog.close();
  }

  input.addEventListener('input', buildRows);

  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); submit(); }
  });

  document.getElementById('note-prompt-close')
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

  /// Resolves with the path of the note to open, or null if it was dismissed.
  /// `notes` is the tree's note entries — {name, path} — already filtered down
  /// to the ones worth offering.
  function open(options) {
    if (dialog.open) return Promise.resolve(null);
    chosen = null;
    notes = (options.notes || []).map(note => ({
      path: note.path,
      name: note.name.replace(/\.md$/, ''),
      folder: note.path.includes('/') ? note.path.slice(0, note.path.lastIndexOf('/')) : '',
      // The extension is not matched against: nobody searches for ".md", and
      // leaving it in would have every note match a query of "m".
      haystack: note.path.replace(/\.md$/, '').toLowerCase(),
    }));
    input.value = '';
    buildRows();
    dialog.showModal();
    input.focus();
    return new Promise(resolve => { settle = resolve; });
  }

  return { open, isOpen: () => dialog.open };
})();
