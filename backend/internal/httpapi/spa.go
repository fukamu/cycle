package httpapi

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func newSPAHandler(directory string) http.Handler {
	files := http.FileServer(http.Dir(directory))
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if strings.HasPrefix(request.URL.Path, "/api/") {
			http.NotFound(writer, request)
			return
		}
		relative := strings.TrimPrefix(filepath.ToSlash(filepath.Clean(request.URL.Path)), "/")
		if relative == "." || relative == "" {
			relative = "index.html"
		}
		info, err := os.Stat(filepath.Join(directory, filepath.FromSlash(relative)))
		if err == nil && !info.IsDir() {
			if strings.HasPrefix(relative, "assets/") {
				writer.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(writer, request)
			return
		}
		if strings.Contains(filepath.Base(relative), ".") {
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("Cache-Control", "no-cache")
		index, openErr := os.Open(filepath.Join(directory, "index.html"))
		if openErr != nil {
			http.NotFound(writer, request)
			return
		}
		defer index.Close()
		indexInfo, statErr := index.Stat()
		if statErr != nil {
			http.NotFound(writer, request)
			return
		}
		http.ServeContent(writer, request, "index.html", indexInfo.ModTime(), index)
	})
}
