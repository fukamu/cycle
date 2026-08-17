package httpapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestSPAHandlerServesAssetsAndRouteFallbackWithoutMaskingAPI(t *testing.T) {
	directory := t.TempDir()
	if err := os.Mkdir(filepath.Join(directory, "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("<main>PDCAI</main>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "assets", "app.js"), []byte("export{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := NewRouter(Dependencies{StaticDir: directory})

	for path, expected := range map[string]int{"/settings": http.StatusOK, "/assets/app.js": http.StatusOK, "/missing.js": http.StatusNotFound, "/api/v1/missing": http.StatusNotFound} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != expected {
			t.Fatalf("%s status = %d, want %d", path, response.Code, expected)
		}
	}
}
