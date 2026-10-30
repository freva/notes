package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

// public/editor.bundle.js is built from src/ and deliberately not in git, so it
// must be built (`pnpm run build`) before `go build` for it to be embedded.
//
//go:embed public
var embedded embed.FS

var (
	notesDir string
	// All note access goes through root, which refuses any path (.. or symlink)
	// that would land outside the notes directory.
	root *os.Root
)

func main() {
	notesDir = envOr("NOTES_DIR", "./notes")
	port := envOr("PORT", "3000")

	public, err := fs.Sub(embedded, "public")
	if err != nil {
		log.Fatal(err)
	}
	if _, err := fs.Stat(public, "editor.bundle.js"); err != nil {
		log.Fatal("public/editor.bundle.js is missing. Run `pnpm run build` before `go build`.")
	}

	if err := os.MkdirAll(notesDir, 0o777); err != nil {
		log.Fatal(err)
	}
	if root, err = os.OpenRoot(notesDir); err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", staticHandler(public))

	// The open note is in the URL as /n/<path to the note>, so a reload or a pasted
	// link lands on the same note. The client reads the path back out; here every
	// such URL is simply the app. The /n/ prefix keeps note paths clear of /api and
	// of the files in public/ — a note called app.js must not shadow the script.
	index, err := fs.ReadFile(public, "index.html")
	if err != nil {
		log.Fatal(err)
	}
	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(index)
	}
	mux.HandleFunc("GET /n", serveIndex)
	mux.HandleFunc("GET /n/", serveIndex)

	mux.HandleFunc("GET /api/tree", handleTree)
	mux.HandleFunc("GET /api/note", handleGetNote)
	mux.HandleFunc("PUT /api/note", handlePutNote)
	mux.HandleFunc("POST /api/note", handleCreateNote)
	mux.HandleFunc("DELETE /api/note", handleDiscardNote)
	mux.HandleFunc("PUT /api/rename", handleRename)
	mux.HandleFunc("PUT /api/move", handleMove)
	mux.HandleFunc("DELETE /api/entry", handleDeleteEntry)

	log.Printf("Notes app running at http://localhost:%s", port)
	log.Printf("Notes directory: %s", notesDir)
	log.Fatal(http.ListenAndServe(":"+port, mux))
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// staticHandler serves public/ with an ETag per file. Embedded files have no
// modification time, so without one every page load would refetch the editor bundle.
func staticHandler(public fs.FS) http.Handler {
	etags := map[string]string{}
	fs.WalkDir(public, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := fs.ReadFile(public, p)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		etags["/"+p] = `"` + hex.EncodeToString(sum[:8]) + `"`
		return nil
	})
	etags["/"] = etags["/index.html"]

	files := http.FileServerFS(public)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if etag, ok := etags[r.URL.Path]; ok {
			w.Header().Set("ETag", etag)
			w.Header().Set("Cache-Control", "public, max-age=0")
		}
		files.ServeHTTP(w, r)
	})
}

// httpError carries the status a failure should be answered with; any other
// error is a 500.
type httpError struct {
	status int
	msg    string
}

func (e *httpError) Error() string { return e.msg }

func badRequest(msg string) error { return &httpError{http.StatusBadRequest, msg} }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error, status int) {
	var he *httpError
	if errors.As(err, &he) {
		status = he.status
	}
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

// readBody decodes the JSON request body into a map, so that handlers can check
// field types themselves the way the client may get them wrong.
func readBody(w http.ResponseWriter, r *http.Request) map[string]any {
	body := map[string]any{}
	json.NewDecoder(http.MaxBytesReader(w, r.Body, 10<<20)).Decode(&body)
	return body
}

// resolveSafe turns a client-supplied path into a path relative to the notes
// directory, "." being the directory itself.
func resolveSafe(rel string) (string, error) {
	p := path.Clean(strings.TrimLeft(strings.ReplaceAll(rel, `\`, "/"), "/"))
	if p == ".." || strings.HasPrefix(p, "../") {
		return "", errors.New("Path escapes notes directory")
	}
	return p, nil
}

// mtime in milliseconds, as a float like Node's stat.mtimeMs. It lets a client
// that has been in the background tell whether the note it has open was written
// in the meantime, without refetching it.
func mtime(info fs.FileInfo) float64 {
	return float64(info.ModTime().UnixNano()) / 1e6
}

type treeEntry struct {
	Type     string       `json:"type"`
	Name     string       `json:"name"`
	Path     string       `json:"path"`
	Mtime    float64      `json:"mtime,omitempty"`
	Children *[]treeEntry `json:"children,omitempty"` // only folders, which always have one

}

func buildTree(dir string, coll *collate.Collator) ([]treeEntry, error) {
	f, err := root.Open(dir)
	if err != nil {
		return nil, err
	}
	entries, err := f.ReadDir(-1)
	f.Close()
	if err != nil {
		return nil, err
	}
	slices.SortFunc(entries, func(a, b fs.DirEntry) int {
		if a.IsDir() != b.IsDir() {
			if a.IsDir() {
				return -1
			}
			return 1
		}
		return coll.CompareString(a.Name(), b.Name())
	})
	result := []treeEntry{}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		rel := path.Join(dir, entry.Name())
		if entry.IsDir() {
			children, err := buildTree(rel, coll)
			if err != nil {
				return nil, err
			}
			result = append(result, treeEntry{Type: "folder", Name: entry.Name(), Path: rel, Children: &children})
		} else if strings.HasSuffix(entry.Name(), ".md") {
			info, err := root.Stat(rel)
			if err != nil {
				return nil, err
			}
			result = append(result, treeEntry{Type: "note", Name: entry.Name(), Path: rel, Mtime: mtime(info)})
		}
	}
	return result, nil
}

func handleTree(w http.ResponseWriter, r *http.Request) {
	// Same order as the JavaScript String.localeCompare the client used to get.
	tree, err := buildTree(".", collate.New(language.Und))
	if err != nil {
		writeError(w, err, http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, tree)
}

func handleGetNote(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		rel, err := resolveSafe(r.URL.Query().Get("path"))
		if err != nil {
			return err
		}
		// stat before read: a write landing in between then makes the client reload
		// once more than it needed to, rather than believe it has the newer text.
		info, err := root.Stat(rel)
		if err != nil {
			return err
		}
		content, err := root.ReadFile(rel)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"content": string(content), "mtime": mtime(info)})
		return nil
	}()
	if err != nil {
		writeError(w, err, http.StatusNotFound)
	}
}

var (
	leadingHashes = regexp.MustCompile(`^#+\s*`)
	badChars      = regexp.MustCompile(`[\\/:*?"<>|]`)
)

func cleanName(name string) string {
	name = leadingHashes.ReplaceAllString(name, "")
	name = badChars.ReplaceAllString(name, "")
	name = strings.Join(strings.Fields(name), " ")
	// At most 120 UTF-16 code units, which is what the limit counted when this
	// was JavaScript, but never splitting a character.
	n := 0
	for i, c := range name {
		if n += utf16.RuneLen(c); n > 120 {
			return name[:i]
		}
	}
	return name
}

func sanitizeFilename(name string) string {
	if c := cleanName(name); c != "" {
		return c
	}
	return "Untitled"
}

// A folder path as the client's folder picker sends it: typed by hand, and
// quite possibly pointing at folders that do not exist yet. Every segment is
// cleaned like a filename, and empty segments simply disappear — "" is the
// notes root, which is a valid destination.
func sanitizeRelPath(input string) string {
	var segs []string
	for _, seg := range strings.Split(input, "/") {
		if t := strings.TrimSpace(seg); t == "." || t == ".." {
			continue
		}
		if c := cleanName(seg); c != "" {
			segs = append(segs, c)
		}
	}
	return strings.Join(segs, "/")
}

// The folder a note is about to land in, brought into existence a level at a
// time. Typing a path in the folder picker is the only way to make a folder,
// so every folder in the tree was created here.
func ensureFolder(relPath string) (string, error) {
	rel, err := resolveSafe(relPath)
	if err != nil {
		return "", err
	}
	if err := root.MkdirAll(rel, 0o777); err != nil {
		// MkdirAll is happy with a folder that already exists, so getting here
		// means a segment of the path is an existing file — a bad request, not a fault.
		return "", badRequest(`Cannot use "` + relPath + `" as a folder`)
	}
	return rel, nil
}

func exists(rel string) bool {
	_, err := root.Stat(rel)
	return err == nil
}

func uniquePath(dir, base, ext string) string {
	candidate := path.Join(dir, base+ext)
	for i := 2; exists(candidate); i++ {
		candidate = path.Join(dir, base+" ("+strconv.Itoa(i)+")"+ext)
	}
	return candidate
}

// jsString is the JavaScript String(value || ”) the folder fields were read with.
func jsString(v any) string {
	switch v := v.(type) {
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
	case float64:
		if v != 0 {
			return strconv.FormatFloat(v, 'f', -1, 64)
		}
	}
	return ""
}

func handlePutNote(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		body := readBody(w, r)
		relPath, ok1 := body["path"].(string)
		content, ok2 := body["content"].(string)
		if !ok1 || !ok2 {
			return badRequest("path and content required")
		}
		rel, err := resolveSafe(relPath)
		if err != nil {
			return err
		}
		if err := root.MkdirAll(path.Dir(rel), 0o777); err != nil {
			return err
		}
		if err := root.WriteFile(rel, []byte(content), 0o666); err != nil {
			return err
		}

		firstLine, _, _ := strings.Cut(content, "\n")
		desiredName := sanitizeFilename(firstLine)
		currentName := strings.TrimSuffix(path.Base(rel), ".md")
		finalPath, finalRel := relPath, rel
		if desiredName != currentName {
			finalRel = uniquePath(path.Dir(rel), desiredName, ".md")
			if err := root.Rename(rel, finalRel); err != nil {
				return err
			}
			finalPath = finalRel
		}
		// The client keeps this as the mtime of what it has on screen, so that its
		// own save does not look like someone else's change on the next refresh.
		info, err := root.Stat(finalRel)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"path": finalPath, "mtime": mtime(info)})
		return nil
	}()
	if err != nil {
		writeError(w, err, http.StatusInternalServerError)
	}
}

func handleCreateNote(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		body := readBody(w, r)
		dir, err := ensureFolder(sanitizeRelPath(jsString(body["folder"])))
		if err != nil {
			return err
		}
		rel := uniquePath(dir, "Untitled", ".md")
		if err := root.WriteFile(rel, nil, 0o666); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"path": rel})
		return nil
	}()
	if err != nil {
		writeError(w, err, http.StatusInternalServerError)
	}
}

var unnamedNote = regexp.MustCompile(`^Untitled( \(\d+\))?\.md$`)

// Throwing away a note that never became one. A new note is a file on disk
// before it has a name or a word in it, so the client asks for this as soon as
// you navigate away from an untouched one. Both conditions are checked here and
// not just in the client, so that a stale path cannot delete real writing.
func handleDiscardNote(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		rel, err := resolveSafe(r.URL.Query().Get("path"))
		if err != nil {
			return err
		}
		if !unnamedNote.MatchString(path.Base(rel)) {
			return badRequest("Only an unnamed note can be discarded")
		}
		content, err := root.ReadFile(rel)
		if err != nil {
			return err
		}
		if strings.TrimSpace(string(content)) != "" {
			return &httpError{http.StatusConflict, "Note is not empty"}
		}
		if err := root.Remove(rel); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"discarded": true})
		return nil
	}()
	// Already gone (two tabs, a double navigation) is the outcome we wanted.
	if errors.Is(err, fs.ErrNotExist) {
		writeJSON(w, http.StatusOK, map[string]any{"discarded": false})
	} else if err != nil {
		writeError(w, err, http.StatusInternalServerError)
	}
}

func handleRename(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		body := readBody(w, r)
		relPath, _ := body["path"].(string)
		name, _ := body["name"].(string)
		if relPath == "" || name == "" {
			return badRequest("path and name required")
		}
		rel, err := resolveSafe(relPath)
		if err != nil {
			return err
		}
		if rel == "." {
			return badRequest("Cannot rename root")
		}
		info, err := root.Stat(rel)
		if err != nil {
			return err
		}
		if !info.IsDir() {
			return badRequest("Only folders can be renamed; notes rename via their first line")
		}
		target := path.Join(path.Dir(rel), sanitizeFilename(name))
		if target == rel {
			writeJSON(w, http.StatusOK, map[string]any{"path": relPath})
			return nil
		}
		if exists(target) {
			return &httpError{http.StatusConflict, "A folder with this name already exists"}
		}
		if err := root.Rename(rel, target); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"path": target})
		return nil
	}()
	if err != nil {
		writeError(w, err, http.StatusInternalServerError)
	}
}

func handleMove(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		body := readBody(w, r)
		from, ok1 := body["from"].(string)
		to, ok2 := body["to"].(string)
		if !ok1 || !ok2 {
			return badRequest("from and to required")
		}
		src, err := resolveSafe(from)
		if err != nil {
			return err
		}
		if src == "." {
			return badRequest("Cannot move root")
		}
		// The destination is checked before it is created, so that a typo cannot
		// leave a folder behind on a move that was going to be refused anyway.
		dstFolder, err := resolveSafe(sanitizeRelPath(to))
		if err != nil {
			return err
		}
		if dstFolder == src || strings.HasPrefix(dstFolder, src+"/") {
			return badRequest("Cannot move a folder into itself")
		}
		if _, err := ensureFolder(sanitizeRelPath(to)); err != nil {
			return err
		}
		target := path.Join(dstFolder, path.Base(src))
		if target == src {
			writeJSON(w, http.StatusOK, map[string]any{"path": from})
			return nil
		}
		if exists(target) {
			return &httpError{http.StatusConflict, "An entry with this name already exists in the destination"}
		}
		if err := root.Rename(src, target); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"path": target})
		return nil
	}()
	if err != nil {
		writeError(w, err, http.StatusInternalServerError)
	}
}

func handleDeleteEntry(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		rel, err := resolveSafe(r.URL.Query().Get("path"))
		if err != nil {
			return err
		}
		if rel == "." {
			return errors.New("Cannot delete root")
		}
		if err := root.RemoveAll(rel); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		return nil
	}()
	if err != nil {
		writeError(w, err, http.StatusInternalServerError)
	}
}
