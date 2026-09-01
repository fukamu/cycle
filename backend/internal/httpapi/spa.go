package httpapi

import (
	"io/fs"
	"net/http"
	"os"
	"path"
	"strings"
)

func newSPAHandler(directory string) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		cleanPath := path.Clean("/" + request.URL.Path)
		if strings.HasPrefix(request.URL.Path, "/api/") || strings.HasPrefix(cleanPath, "/api/") {
			http.NotFound(writer, request)
			return
		}
		root, rootErr := os.OpenRoot(directory)
		if rootErr != nil {
			http.NotFound(writer, request)
			return
		}
		defer root.Close()

		rootFS := root.FS()
		files := http.FileServerFS(rootFS)
		relative := strings.TrimPrefix(cleanPath, "/")
		if relative == "." || relative == "" {
			relative = "index.html"
		}
		info, err := fs.Stat(rootFS, relative)
		if err == nil && !info.IsDir() {
			if strings.HasPrefix(relative, "assets/") {
				writer.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			files.ServeHTTP(writer, request)
			return
		}
		if strings.Contains(path.Base(relative), ".") {
			http.NotFound(writer, request)
			return
		}
		writer.Header().Set("Cache-Control", "no-cache")
		index, openErr := root.Open("index.html")
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
