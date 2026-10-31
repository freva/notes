// The editor itself lives in src/editor.js and is bundled to
// public/editor.bundle.js (`pnpm run build`), which exposes it as NotesEditor.
// This file owns the sidebar, the note tree and the save loop.

const editor = document.getElementById('editor');
const editorWrap = document.getElementById('editor-wrap');
const treeEl = document.getElementById('tree');
const newNoteBtn = document.getElementById('new-note');
const topbarTitle = document.getElementById('topbar-title');

// Chords are written the way CodeMirror writes them, with 'Mod' standing for
// Cmd on a Mac and Ctrl everywhere else, and are rendered a key at a time.
const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

const KEY_LABELS = IS_MAC
  ? { Mod: '⌘', Alt: '⌥', Shift: '⇧' }
  : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };

let currentNotePath = null;
// mtime of the file as of the last time this tab read or wrote it, for telling a
// change made elsewhere from one made here when the tab comes back into view.
let currentNoteMtime = null;
let treeData = [];
let saveTimer = null;
let lastSavedContent = '';
const expandedFolders = new Set();

NotesEditor.configure({ onChange: scheduleSave });

const parentOf = (path) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';

// ---------------- Context folder ----------------
//
// Where a new note goes when you do not say. Both opening a note and clicking a
// folder set it, so it is whichever of the two you touched last — which is the
// only rule that gets both "another one in here" and "one in that folder over
// there" right without a dialog. '' is the notes root.

let contextFolder = '';

function setContextFolder(path) {
  contextFolder = path;
  for (const el of treeEl.querySelectorAll('.tree-entry.context')) el.classList.remove('context');
  if (path) {
    const entry = treeEl.querySelector(`.tree-entry[data-type="folder"][data-path="${CSS.escape(path)}"]`);
    if (entry) entry.classList.add('context');
  }
  newNoteBtn.title = contextFolder
    ? `New note in ${contextFolder} (${KEY_LABELS.Mod}+${KEY_LABELS.Alt}+N)`
    : `New note (${KEY_LABELS.Mod}+${KEY_LABELS.Alt}+N)`;
}

// ---------------- Current note ----------------

/// The one place currentNotePath is assigned: the window title and the URL
/// follow from it, and a note's path changes on more occasions than you would
/// think — a save can rename the file (the first line is the filename), and so
/// can renaming or moving a folder above it. Those replace the URL in place;
/// only opening a note by hand (`push`) makes a history entry to go back to.
function setCurrentNote(path, { push = false } = {}) {
  currentNotePath = path;
  if (path) setContextFolder(parentOf(path));
  const name = path ? path.split('/').pop().replace(/\.md$/, '') : null;
  document.title = name ? `${name} - Notes` : 'Notes';
  topbarTitle.textContent = name || 'Notes';
  syncUrl(path, push);
}

// ---------------- URL ----------------
//
// The open note is the URL: /n/<path to the note>, so a reload lands on the same
// note, a URL can be bookmarked or pasted into another tab, and back and forward
// walk through the notes opened in this one. The server answers every /n/* with
// the app; the /n/ prefix is what keeps note paths clear of /api and of the
// files in public/. No note is /.

const NOTE_URL_PREFIX = '/n/';

function noteFromUrl() {
  if (!location.pathname.startsWith(NOTE_URL_PREFIX)) return null;
  const path = decodeURIComponent(location.pathname.slice(NOTE_URL_PREFIX.length));
  return path || null;
}

function urlFor(path) {
  if (!path) return '/';
  // Segment by segment, so that the slashes stay slashes and anything else a
  // browser would mangle — spaces, #, ? — is escaped.
  return NOTE_URL_PREFIX + path.split('/').map(encodeURIComponent).join('/');
}

function syncUrl(path, push) {
  if (noteFromUrl() === (path || null)) return;
  if (push) history.pushState(null, '', urlFor(path));
  else history.replaceState(null, '', urlFor(path));
}

/// Open the note the URL names, if it is still there. The path can have gone
/// stale — the note may have been deleted, or renamed by an edit in another
/// tab — so check against the tree instead of firing off a request that 404s.
async function openNoteFromUrl() {
  const path = noteFromUrl();
  if (!path) return;
  if (!findNote(path)) {
    setCurrentNote(null);
    return;
  }
  await openNote(path, { push: false });
}

/// Back and forward. Not pushed, or every step back would add a step forward.
window.addEventListener('popstate', async () => {
  const path = noteFromUrl();
  if (!path) {
    if (currentNotePath) await closeNote();
  } else if (path !== currentNotePath) {
    await openNote(path, { push: false });
  }
});

function findNote(path, items = treeData) {
  for (const item of items) {
    if (item.type === 'folder') {
      const found = findNote(path, item.children);
      if (found) return found;
    } else if (item.path === path) {
      return item;
    }
  }
  return null;
}

// ---------------- Save & load ----------------

function scheduleSave() {
  if (!currentNotePath) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNote, 800);
}

async function saveNote() {
  saveTimer = null;
  if (!currentNotePath || !NotesEditor.isLoaded()) return;
  const content = NotesEditor.getMarkdown();
  if (content === lastSavedContent) return;
  const pathBeingSaved = currentNotePath;
  try {
    const res = await fetch('/api/note', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: pathBeingSaved, content }),
    });
    if (!res.ok) throw new Error('Save failed');
    const data = await res.json();
    lastSavedContent = content;
    if (currentNotePath === pathBeingSaved) {
      currentNoteMtime = data.mtime;
      if (data.path && data.path !== pathBeingSaved) setCurrentNote(data.path);
    }
    await loadTree();
  } catch (err) {
    console.error('Save error:', err);
  }
}

// A new note is a file on disk before it has a name or a word in it, and the
// shortcut makes those cheap to create by accident. One that is still called
// Untitled and still empty when you leave it is thrown away instead of being
// left in the tree; the server checks both conditions again before unlinking.
const UNTITLED_RE = /^Untitled( \(\d+\))?\.md$/;

function isDiscardable() {
  if (!currentNotePath || !NotesEditor.isLoaded()) return false;
  if (!UNTITLED_RE.test(currentNotePath.split('/').pop())) return false;
  return NotesEditor.getMarkdown().trim() === '';
}

function discardRequest(path, keepalive = false) {
  return fetch('/api/note?path=' + encodeURIComponent(path), { method: 'DELETE', keepalive });
}

/// Writes the note out now, ahead of anything that depends on its path. The save
/// is debounced by 800ms, so without this a rename — the first line is the filename — can land in the
/// middle of a move and leave it working from a path that no longer exists.
async function flushCurrentNote() {
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveNote(); // Returns immediately when nothing has changed.
}

/// Everything that has to happen before currentNotePath stops being the note on
/// screen: the pending save is flushed, or the note is dropped if it never
/// became anything. Not called when the note has just been deleted — flushing
/// then would write it straight back.
async function leaveCurrentNote() {
  if (!currentNotePath) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (isDiscardable()) {
    try {
      await discardRequest(currentNotePath);
    } catch (err) {
      console.error('Discard error:', err); // An empty note left behind is harmless.
    }
    return;
  }
  await saveNote();
}

/// True when `path` is the note on screen, whose live path is currentNotePath —
/// the tree's copy of it goes stale as soon as a save renames the file.
function isCurrentNote(path) {
  return currentNotePath === path;
}

async function fetchNote(path) {
  const res = await fetch('/api/note?path=' + encodeURIComponent(path));
  if (!res.ok) throw new Error('Failed to load note');
  return res.json();
}

/// Puts `data` (as /api/note returns it) into the editor as the current note.
/// What the editor reports back is the saved baseline, so merely opening a
/// note never looks like an edit. False when another load superseded this one.
async function showNote(data) {
  const normalized = await NotesEditor.load(editor, data.content);
  if (normalized === null) return false;
  lastSavedContent = normalized;
  currentNoteMtime = data.mtime;
  editor.classList.add('visible');
  editorWrap.classList.add('has-note');
  return true;
}

// On a touch screen focusing the editor brings up the keyboard, which is in the
// way when a note is opened to read it. A new note is focused regardless: it is
// opened to be typed into.
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;

async function openNote(path, { push = true, focus = !IS_TOUCH } = {}) {
  if (currentNotePath === path) return;
  await leaveCurrentNote();
  try {
    const data = await fetchNote(path);
    setCurrentNote(path, { push });
    if (!(await showNote(data))) return;
    await loadTree();
    if (focus) NotesEditor.focus();
  } catch (err) {
    console.error(err);
    // Reached from a history entry whose note is gone: the URL should not go
    // on naming a note that is not the one on screen.
    syncUrl(currentNotePath, false);
  }
}

async function closeNote() {
  setCurrentNote(null);
  currentNoteMtime = null;
  lastSavedContent = '';
  clearTimeout(saveTimer);
  saveTimer = null;
  await NotesEditor.unload(editor);
  editor.classList.remove('visible');
  editorWrap.classList.remove('has-note');
  if (NARROW.matches) openSidebar();
}

// ---------------- Refresh on return ----------------
//
// Notes can be edited in another tab, or in an editor on the .md files; nothing
// pushes those changes here. Coming back to this tab is the moment to look:
// the tree is reread, and the note on screen is reloaded if the file has been
// written since this tab last read or wrote it.

let refreshing = null;

function refreshFromDisk() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      // Whatever was typed here goes out first: the mtime comparison is then
      // against a file this tab has finished writing, and an edit that was still
      // pending cannot be thrown away by the reload — it wins, as it would have
      // once the debounced save fired.
      await flushCurrentNote();
      await loadTree();
      if (!currentNotePath) return;
      const entry = findNote(currentNotePath);
      if (!entry) {
        // Deleted, or renamed by an edit elsewhere. Closing rather than keeping
        // it: the next save here would otherwise recreate the file at a path
        // nothing else knows about.
        await closeNote();
        return;
      }
      if (entry.mtime !== currentNoteMtime) await reloadCurrentNote();
    } catch (err) {
      console.error('Refresh error:', err);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function reloadCurrentNote() {
  const path = currentNotePath;
  const data = await fetchNote(path);
  if (currentNotePath !== path) return; // switched away while it was in flight
  // A reload replaces the editor instance, which drops focus and the caret.
  // Focus is given back when it was in the note; the caret cannot be.
  const hadFocus = editor.contains(document.activeElement);
  if (!(await showNote(data))) return;
  if (hadFocus) NotesEditor.focus();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshFromDisk();
});
// Alt-tabbing back from another window does not change visibility when this
// one stayed on screen, so focus is watched too. Back-to-back with the event
// above on a tab switch, which `refreshing` folds into one pass.
window.addEventListener('focus', () => { refreshFromDisk(); });

// ---------------- Sidebar / tree ----------------

async function loadTree() {
  const res = await fetch('/api/tree');
  treeData = await res.json();
  treeEl.innerHTML = '';
  renderTreeLevel(treeData, treeEl, '');
}

function renderTreeLevel(items, container, parentPath) {
  for (const item of items) {
    const entry = document.createElement('div');
    entry.className = 'tree-entry';
    entry.dataset.path = item.path;
    entry.dataset.type = item.type;
    entry.draggable = true;
    if (item.path === currentNotePath) entry.classList.add('active');
    if (item.type === 'folder' && item.path === contextFolder) entry.classList.add('context');

    const icon = document.createElement('span');
    icon.className = 'icon';
    entry.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.type === 'note' ? item.name.replace(/\.md$/, '') : item.name;
    entry.appendChild(name);

    const actions = document.createElement('span');
    actions.className = 'entry-actions';
    entry.appendChild(actions);

    if (item.type === 'folder') {
      const addNoteBtn = mkActionBtn('＋', 'New note here', e => {
        e.stopPropagation();
        createNote(item.path);
      });
      const renameBtn = mkActionBtn('✎', 'Rename', e => {
        e.stopPropagation();
        startRename(entry, item);
      });
      actions.append(addNoteBtn, renameBtn);
    }

    const moveBtn = mkActionBtn('→', 'Move to…', e => {
      e.stopPropagation();
      promptMove(item);
    });
    actions.appendChild(moveBtn);

    const delBtn = mkActionBtn('×', 'Delete', e => {
      e.stopPropagation();
      deleteEntry(item);
    });
    delBtn.classList.add('danger');
    actions.appendChild(delBtn);

    setupDrag(entry, item);
    container.appendChild(entry);

    if (item.type === 'folder') {
      const childContainer = document.createElement('div');
      childContainer.className = 'tree-folder-children';
      const isExpanded = expandedFolders.has(item.path);
      icon.textContent = isExpanded ? '▾' : '▸';
      childContainer.style.display = isExpanded ? '' : 'none';
      renderTreeLevel(item.children, childContainer, item.path);
      container.appendChild(childContainer);
      entry.addEventListener('click', () => {
        const collapsed = childContainer.style.display === 'none';
        childContainer.style.display = collapsed ? '' : 'none';
        icon.textContent = collapsed ? '▾' : '▸';
        if (collapsed) expandedFolders.add(item.path);
        else expandedFolders.delete(item.path);
        setContextFolder(item.path);
      });
      setupDropTarget(entry, item.path);
    } else {
      icon.textContent = '·';
      entry.addEventListener('click', () => {
        closeSidebar();
        openNote(item.path);
      });
    }
  }
}

function mkActionBtn(label, title, onClick) {
  const btn = document.createElement('button');
  btn.className = 'entry-action';
  btn.type = 'button';
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener('click', onClick);
  btn.addEventListener('mousedown', e => e.stopPropagation());
  return btn;
}

function startRename(entry, item) {
  const nameSpan = entry.querySelector('.name');
  const oldName = item.name;
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = oldName;
  nameSpan.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    const restored = document.createElement('span');
    restored.className = 'name';
    restored.textContent = oldName;
    input.replaceWith(restored);
    if (!commit || !newName || newName === oldName) return;
    try {
      const res = await fetch('/api/rename', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.path, name: newName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.error || 'Rename failed');
        return;
      }
      const data = await res.json();
      // Update expanded set: replace old path with new
      if (expandedFolders.has(item.path)) {
        expandedFolders.delete(item.path);
        expandedFolders.add(data.path);
      }
      // Update currentNotePath if it was inside this folder
      if (currentNotePath && currentNotePath.startsWith(item.path + '/')) {
        setCurrentNote(data.path + currentNotePath.slice(item.path.length));
      }
      await loadTree();
    } catch (err) {
      alert(err.message);
    }
  };
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', e => e.stopPropagation());
}

// ---------------- Drag & drop ----------------

let dragSrcPath = null;

function setupDrag(entry, item) {
  entry.addEventListener('dragstart', e => {
    dragSrcPath = item.path;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.path);
    entry.classList.add('dragging');
  });
  entry.addEventListener('dragend', () => {
    dragSrcPath = null;
    entry.classList.remove('dragging');
    document.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
  });
}

function setupDropTarget(folderEntry, folderPath) {
  folderEntry.addEventListener('dragover', e => {
    if (!dragSrcPath || dragSrcPath === folderPath) return;
    if (folderPath.startsWith(dragSrcPath + '/')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    folderEntry.classList.add('drop-target');
  });
  folderEntry.addEventListener('dragleave', () => {
    folderEntry.classList.remove('drop-target');
  });
  folderEntry.addEventListener('drop', async e => {
    e.preventDefault();
    folderEntry.classList.remove('drop-target');
    if (!dragSrcPath || dragSrcPath === folderPath) return;
    await moveEntry(dragSrcPath, folderPath);
  });
}

function setupRootDropTarget() {
  treeEl.addEventListener('dragover', e => {
    if (!dragSrcPath) return;
    // Only highlight root if dragging over empty area, not over a child entry
    if (e.target !== treeEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    treeEl.classList.add('drop-target-root');
  });
  treeEl.addEventListener('dragleave', e => {
    if (e.target !== treeEl) return;
    treeEl.classList.remove('drop-target-root');
  });
  treeEl.addEventListener('drop', async e => {
    if (!dragSrcPath) return;
    if (e.target !== treeEl) return;
    e.preventDefault();
    treeEl.classList.remove('drop-target-root');
    await moveEntry(dragSrcPath, '');
  });
}

async function moveEntry(from, to) {
  // A save must not land after the move: it would write the note back at its old
  // path and leave a copy behind. This is the backstop for dragging a row, which
  // can start from a note being typed into; flushing renames the file, so the
  // note's own path is taken again afterwards.
  const movingCurrent = isCurrentNote(from);
  if (currentNotePath && (movingCurrent || currentNotePath.startsWith(from + '/'))) {
    await flushCurrentNote();
    if (movingCurrent) from = currentNotePath;
  }
  try {
    const res = await fetch('/api/move', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Move failed');
      return;
    }
    const data = await res.json();
    if (currentNotePath === from || (currentNotePath && currentNotePath.startsWith(from + '/'))) {
      setCurrentNote(data.path + currentNotePath.slice(from.length));
    }
    if (expandedFolders.has(from)) {
      expandedFolders.delete(from);
      expandedFolders.add(data.path);
    }
    if (to !== '') expandedFolders.add(to);
    await loadTree();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------- CRUD helpers ----------------

async function deleteEntry(item) {
  if (!confirm(`Delete ${item.name}?`)) return;
  const hitsCurrent = currentNotePath === item.path ||
      (item.type === 'folder' && currentNotePath && currentNotePath.startsWith(item.path + '/'));
  // A queued save is dropped before the request goes out, not after: it is up to
  // 800ms away and would otherwise write the note back once the file is gone.
  // Dropped rather than flushed, because flushing is what could rename the file
  // out from under the path this delete is aimed at.
  if (hitsCurrent) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await fetch('/api/entry?path=' + encodeURIComponent(item.path), { method: 'DELETE' });
  if (hitsCurrent) await closeNote();
  expandedFolders.delete(item.path);
  await loadTree();
}

/// The note on screen, deleted the same way its × in the tree deletes it, so the
/// confirm, the closing and the tree refresh stay in one place. currentNotePath
/// rather than the tree's copy of it: a save renames the file, and the tree can
/// be a moment behind.
function deleteCurrentNote() {
  if (!currentNotePath) return;
  return deleteEntry({
    type: 'note',
    name: currentNotePath.split('/').pop(),
    path: currentNotePath,
  });
}

/// `folder` can be a path that does not exist yet — the server makes every level
/// of it — which is what lets the folder picker replace creating folders by hand.
async function createNote(folder = '') {
  const res = await fetch('/api/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Create note failed');
    return;
  }
  const data = await res.json();
  // Reveal it: every folder along the way has to be open for the new note to be
  // visible in the tree, and the path may have just been created.
  let prefix = '';
  for (const part of data.path.split('/').slice(0, -1)) {
    prefix = prefix ? `${prefix}/${part}` : part;
    expandedFolders.add(prefix);
  }
  await loadTree();
  closeSidebar();
  await openNote(data.path, { focus: true });
}

// ---------------- Folder picker ----------------

function allFolderPaths(items = treeData, out = []) {
  for (const item of items) {
    if (item.type !== 'folder') continue;
    out.push(item.path);
    allFolderPaths(item.children, out);
  }
  return out;
}

async function promptCreateNote() {
  const folder = await PathPrompt.open({
    title: 'New note in…',
    value: contextFolder,
    folders: allFolderPaths(),
  });
  if (folder === null) return;
  await createNote(folder);
}

async function promptMove(item) {
  // The note on screen is written out before the dialog opens rather than after
  // it closes: it has usually just been typed into, and a rename arriving while
  // the dialog is up would leave the heading naming a file that is already gone.
  const current = isCurrentNote(item.path);
  if (current) {
    await flushCurrentNote();
    item = { ...item, path: currentNotePath, name: currentNotePath.split('/').pop() };
  }
  const name = item.type === 'note' ? item.name.replace(/\.md$/, '') : item.name;
  const dest = await PathPrompt.open({
    title: `Move ${name} to…`,
    value: parentOf(item.path),
    folders: allFolderPaths(),
    // The server refuses these too; ruling them out here keeps them off the list
    // instead of letting you pick one and be told no.
    validate: (dest) => {
      if (item.type !== 'folder') return null;
      if (dest === item.path || dest.startsWith(item.path + '/')) {
        return 'A folder cannot be moved inside itself';
      }
      return null;
    },
  });
  if (dest === null) return;
  // Taken again now the dialog is closed: nothing should have renamed the note in
  // the meantime, but currentNotePath is the one path that is never stale.
  await moveEntry(current ? currentNotePath : item.path, dest);
}

// ---------------- Note switcher ----------------

function allNotes(items = treeData, out = []) {
  for (const item of items) {
    if (item.type === 'folder') allNotes(item.children, out);
    else out.push(item);
  }
  return out;
}

async function promptSwitchNote() {
  // Written out and the tree reread before the list is built: the note on screen
  // has usually just been typed into, and its first line is its filename, so the
  // name in the list is otherwise the one it had when it was opened.
  await flushCurrentNote();
  await loadTree();
  const path = await NotePrompt.open({
    // Switching to the note you are on is a no-op, so it is not offered — which
    // also means the first row is always somewhere else to go.
    notes: allNotes().filter(note => note.path !== currentNotePath),
  });
  if (path === null) return;
  await openNote(path);
}

// ---------------- App shortcuts ----------------
//
// Mod-N and Mod-Shift-N are not available: browsers keep them for new window and
// new private window and will not let a page have them. Mod-Shift-M is Firefox's
// responsive design mode, which preventDefault does not get you out of either.
// Hence the Mod-Alt-* family, which is also where the editor's block chords live.
//
// Matched on event.code — the physical key — because Alt is part of every chord
// here and on a Mac Alt-N is a dead key, which arrives as event.key '˜'. The
// printed letter is checked as well, for layouts that move N somewhere else.

function isKey(e, code, letter) {
  return e.code === code || e.key.toLowerCase() === letter;
}

function setupAppShortcuts() {
  // Capture phase, so the chord is not swallowed by the editor's own keymap, and
  // never while a dialog is up — the folder picker's input is inside one.
  document.addEventListener('keydown', e => {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (document.querySelector('dialog[open]')) return;

    if (e.altKey && !e.shiftKey && isKey(e, 'KeyN', 'n')) {
      e.preventDefault();
      createNote(contextFolder);
    } else if (e.altKey && e.shiftKey && isKey(e, 'KeyN', 'n')) {
      e.preventDefault();
      promptCreateNote();
    } else if (e.altKey && !e.shiftKey && isKey(e, 'KeyM', 'm')) {
      if (!currentNotePath) return;
      e.preventDefault();
      promptMove({ type: 'note', name: currentNotePath.split('/').pop(), path: currentNotePath });
    } else if (e.altKey && !e.shiftKey && isKey(e, 'KeyO', 'o')) {
      e.preventDefault();
      promptSwitchNote();
    } else if (!e.altKey && e.shiftKey && e.key === 'Backspace') {
      // Backspace needs no isKey: it is in the same place on every layout, and
      // nothing is printed on it to match against.
      if (!currentNotePath) return;
      e.preventDefault();
      deleteCurrentNote();
    }
  }, true);
}

// ---------------- Keyboard shortcut help ----------------
//
// Everything below is only the help text — the bindings themselves come from
// src/commands.js, CodeMirror's history keymap and setupAppShortcuts above, so
// this table has to be kept in step with them by hand.

const SHORTCUT_GROUPS = [
  {
    title: 'Text',
    items: [
      { keys: ['Mod-B'], label: 'Bold' },
      { keys: ['Mod-I'], label: 'Italic' },
      { keys: ['Mod-E'], label: 'Inline code' },
      { keys: ['Mod-Shift-X', 'Mod-Alt-X'], label: 'Strikethrough' },
      { keys: ['Mod-K'], label: 'Link the selection' },
      { keys: ['Mod-Click'], label: 'Open a link' },
      { keys: ['Mod-Z'], label: 'Undo' },
      { keys: ['Mod-Shift-Z', 'Mod-Y'], label: 'Redo' },
    ],
  },
  {
    title: 'Blocks',
    items: [
      { keys: ['Mod-Alt-0'], label: 'Plain paragraph' },
      { keys: ['Mod-Alt-1', 'Mod-Alt-6'], sep: '…', label: 'Heading 1 to 6' },
      { keys: ['Mod-Alt-7'], label: 'Numbered list' },
      { keys: ['Mod-Alt-8'], label: 'Bullet list' },
      { keys: ['Mod-Shift-B'], label: 'Block quote' },
      { keys: ['Mod-Alt-C'], label: 'Code block' },
      { keys: ['Tab', 'Shift-Tab'], label: 'Indent / outdent list item' },
    ],
  },
  {
    title: 'Notes',
    items: [
      { keys: ['Mod-Alt-N'], label: 'New note in the current folder' },
      { keys: ['Mod-Alt-Shift-N'], label: 'New note in…' },
      { keys: ['Mod-Alt-O'], label: 'Switch to another note…' },
      { keys: ['Mod-Alt-M'], label: 'Move this note to…' },
      { keys: ['Mod-Shift-Backspace'], label: 'Delete this note' },
    ],
  },
  {
    title: 'App',
    items: [
      { keys: ['Mod-/'], label: 'Show this list' },
      { keys: ['Escape'], label: 'Close current dialog' },
    ],
  },
];

/// One table for every group — group titles are full-width rows inside it —
/// so that the key column is as wide as the widest chord and the descriptions
/// line up all the way down.
function renderShortcuts(body) {
  const table = document.createElement('table');
  table.className = 'shortcut-table';

  for (const group of SHORTCUT_GROUPS) {
    const heading = table.insertRow().insertCell();
    heading.className = 'shortcut-group';
    heading.colSpan = 2;
    heading.textContent = group.title;

    for (const item of group.items) {
      const row = table.insertRow();
      const keys = row.insertCell();
      keys.className = 'shortcut-keys';
      item.keys.forEach((chord, i) => {
        if (i > 0) {
          const sep = document.createElement('span');
          sep.className = 'shortcut-sep';
          sep.textContent = item.sep || '/';
          keys.appendChild(sep);
        }
        for (const key of chord.split('-')) {
          const kbd = document.createElement('kbd');
          kbd.textContent = KEY_LABELS[key] || key;
          keys.appendChild(kbd);
        }
      });
      row.insertCell().textContent = item.label;
    }
  }

  body.appendChild(table);
}

const shortcutsDialog = document.getElementById('shortcuts');

function setupShortcutHelp() {
  renderShortcuts(document.getElementById('shortcuts-body'));

  const open = () => { if (!shortcutsDialog.open) shortcutsDialog.showModal(); };
  const showBtn = document.getElementById('show-shortcuts');
  showBtn.title = `Keyboard shortcuts (${IS_MAC ? '⌘/' : 'Ctrl+/'})`;
  showBtn.addEventListener('click', open);
  document.getElementById('close-shortcuts').addEventListener('click', () => shortcutsDialog.close());
  // A click that lands on the dialog itself came down on the backdrop.
  shortcutsDialog.addEventListener('click', e => {
    if (e.target === shortcutsDialog) shortcutsDialog.close();
  });

  // Mod-/ works wherever the focus happens to be, note included: nothing in the
  // presets binds it, no browser reserves it, and a modifier chord can never be
  // text someone meant to type — which a bare ? can, so that is not offered as
  // an alias. Capture phase, because the link prompt's input stops keydown from
  // propagating to us.
  //
  // Shift is deliberately not part of the test. On layouts where / sits on a
  // shifted key — Norwegian and German put it on Shift-7 — the chord is
  // physically Mod-Shift-7, and the browser still reports event.key as '/'.
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    e.preventDefault();
    if (shortcutsDialog.open) shortcutsDialog.close();
    else open();
  }, true);
}

// ---------------- Sidebar drawer ----------------
//
// Below 720px (style.css) the sidebar is a drawer over the note, open while the
// body has .sidebar-open. On a wide screen the class does nothing, so none of
// this needs to know which layout is showing.

const NARROW = matchMedia('(max-width: 720px)');

function openSidebar() { document.body.classList.add('sidebar-open'); }
function closeSidebar() { document.body.classList.remove('sidebar-open'); }

document.getElementById('open-sidebar').addEventListener('click', openSidebar);
document.getElementById('sidebar-backdrop').addEventListener('click', closeSidebar);
document.getElementById('topbar-new-note').addEventListener('click', () => createNote(contextFolder));
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('sidebar-open') &&
      !document.querySelector('dialog[open]')) {
    closeSidebar();
  }
});

// ---------------- Wiring ----------------

// The button follows the context folder like the shortcut does; Alt-clicking it
// asks where to put the note instead, the same as adding Shift to the chord.
newNoteBtn.addEventListener('click', (e) => {
  if (e.altKey) promptCreateNote();
  else createNote(contextFolder);
});

setContextFolder('');
setupRootDropTarget();
setupAppShortcuts();
setupShortcutHelp();

window.addEventListener('beforeunload', () => {
  if (!currentNotePath || !NotesEditor.isLoaded()) return;
  clearTimeout(saveTimer);
  if (isDiscardable()) {
    discardRequest(currentNotePath, true);
    return;
  }
  const content = NotesEditor.getMarkdown();
  if (content === lastSavedContent) return;
  fetch('/api/note', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentNotePath, content }),
    keepalive: true,
  });
});

loadTree().then(openNoteFromUrl).then(() => {
  // With no note to show, a narrow screen would be an empty page with a menu
  // button; start with the list of notes instead.
  if (!currentNotePath && NARROW.matches) openSidebar();
});
