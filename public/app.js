// The editor itself lives in src/editor.js and is bundled to
// public/editor.bundle.js (`pnpm run build`), which exposes it as NotesEditor.
// This file owns the sidebar, the note tree and the save loop.

const editor = document.getElementById('editor');
const editorWrap = document.getElementById('editor-wrap');
const treeEl = document.getElementById('tree');

let currentNotePath = null;
let saveTimer = null;
let lastSavedContent = '';
const expandedFolders = new Set();

NotesEditor.configure({ onChange: scheduleSave });

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
      currentNotePath = data.path;
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
    currentNotePath = path;

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
  currentNotePath = null;
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
  const tree = await res.json();
  treeEl.innerHTML = '';
  renderTreeLevel(tree, treeEl, '');
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
        currentNotePath = data.path + currentNotePath.slice(item.path.length);
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
      currentNotePath = data.path + currentNotePath.slice(from.length);
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

loadTree();
