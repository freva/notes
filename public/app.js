// The editor itself lives in src/editor.js and is bundled to
// public/editor.bundle.js (`pnpm run build`), which exposes it as NotesEditor.
// This file owns the sidebar, the note tree and the save loop.

const editor = document.getElementById('editor');
const editorWrap = document.getElementById('editor-wrap');
const treeEl = document.getElementById('tree');

let currentNotePath = null;
let treeData = [];
let saveTimer = null;
let lastSavedContent = '';
const expandedFolders = new Set();

const LAST_NOTE_KEY = 'notes.lastNote';

NotesEditor.configure({ onChange: scheduleSave });

// ---------------- Current note ----------------

/// The one place currentNotePath is assigned: the window title and the
/// remembered note follow from it, and a note's path changes on more occasions
/// than you would think — a save can rename the file (the first line is the
/// filename), and so can renaming or moving a folder above it.
function setCurrentNote(path) {
  currentNotePath = path;
  const name = path ? path.split('/').pop().replace(/\.md$/, '') : null;
  document.title = name ? `${name} - Notes` : 'Notes';
  try {
    if (path) localStorage.setItem(LAST_NOTE_KEY, path);
    else localStorage.removeItem(LAST_NOTE_KEY);
  } catch (err) {
    // Storage can be unavailable (private mode, blocked cookies). Reopening
    // the last note is a convenience; the app works fine without it.
  }
}

/// Reopen whatever was open last time, if it is still there. The path can have
/// gone stale in the meantime — the note may have been deleted, or renamed by
/// an edit in another tab — so check against the tree instead of firing off a
/// request that 404s.
async function restoreLastNote() {
  let path = null;
  try {
    path = localStorage.getItem(LAST_NOTE_KEY);
  } catch (err) {
    return;
  }
  if (!path) return;
  if (!noteInTree(path)) {
    setCurrentNote(null);
    return;
  }
  await openNote(path);
}

function noteInTree(path, items = treeData) {
  return items.some(item =>
    item.type === 'folder' ? noteInTree(path, item.children) : item.path === path);
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
    if (data.path && data.path !== pathBeingSaved && currentNotePath === pathBeingSaved) {
      setCurrentNote(data.path);
    }
    await loadTree();
  } catch (err) {
    console.error('Save error:', err);
  }
}

async function openNote(path) {
  if (currentNotePath === path) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    await saveNote();
  }
  try {
    const res = await fetch('/api/note?path=' + encodeURIComponent(path));
    if (!res.ok) throw new Error('Failed to load note');
    const data = await res.json();
    setCurrentNote(path);

    // Milkdown normalises markdown on the way through, so the serialised form
    // of what we just loaded is rarely byte-identical to the file. Treat that
    // normalised form as the saved baseline, otherwise merely opening a note
    // would look like an edit and rewrite the file.
    const normalized = await NotesEditor.load(editor, data.content);
    if (normalized === null) return; // another openNote superseded this one
    lastSavedContent = normalized;

    editor.classList.add('visible');
    editorWrap.classList.add('has-note');
    await loadTree();
    NotesEditor.focus();
  } catch (err) {
    console.error(err);
  }
}

async function closeNote() {
  setCurrentNote(null);
  lastSavedContent = '';
  clearTimeout(saveTimer);
  saveTimer = null;
  await NotesEditor.unload(editor);
  editor.classList.remove('visible');
  editorWrap.classList.remove('has-note');
}

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
      const addFolderBtn = mkActionBtn('🗀', 'New subfolder', e => {
        e.stopPropagation();
        createFolder(item.path);
      });
      const renameBtn = mkActionBtn('✎', 'Rename', e => {
        e.stopPropagation();
        startRename(entry, item);
      });
      actions.append(addNoteBtn, addFolderBtn, renameBtn);
    }

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
      });
      setupDropTarget(entry, item.path);
    } else {
      icon.textContent = '·';
      entry.addEventListener('click', () => openNote(item.path));
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
  await fetch('/api/entry?path=' + encodeURIComponent(item.path), { method: 'DELETE' });
  if (currentNotePath === item.path ||
      (item.type === 'folder' && currentNotePath && currentNotePath.startsWith(item.path + '/'))) {
    await closeNote();
  }
  expandedFolders.delete(item.path);
  await loadTree();
}

async function createNote(folder = '') {
  const res = await fetch('/api/note', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder }),
  });
  const data = await res.json();
  if (folder) expandedFolders.add(folder);
  await loadTree();
  await openNote(data.path);
}

async function createFolder(parent = '') {
  const name = prompt('Folder name:');
  if (!name) return;
  const res = await fetch('/api/folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parent, name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Create folder failed');
    return;
  }
  if (parent) expandedFolders.add(parent);
  await loadTree();
}

// ---------------- Keyboard shortcut help ----------------
//
// Everything below is only the help text — the bindings themselves come from
// the presets CrepeBuilder registers (commonmark, gfm, history, indent) plus
// src/shortcuts.js, so this table has to be kept in step with them by hand.
//
// Chords are written the way ProseMirror writes them, with 'Mod' standing for
// Cmd on a Mac and Ctrl everywhere else, and are rendered per key.

const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

const KEY_LABELS = IS_MAC
  ? { Mod: '⌘', Alt: '⌥', Shift: '⇧' }
  : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };

const SHORTCUT_GROUPS = [
  {
    title: 'Text',
    items: [
      { keys: ['Mod-B'], label: 'Bold' },
      { keys: ['Mod-I'], label: 'Italic' },
      { keys: ['Mod-E'], label: 'Inline code' },
      { keys: ['Mod-Shift-X', 'Mod-Alt-X'], label: 'Strikethrough' },
      { keys: ['Mod-K'], label: 'Link the selection' },
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
    ],
  },
  {
    title: 'App',
    items: [
      { keys: ['Mod-/'], label: 'Show this list' },
      { keys: ['Escape'], label: 'Close this dialog, or cancel the link prompt' },
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

// ---------------- Wiring ----------------

// Links are inside a contenteditable, so a plain click just moves the caret.
editor.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a[href]');
  if (!a || !editor.contains(a)) return;
  e.preventDefault();
  window.open(a.getAttribute('href'), '_blank', 'noopener');
});

document.getElementById('new-note').addEventListener('click', () => createNote(''));
document.getElementById('new-folder').addEventListener('click', () => createFolder(''));

setupRootDropTarget();
setupShortcutHelp();

window.addEventListener('beforeunload', () => {
  if (!currentNotePath || !NotesEditor.isLoaded()) return;
  const content = NotesEditor.getMarkdown();
  if (content === lastSavedContent) return;
  clearTimeout(saveTimer);
  fetch('/api/note', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentNotePath, content }),
    keepalive: true,
  });
});

loadTree().then(restoreLastNote);
