package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSPAHandlerServesAssetsAndRouteFallbackWithoutMaskingAPI(t *testing.T) {
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<main>FUKAMU Cycle</main>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "assets", "app.js"), []byte("export{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("app.js", filepath.Join(directory, "assets", "app-link.js")); err != nil {
		t.Fatal(err)
	}
	handler := NewRouter(Dependencies{StaticDir: directory})

	tests := []struct {
		path         string
		status       int
		body         string
		cacheControl string
	}{
		{path: "/settings", status: http.StatusOK, body: "<main>FUKAMU Cycle</main>", cacheControl: "no-cache"},
		{path: "/assets/app.js", status: http.StatusOK, body: "export{}", cacheControl: "public, max-age=31536000, immutable"},
		{path: "/assets/app-link.js", status: http.StatusOK, body: "export{}", cacheControl: "public, max-age=31536000, immutable"},
		{path: "/missing.js", status: http.StatusNotFound},
		{path: "/api/v1/missing", status: http.StatusNotFound},
		{path: "/api/../assets/app.js", status: http.StatusNotFound},
		{path: "/settings/../api/v1/missing", status: http.StatusNotFound},
	}
	for _, test := range tests {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, test.path, nil))
		if response.Code != test.status {
			t.Fatalf("%s status = %d, want %d", test.path, response.Code, test.status)
		}
		if test.body != "" && response.Body.String() != test.body {
			t.Fatalf("%s body = %q, want %q", test.path, response.Body.String(), test.body)
		}
		if got := response.Header().Get("Cache-Control"); got != test.cacheControl {
			t.Fatalf("%s Cache-Control = %q, want %q", test.path, got, test.cacheControl)
		}
	}
}

func TestSPAHandlerDoesNotServeFilesOutsideStaticRoot(t *testing.T) {
	parent := t.TempDir()
	directory := filepath.Join(parent, "static")
	if err := os.MkdirAll(filepath.Join(directory, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<main>safe index</main>"), 0o600); err != nil {
		t.Fatal(err)
	}
	outsideDirectory := filepath.Join(parent, "outside")
	if err := os.Mkdir(outsideDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	outsidePath := filepath.Join(outsideDirectory, "outside.txt")
	const outsideContents = "must never leave the static root"
	if err := os.WriteFile(outsidePath, []byte(outsideContents), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsidePath, filepath.Join(directory, "assets", "outside.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDirectory, filepath.Join(directory, "assets", "escape")); err != nil {
		t.Fatal(err)
	}

	handler := newSPAHandler(directory)
	for _, requestURL := range []string{
		"http://example.test/%2e%2e/outside/outside.txt",
		"http://example.test/..%5coutside.txt",
		"http://example.test/assets/outside.txt",
		"http://example.test/assets/escape/outside.txt",
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, requestURL, nil))
		if strings.Contains(response.Body.String(), outsideContents) {
			t.Fatalf("%s exposed a file outside the static root", requestURL)
		}
		if response.Code != http.StatusNotFound {
			t.Fatalf("%s status = %d, want %d", requestURL, response.Code, http.StatusNotFound)
		}
	}
}

func TestSPAHandlerDoesNotFollowIndexOutsideStaticRoot(t *testing.T) {
	parent := t.TempDir()
	directory := filepath.Join(parent, "static")
	if err := os.Mkdir(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	outsidePath := filepath.Join(parent, "outside.html")
	const outsideContents = "must not become the SPA index"
	if err := os.WriteFile(outsidePath, []byte(outsideContents), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsidePath, filepath.Join(directory, "index.html")); err != nil {
		t.Fatal(err)
	}

	response := httptest.NewRecorder()
	newSPAHandler(directory).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/settings", nil))
	if strings.Contains(response.Body.String(), outsideContents) {
		t.Fatal("SPA fallback exposed an index file outside the static root")
	}
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusNotFound)
	}
}
