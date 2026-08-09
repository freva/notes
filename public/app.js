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

// List items carry an indent level (data-indent, 0..MAX_INDENT) that round-trips
// to two leading spaces per level in the markdown. Checkbox items are a 'todo'
// block type storing their state in data-checked; the box itself is a
// contenteditable="false" span that holds no text, so it never affects
// textContent, character offsets, or the markdown round-trip.

const LIST_TYPES = new Set(['bullet', 'numbered', 'todo']);
const MAX_INDENT = 8;

function parseMarkdownLine(line) {
  const ws = line.match(/^[ \t]*/)[0];
  const indent = Math.min(MAX_INDENT, ws.replace(/\t/g, '  ').length >> 1);
  const rest = line.slice(ws.length);
  let m;
  if ((m = rest.match(/^(#{1,6})\s+(.*)$/))) return { type: 'h' + m[1].length, text: m[2] };
  if ((m = rest.match(/^[-*+]\s+\[([ xX])\]\s?(.*)$/)))
    return { type: 'todo', text: m[2], indent, checked: m[1] !== ' ' };
  if ((m = rest.match(/^[-*+]\s+(.*)$/))) return { type: 'bullet', text: m[1], indent };
  if ((m = rest.match(/^(\d+)\.\s+(.*)$/))) return { type: 'numbered', text: m[2], num: m[1], indent };
  if ((m = rest.match(/^>\s?(.*)$/))) return { type: 'quote', text: m[1] };
  if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim()) && line.trim().length > 0) return { type: 'hr', text: '' };
  return { type: 'paragraph', text: line };
}

function lineToMarkdown(div) {
  const type = div.dataset.type || 'paragraph';
  const text = div.textContent || '';
  const pad = '  '.repeat(getIndent(div));
  if (type === 'hr') return '---';
  if (type === 'numbered') return `${pad}${div.dataset.num || '1'}. ${text}`;
  const m = type.match(/^h([1-6])$/);
  if (m) return '#'.repeat(parseInt(m[1])) + ' ' + text;
  if (type === 'todo') return `${pad}- [${div.dataset.checked === 'true' ? 'x' : ' '}] ${text}`;
  if (type === 'bullet') return `${pad}- ${text}`;
  if (type === 'quote') return `> ${text}`;
  return text;
}

function checkboxHtml(checked) {
  return `<span class="checkbox" contenteditable="false" role="checkbox" aria-checked="${checked}"></span>`;
}

// Renders the line body (checkbox marker + decorated inline markdown) without
// touching the caret. Callers that need to keep the caret use redecorateLine.
function renderLine(line, text) {
  if (line.dataset.type === 'hr') {
    line.innerHTML = '<hr>';
    return;
  }
  const body = decorateInline(text);
  line.innerHTML =
    line.dataset.type === 'todo' ? checkboxHtml(line.dataset.checked === 'true') + body : body;
}

function createBlock(type, text, attrs = {}) {
  const div = document.createElement('div');
  div.className = 'line';
  setLineType(div, type, attrs);
  setIndent(div, attrs.indent || 0);
  renderLine(div, text);
  return div;
}

function setLineType(line, type, attrs = {}) {
  line.dataset.type = type;
  if (type === 'numbered') line.dataset.num = attrs.num || '1';
  else delete line.dataset.num;
  if (type === 'todo') line.dataset.checked = attrs.checked ? 'true' : 'false';
  else delete line.dataset.checked;
  if (!LIST_TYPES.has(type)) setIndent(line, 0);
}

function getIndent(line) {
  return parseInt(line.dataset.indent || '0', 10) || 0;
}

function setIndent(line, level) {
  const v = Math.max(0, Math.min(MAX_INDENT, level));
  if (v === 0) {
    delete line.dataset.indent;
    line.style.removeProperty('--indent');
  } else {
    line.dataset.indent = String(v);
    line.style.setProperty('--indent', String(v));
  }
}

function renumberLists() {
  const counters = [];
  for (const div of editor.children) {
    const type = div.dataset && div.dataset.type;
    if (type === 'numbered') {
      const level = getIndent(div);
      counters.length = level + 1;
      counters[level] = (counters[level] || 0) + 1;
      div.dataset.num = String(counters[level]);
    } else if (LIST_TYPES.has(type)) {
      // A bullet/todo breaks numbering at its own level and deeper, but a
      // nested one leaves the enclosing numbered list's count alone.
      counters.length = Math.min(counters.length, getIndent(div));
    } else {
      counters.length = 0;
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
      const parsed = parseMarkdownLine(line);
      editor.appendChild(createBlock(parsed.type, parsed.text, parsed));
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
    placeCaretAtStart(line);
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
  renderLine(line, text);
  if (offset !== null) setCharOffset(line, offset);
}

const TYPE_TRIGGERS = [
  { re: /^(#{1,6})\s/, toType: m => 'h' + m[1].length },
  { re: /^[-*+]\s/, toType: () => 'bullet' },
  { re: /^(\d+)\.\s/, toType: () => 'numbered' },
  { re: /^>\s/, toType: () => 'quote' },
];

// "[]" (also "[ ]" / "[x]") at the start of a line turns it into a checkbox.
// The lookahead keeps a leading link like [x](url) from being swallowed.
const CHECKBOX_TRIGGER = /^\[([ xX]?)\](?!\()\s?/;

function maybeConvertType(line) {
  const type = line.dataset.type;
  const text = line.textContent;

  if (type === 'paragraph' || LIST_TYPES.has(type)) {
    const m = text.match(CHECKBOX_TRIGGER);
    if (m && type !== 'todo') {
      const indent = getIndent(line);
      setLineType(line, 'todo', { checked: m[1] === 'x' || m[1] === 'X' });
      setIndent(line, indent);
      renderLine(line, text.slice(m[0].length));
      placeCaretAtStart(line);
      renumberLists();
      return true;
    }
  }

  if (type !== 'paragraph') return false;
  for (const trig of TYPE_TRIGGERS) {
    const m = text.match(trig.re);
    if (m) {
      const remaining = text.slice(m[0].length);
      setLineType(line, trig.toType(m));
      renderLine(line, remaining);
      placeCaretAtStart(line);
      renumberLists();
      return true;
    }
  }
  return false;
}

// ---------------- Indenting ----------------

// A list item may sit at most one level deeper than the item above it, so the
// markdown never contains an indent jump that would re-parse differently.
function maxIndentFor(line) {
  const prev = line.previousElementSibling;
  if (!prev || !prev.dataset || !LIST_TYPES.has(prev.dataset.type)) return 0;
  return Math.min(MAX_INDENT, getIndent(prev) + 1);
}

// Contiguous following items nested under `line` — they move with their parent.
function childrenOf(line) {
  const base = getIndent(line);
  const kids = [];
  let cur = line.nextElementSibling;
  while (cur && cur.dataset && LIST_TYPES.has(cur.dataset.type) && getIndent(cur) > base) {
    kids.push(cur);
    cur = cur.nextElementSibling;
  }
  return kids;
}

function selectedLines() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return [];
  const range = sel.getRangeAt(0);
  const start = findLineDiv(range.startContainer);
  const end = findLineDiv(range.endContainer);
  if (!start) return [];
  if (!end || start === end) return [start];
  const lines = [];
  let cur = start;
  while (cur) {
    lines.push(cur);
    if (cur === end) break;
    cur = cur.nextElementSibling;
  }
  return lines;
}

function indentLines(lines, delta) {
  let changed = false;
  for (const line of lines) {
    if (!line.dataset || !LIST_TYPES.has(line.dataset.type)) continue;
    const from = getIndent(line);
    const to =
      delta > 0 ? Math.min(from + 1, maxIndentFor(line)) : Math.max(0, from - 1);
    if (to === from) continue;
    // Single-item indent drags its nested children along; when several lines are
    // selected the children are part of the selection already.
    const kids = lines.length === 1 ? childrenOf(line) : [];
    setIndent(line, to);
    for (const kid of kids) setIndent(kid, getIndent(kid) + (to - from));
    changed = true;
  }
  return changed;
}

// "Start of the line" means the start of its text — the checkbox marker is not
// editable, so the caret belongs after it rather than wedged in front of it.
function placeCaretAtStart(line) {
  const range = document.createRange();
  const box = line.firstElementChild;
  if (box && box.classList.contains('checkbox')) {
    const next = box.nextSibling;
    if (next && next.nodeType === 3) range.setStart(next, 0);
    else range.setStartAfter(box);
  } else {
    range.selectNodeContents(line);
  }
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

    // Empty list/quote item: pop out one indent level, then exit to paragraph
    if ((LIST_TYPES.has(type) || type === 'quote') && fullText === '') {
      if (getIndent(line) > 0) {
        setIndent(line, getIndent(line) - 1);
      } else {
        setLineType(line, 'paragraph');
        renderLine(line, '');
        placeCaretAtStart(line);
      }
      renumberLists();
      scheduleSave();
      return;
    }

    renderLine(line, before);
    const newType = LIST_TYPES.has(type) || type === 'quote' ? type : 'paragraph';
    const newBlock = createBlock(newType, after, { indent: getIndent(line) });
    line.after(newBlock);
    placeCaretAtStart(newBlock);
    renumberLists();
    scheduleSave();
    return;
  }

  if (e.key === 'Tab' && !e.isComposing) {
    const lines = selectedLines();
    if (lines.length === 0) return;
    e.preventDefault();
    if (indentLines(lines, e.shiftKey ? -1 : 1)) {
      renumberLists();
      scheduleSave();
    }
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
    if (getIndent(line) > 0) {
      const from = getIndent(line);
      const kids = childrenOf(line);
      setIndent(line, from - 1);
      for (const kid of kids) setIndent(kid, getIndent(kid) - 1);
      renumberLists();
      scheduleSave();
      return;
    }
    if (line.dataset.type !== 'paragraph') {
      const text = line.textContent;
      setLineType(line, 'paragraph');
      renderLine(line, text);
      placeCaretAtStart(line);
      renumberLists();
      scheduleSave();
      return;
    }
    const prev = line.previousElementSibling;
    if (!prev) return;
    const prevText = prev.textContent;
    const myText = line.textContent;
    renderLine(prev, prevText + myText);
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

// mousedown (not click) so toggling a checkbox never moves the caret.
editor.addEventListener('mousedown', (e) => {
  const box = e.target.closest && e.target.closest('.checkbox');
  if (!box || !editor.contains(box)) return;
  const line = findLineDiv(box);
  if (!line) return;
  e.preventDefault();
  const checked = line.dataset.checked !== 'true';
  line.dataset.checked = checked ? 'true' : 'false';
  box.setAttribute('aria-checked', String(checked));
  scheduleSave();
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
