package main

import (
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/matoruru/PDCAI/backend/internal/config"
	"github.com/matoruru/PDCAI/backend/internal/httpapi"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	settings, err := config.Load(os.LookupEnv)
	if err != nil {
		logger.Error("invalid configuration", "error_class", "configuration_invalid", "error", err)
		os.Exit(1)
	}
	server := &http.Server{
		Addr:              settings.App.HTTPAddress,
		Handler:           httpapi.NewRouter(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	logger.Info("server starting", "address", server.Addr)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		logger.Error("server stopped", "error_class", "listen_failed")
		os.Exit(1)
	}
}
