package main

import (
	"errors"
	"fmt"
	"os"

	"github.com/fukamu/cycle/backend/internal/ai/prompts"
	"github.com/fukamu/cycle/backend/internal/config"
	"github.com/fukamu/cycle/backend/internal/infrastructure/aiprovider"
)

const (
	failureMessage = "configuration check failed"
	successMessage = "configuration check passed"
)

func main() {
	if err := checkConfiguration(); err != nil {
		fmt.Fprintln(os.Stderr, failureMessage)
		os.Exit(1)
	}
	fmt.Fprintln(os.Stdout, successMessage)
}

func checkConfiguration() error {
	settings, err := config.Load(os.LookupEnv)
	if err != nil {
		return errors.New("configuration invalid")
	}
	if _, err := prompts.Resolve(prompts.Versions{
		GoalRefine:     settings.AI.GoalPromptVersion,
		ActionGenerate: settings.AI.GeneratePromptVersion,
		ActionRefine:   settings.AI.RefinePromptVersion,
	}); err != nil {
		return errors.New("prompt configuration invalid")
	}
	if _, err := aiprovider.NewTokenCounter(settings.AI.TokenizerEncoding); err != nil {
		return errors.New("tokenizer configuration invalid")
	}
	return nil
}
