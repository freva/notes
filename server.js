const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const NOTES_DIR = path.resolve(process.env.NOTES_DIR || './notes');
const PORT = process.env.PORT || 3000;

// public/editor.bundle.js is built from src/ and deliberately not in git.
// `pnpm start` rebuilds it first; this only catches someone running the server
// directly, which would otherwise serve a page whose editor 404s.
if (!require('fs').existsSync(path.join(__dirname, 'public', 'editor.bundle.js'))) {
  console.error('public/editor.bundle.js is missing. Use `pnpm start`, or run `pnpm run build` first.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function resolveSafe(relPath) {
  const normalized = path.normalize(relPath || '').replace(/^[/\\]+/, '');
  const abs = path.resolve(NOTES_DIR, normalized);
  if (abs !== NOTES_DIR && !abs.startsWith(NOTES_DIR + path.sep)) {
    throw new Error('Path escapes notes directory');
  }
  return abs;
}

async function buildTree(dir, relBase = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const result = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.push({
        type: 'folder',
        name: entry.name,
        path: rel,
        children: await buildTree(path.join(dir, entry.name), rel),
      });
    } else if (entry.name.endsWith('.md')) {
      result.push({ type: 'note', name: entry.name, path: rel });
    }
  }
  return result;
}

app.get('/api/tree', async (req, res) => {
  try {
    await fs.mkdir(NOTES_DIR, { recursive: true });
    const tree = await buildTree(NOTES_DIR);
    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/note', async (req, res) => {
  try {
    const abs = resolveSafe(req.query.path);
    const content = await fs.readFile(abs, 'utf8');
    res.json({ content });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

function cleanName(name) {
  return name
    .replace(/^#+\s*/, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function sanitizeFilename(name) {
  return cleanName(name) || 'Untitled';
}

/// A folder path as the client's folder picker sends it: typed by hand, and
/// quite possibly pointing at folders that do not exist yet. Every segment is
/// cleaned like a filename, and empty segments simply disappear — '' is the
/// notes root, which is a valid destination.
function sanitizeRelPath(input) {
  return String(input || '')
    .split('/')
    .filter(seg => seg.trim() !== '.' && seg.trim() !== '..')
    .map(cleanName)
    .filter(Boolean)
    .join('/');
}

/// The folder a note is about to land in, brought into existence a level at a
/// time. Typing a path in the folder picker is the only way to make a folder,
/// so every folder in the tree was created here.
async function ensureFolder(relPath) {
  const abs = resolveSafe(relPath);
  try {
    await fs.mkdir(abs, { recursive: true });
  } catch (err) {
    // mkdir is happy with a folder that already exists, so getting here means a
    // segment of the path is an existing file — a bad request, not a fault.
    throw Object.assign(new Error(`Cannot use "${relPath}" as a folder`), { status: 400 });
  }
  return abs;
}

async function uniquePath(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  let i = 2;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${base} (${i})${ext}`);
      i++;
    } catch {
      return candidate;
    }
  }
}

app.put('/api/note', async (req, res) => {
  try {
    const { path: relPath, content } = req.body;
    if (typeof relPath !== 'string' || typeof content !== 'string') {
      return res.status(400).json({ error: 'path and content required' });
    }
    const abs = resolveSafe(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');

    const firstLine = content.split('\n')[0] || '';
    const desiredName = sanitizeFilename(firstLine);
    const currentName = path.basename(abs, '.md');
    let finalPath = relPath;
    if (desiredName && desiredName !== currentName) {
      const newAbs = await uniquePath(path.dirname(abs), desiredName, '.md');
      await fs.rename(abs, newAbs);
      finalPath = path.relative(NOTES_DIR, newAbs).split(path.sep).join('/');
    }
    res.json({ path: finalPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/note', async (req, res) => {
  try {
    const { folder } = req.body || {};
    const abs = await ensureFolder(sanitizeRelPath(folder));
    const newAbs = await uniquePath(abs, 'Untitled', '.md');
    await fs.writeFile(newAbs, '', 'utf8');
    const relPath = path.relative(NOTES_DIR, newAbs).split(path.sep).join('/');
    res.json({ path: relPath });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/// Throwing away a note that never became one. A new note is a file on disk
/// before it has a name or a word in it, so the client asks for this as soon as
/// you navigate away from an untouched one. Both conditions are checked here and
/// not just in the client, so that a stale path cannot delete real writing.
app.delete('/api/note', async (req, res) => {
  try {
    const abs = resolveSafe(req.query.path);
    if (!/^Untitled( \(\d+\))?\.md$/.test(path.basename(abs))) {
      return res.status(400).json({ error: 'Only an unnamed note can be discarded' });
    }
    const content = await fs.readFile(abs, 'utf8');
    if (content.trim() !== '') {
      return res.status(409).json({ error: 'Note is not empty' });
    }
    await fs.unlink(abs);
    res.json({ discarded: true });
  } catch (err) {
    // Already gone (two tabs, a double navigation) is the outcome we wanted.
    if (err.code === 'ENOENT') return res.json({ discarded: false });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/rename', async (req, res) => {
  try {
    const { path: relPath, name } = req.body || {};
    if (!relPath || !name) return res.status(400).json({ error: 'path and name required' });
    const abs = resolveSafe(relPath);
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Only folders can be renamed; notes rename via their first line' });
    const parent = path.dirname(abs);
    const cleanName = sanitizeFilename(name);
    const target = path.join(parent, cleanName);
    if (target === abs) return res.json({ path: relPath });
    try {
      await fs.access(target);
      return res.status(409).json({ error: 'A folder with this name already exists' });
    } catch {}
    await fs.rename(abs, target);
    const newPath = path.relative(NOTES_DIR, target).split(path.sep).join('/');
    res.json({ path: newPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/move', async (req, res) => {
  try {
    const { from, to } = req.body || {};
    if (typeof from !== 'string' || typeof to !== 'string') {
      return res.status(400).json({ error: 'from and to required' });
    }
    const srcAbs = resolveSafe(from);
    if (srcAbs === NOTES_DIR) return res.status(400).json({ error: 'Cannot move root' });
    // The destination is checked before it is created, so that a typo cannot
    // leave a folder behind on a move that was going to be refused anyway.
    const dstFolderAbs = resolveSafe(sanitizeRelPath(to));
    if (dstFolderAbs === srcAbs || dstFolderAbs.startsWith(srcAbs + path.sep)) {
      return res.status(400).json({ error: 'Cannot move a folder into itself' });
    }
    await ensureFolder(sanitizeRelPath(to));
    const name = path.basename(srcAbs);
    const target = path.join(dstFolderAbs, name);
    if (target === srcAbs) return res.json({ path: from });
    try {
      await fs.access(target);
      return res.status(409).json({ error: 'An entry with this name already exists in the destination' });
    } catch {}
    await fs.rename(srcAbs, target);
    const newPath = path.relative(NOTES_DIR, target).split(path.sep).join('/');
    res.json({ path: newPath });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.delete('/api/entry', async (req, res) => {
  try {
    const abs = resolveSafe(req.query.path);
    if (abs === NOTES_DIR) throw new Error('Cannot delete root');
    await fs.rm(abs, { recursive: true, force: true });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Notes app running at http://localhost:${PORT}`);
  console.log(`Notes directory: ${NOTES_DIR}`);
});
