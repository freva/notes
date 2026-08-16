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

function sanitizeFilename(name) {
  return name
    .replace(/^#+\s*/, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'Untitled';
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
    const abs = resolveSafe(folder || '');
    await fs.mkdir(abs, { recursive: true });
    const newAbs = await uniquePath(abs, 'Untitled', '.md');
    await fs.writeFile(newAbs, '', 'utf8');
    const relPath = path.relative(NOTES_DIR, newAbs).split(path.sep).join('/');
    res.json({ path: relPath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/folder', async (req, res) => {
  try {
    const { parent, name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const cleanName = sanitizeFilename(name);
    const parentAbs = resolveSafe(parent || '');
    let target = path.join(parentAbs, cleanName);
    let i = 2;
    while (true) {
      try {
        await fs.access(target);
        target = path.join(parentAbs, `${cleanName} (${i})`);
        i++;
      } catch {
        break;
      }
    }
    await fs.mkdir(target, { recursive: true });
    const relPath = path.relative(NOTES_DIR, target).split(path.sep).join('/');
    res.json({ path: relPath });
  } catch (err) {
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
    const dstFolderAbs = resolveSafe(to);
    if (to !== '') {
      const dstStat = await fs.stat(dstFolderAbs);
      if (!dstStat.isDirectory()) return res.status(400).json({ error: 'Destination must be a folder' });
    }
    if (dstFolderAbs === srcAbs || dstFolderAbs.startsWith(srcAbs + path.sep)) {
      return res.status(400).json({ error: 'Cannot move a folder into itself' });
    }
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
    res.status(500).json({ error: err.message });
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
