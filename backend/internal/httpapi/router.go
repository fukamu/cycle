package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

type healthResponse struct {
	Status string `json:"status"`
}

func NewRouter() http.Handler {
	router := chi.NewRouter()
	router.Get("/healthz", healthHandler)
	router.Get("/readyz", healthHandler)
	return router
}

func healthHandler(writer http.ResponseWriter, _ *http.Request) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(healthResponse{Status: "ok"})
}
