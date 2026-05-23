const editor = document.getElementById('editor');
const editorWrap = document.getElementById('editor-wrap');
const treeEl = document.getElementById('tree');

let currentNotePath = null;
let saveTimer = null;
let lastSavedContent = '';
let isSwitchingNote = false;
const expandedFolders = new Set();

// ---------------- Markdown <-> Block model ----------------
//
// Each line of markdown becomes a <div class="line" data-type="..."> in the editor.
// The block-level prefix (#, -, *, 1., >, ---) is NOT stored in textContent —
// only its block type. CSS renders the block style from the type.
//
// Inline markdown (**bold**, *italic*, etc.) is decorated with <span class="md-syntax">
// elements that wrap the syntax chars. The chars stay in textContent so the DOM
// round-trips back to raw markdown losslessly. The syntax spans are styled muted
// in CSS so the rendered content (bold/italic/code) reads as the primary visual.

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decorateInline(text) {
  if (text === '') return '<br>';
  let html = escapeHtml(text);
  html = html.replace(/`([^`\n]+)`/g, '<span class="md-syntax">`</span><code>$1</code><span class="md-syntax">`</span>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<span class="md-syntax">**</span><strong>$1</strong><span class="md-syntax">**</span>');
  html = html.replace(/__([^_\n]+)__/g, '<span class="md-syntax">__</span><strong>$1</strong><span class="md-syntax">__</span>');
  html = html.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<span class="md-syntax">*</span><em>$2</em><span class="md-syntax">*</span>');
  html = html.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1<span class="md-syntax">_</span><em>$2</em><span class="md-syntax">_</span>');
  html = html.replace(/~~([^~\n]+)~~/g, '<span class="md-syntax">~~</span><del>$1</del><span class="md-syntax">~~</span>');
  html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g,
    '<span class="md-syntax">[</span><a href="$2" target="_blank" rel="noopener">$1</a><span class="md-syntax">](' + '$2' + ')</span>');
  return html;
}

function parseMarkdownLine(line) {
  let m;
  if ((m = line.match(/^(#{1,6})\s+(.*)$/))) return { type: 'h' + m[1].length, text: m[2] };
  if ((m = line.match(/^[-*+]\s+(.*)$/))) return { type: 'bullet', text: m[1] };
  if ((m = line.match(/^(\d+)\.\s+(.*)$/))) return { type: 'numbered', text: m[2], num: m[1] };
  if ((m = line.match(/^>\s?(.*)$/))) return { type: 'quote', text: m[1] };
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim()) && line.trim().length > 0) return { type: 'hr', text: '' };
  return { type: 'paragraph', text: line };
}

function lineToMarkdown(div) {
  const type = div.dataset.type || 'paragraph';
  const text = div.textContent || '';
  if (type === 'hr') return '---';
  if (type === 'numbered') return `${div.dataset.num || '1'}. ${text}`;
  const m = type.match(/^h([1-6])$/);
  if (m) return '#'.repeat(parseInt(m[1])) + ' ' + text;
  if (type === 'bullet') return `- ${text}`;
  if (type === 'quote') return `> ${text}`;
  return text;
}

function createBlock(type, text, num) {
  const div = document.createElement('div');
  div.className = 'line';
  div.dataset.type = type;
  if (num) div.dataset.num = num;
  if (type === 'hr') {
    div.innerHTML = '<hr>';
  } else {
    div.innerHTML = decorateInline(text);
  }
  return div;
}

function renumberLists() {
  let counter = 0;
  for (const div of editor.children) {
    if (div.dataset && div.dataset.type === 'numbered') {
      counter++;
      div.dataset.num = String(counter);
    } else {
      counter = 0;
    }
  }
}

function setEditorContent(markdown) {
  editor.innerHTML = '';
  const lines = markdown.split('\n');
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
    editor.appendChild(createBlock('paragraph', ''));
  } else {
    for (const line of lines) {
      const { type, text, num } = parseMarkdownLine(line);
      editor.appendChild(createBlock(type, text, num));
    }
  }
  renumberLists();
}

function getEditorContent() {
  return Array.from(editor.children)
    .filter(d => d.classList && d.classList.contains('line'))
    .map(lineToMarkdown)
    .join('\n');
}

// ---------------- Cursor utilities ----------------

function getCharOffset(line) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!line.contains(range.startContainer) && range.startContainer !== line) return null;
  if (range.startContainer === line) {
    let acc = 0;
    for (let i = 0; i < range.startOffset; i++) {
      const c = line.childNodes[i];
      if (c) acc += (c.textContent || '').length;
    }
    return acc;
  }
  let offset = 0;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node === range.startContainer) return offset + range.startOffset;
    offset += node.textContent.length;
  }
  return null;
}

function setCharOffset(line, charOffset) {
  if (line.textContent === '') {
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
  let acc = 0;
  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const len = node.textContent.length;
    if (acc + len >= charOffset) {
      const range = document.createRange();
      range.setStart(node, Math.max(0, charOffset - acc));
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    acc += len;
  }
  const range = document.createRange();
  range.selectNodeContents(line);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function findLineDiv(node) {
  let cur = node;
  while (cur && cur !== editor) {
    if (cur.nodeType === 1 && cur.classList && cur.classList.contains('line')) return cur;
    cur = cur.parentNode;
  }
  return null;
}

// ---------------- Editing logic ----------------

function redecorateLine(line) {
  if (line.dataset.type === 'hr') {
    line.innerHTML = '<hr>';
    return;
  }
  const text = line.textContent;
  const offset = getCharOffset(line);
  line.innerHTML = decorateInline(text);
  if (offset !== null) setCharOffset(line, offset);
}

const TYPE_TRIGGERS = [
  { re: /^(#{1,6})\s/, toType: m => 'h' + m[1].length },
  { re: /^[-*+]\s/, toType: () => 'bullet' },
  { re: /^(\d+)\.\s/, toType: () => 'numbered' },
  { re: /^>\s/, toType: () => 'quote' },
];

function maybeConvertType(line) {
  if (line.dataset.type !== 'paragraph') return false;
  const text = line.textContent;
  for (const trig of TYPE_TRIGGERS) {
    const m = text.match(trig.re);
    if (m) {
      const newType = trig.toType(m);
      const remaining = text.slice(m[0].length);
      line.dataset.type = newType;
      line.innerHTML = decorateInline(remaining);
      placeCaretAtStart(line);
      renumberLists();
      return true;
    }
  }
  return false;
}

function placeCaretAtStart(line) {
  const range = document.createRange();
  range.selectNodeContents(line);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function placeCaretAtEnd(line) {
  const range = document.createRange();
  range.selectNodeContents(line);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function ensureLineStructure() {
  if (!editor.firstChild) {
    editor.appendChild(createBlock('paragraph', ''));
    placeCaretAtStart(editor.firstChild);
    return;
  }
  for (const child of Array.from(editor.children)) {
    if (child.nodeType !== 1 || !child.classList.contains('line')) {
      const wrap = createBlock('paragraph', child.textContent || '');
      child.replaceWith(wrap);
    }
  }
}

function handleInput() {
  ensureLineStructure();
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const line = findLineDiv(sel.getRangeAt(0).startContainer);
    if (line) {
      if (!maybeConvertType(line)) {
        redecorateLine(line);
      }
    }
  }
  scheduleSave();
}

function handleKeyDown(e) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const line = findLineDiv(range.startContainer);
    if (!line) return;
    e.preventDefault();
    if (!range.collapsed) range.deleteContents();
    const offset = getCharOffset(line) || 0;
    const fullText = line.textContent;
    const before = fullText.slice(0, offset);
    const after = fullText.slice(offset);
    const type = line.dataset.type;

    // Empty list/quote item: exit to paragraph instead of creating another
    if ((type === 'bullet' || type === 'numbered' || type === 'quote') && fullText === '') {
      line.dataset.type = 'paragraph';
      delete line.dataset.num;
      renumberLists();
      scheduleSave();
      return;
    }

    line.innerHTML = decorateInline(before);
    const newType =
      type === 'bullet' || type === 'numbered' || type === 'quote' ? type : 'paragraph';
    const newBlock = createBlock(newType, after);
    line.after(newBlock);
    placeCaretAtStart(newBlock);
    renumberLists();
    scheduleSave();
    return;
  }

  if (e.key === 'Backspace' && !e.isComposing) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return;
    const line = findLineDiv(range.startContainer);
    if (!line) return;
    const offset = getCharOffset(line);
    if (offset !== 0) return;
    e.preventDefault();
    if (line.dataset.type !== 'paragraph') {
      line.dataset.type = 'paragraph';
      delete line.dataset.num;
      renumberLists();
      scheduleSave();
      return;
    }
    const prev = line.previousElementSibling;
    if (!prev) return;
    const prevText = prev.textContent;
    const myText = line.textContent;
    prev.innerHTML = decorateInline(prevText + myText);
    setCharOffset(prev, prevText.length);
    line.remove();
    renumberLists();
    scheduleSave();
    return;
  }
}

// ---------------- Save & load ----------------

function scheduleSave() {
  if (!currentNotePath) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNote, 800);
}

async function saveNote() {
  if (!currentNotePath) return;
  const content = getEditorContent();
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
  isSwitchingNote = true;
  try {
    const res = await fetch('/api/note?path=' + encodeURIComponent(path));
    if (!res.ok) throw new Error('Failed to load note');
    const data = await res.json();
    currentNotePath = path;
    lastSavedContent = data.content;
    setEditorContent(data.content);
    editor.classList.add('visible');
    editorWrap.classList.add('has-note');
    await loadTree();
    editor.focus();
    if (editor.firstChild) placeCaretAtEnd(editor.firstChild);
  } catch (err) {
    console.error(err);
  } finally {
    isSwitchingNote = false;
  }
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
    currentNotePath = null;
    lastSavedContent = '';
    editor.innerHTML = '';
    editor.classList.remove('visible');
    editorWrap.classList.remove('has-note');
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

editor.addEventListener('input', handleInput);
editor.addEventListener('keydown', handleKeyDown);
editor.addEventListener('blur', () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveNote();
  }
  const active = editor.querySelector('.line.active');
  if (active) active.classList.remove('active');
});

document.addEventListener('selectionchange', () => {
  if (isSwitchingNote) return;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (!editor.contains(range.startContainer)) return;
  const line = findLineDiv(range.startContainer);
  const prev = editor.querySelector('.line.active');
  if (prev && prev !== line) prev.classList.remove('active');
  if (line && !line.classList.contains('active')) line.classList.add('active');
});

editor.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a');
  if (a && editor.contains(a)) {
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href) window.open(href, '_blank', 'noopener');
  }
});

editorWrap.addEventListener('mousedown', (e) => {
  if (!currentNotePath) return;
  if (editor.contains(e.target)) return;
  e.preventDefault();
  editor.focus();
  const lines = Array.from(editor.children).filter(c => c.classList && c.classList.contains('line'));
  if (lines.length === 0) return;
  const y = e.clientY;
  const x = e.clientX;
  const firstRect = lines[0].getBoundingClientRect();
  const lastRect = lines[lines.length - 1].getBoundingClientRect();
  if (y < firstRect.top) { placeCaretAtStart(lines[0]); return; }
  if (y > lastRect.bottom) { placeCaretAtEnd(lines[lines.length - 1]); return; }
  let target = lines.find(l => {
    const r = l.getBoundingClientRect();
    return y >= r.top && y <= r.bottom;
  });
  if (!target) target = lines.find(l => l.getBoundingClientRect().top > y) || lines[lines.length - 1];
  const r = target.getBoundingClientRect();
  if (x < r.left) placeCaretAtStart(target);
  else placeCaretAtEnd(target);
});

document.getElementById('new-note').addEventListener('click', () => createNote(''));
document.getElementById('new-folder').addEventListener('click', () => createFolder(''));

setupRootDropTarget();

window.addEventListener('beforeunload', () => {
  if (!currentNotePath) return;
  const content = getEditorContent();
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
