package main

import (
	"bytes"
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"log/slog"
	"math"
	"strings"
	"testing"
	"time"
)

type recordingTelemetryShutdown struct {
	calls       int
	hasDeadline bool
	err         error
}

func (runtime *recordingTelemetryShutdown) Shutdown(ctx context.Context) error {
	runtime.calls++
	_, runtime.hasDeadline = ctx.Deadline()
	return runtime.err
}

func TestTelemetryShutdownIsBoundedExactlyOnceAndLogsNoRawError(t *testing.T) {
	const errorCanary = "TELEMETRY_SECRET_ERROR_CANARY"
	runtime := &recordingTelemetryShutdown{err: errors.New(errorCanary)}
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	shutdown := newTelemetryShutdown(runtime, logger, 50*time.Millisecond)

	first := shutdown()
	second := shutdown()
	if !errors.Is(first, runtime.err) || !errors.Is(second, runtime.err) {
		t.Fatalf("shutdown errors = %v / %v", first, second)
	}
	if runtime.calls != 1 || !runtime.hasDeadline {
		t.Fatalf("Shutdown calls/deadline = %d/%v", runtime.calls, runtime.hasDeadline)
	}
	if got := output.String(); !strings.Contains(got, "telemetry_shutdown_failed") || strings.Contains(got, errorCanary) {
		t.Fatalf("shutdown log is unsafe or missing stable class: %s", got)
	}
}

func TestCleanupServerResourcesFlushesTelemetryBeforeClosingPool(t *testing.T) {
	var events []string
	cleanupServerResources(
		func() error {
			events = append(events, "telemetry")
			return errors.New("collector unavailable")
		},
		func() { events = append(events, "pool") },
		true,
	)
	if got := strings.Join(events, ","); got != "telemetry,pool" {
		t.Fatalf("cleanup order = %q, want telemetry,pool", got)
	}
}

func TestCleanupServerResourcesSkipsPoolCloseAfterHTTPDrainFailure(t *testing.T) {
	var events []string
	cleanupServerResources(
		func() error {
			events = append(events, "telemetry")
			return nil
		},
		func() { events = append(events, "pool") },
		false,
	)
	if got := strings.Join(events, ","); got != "telemetry" {
		t.Fatalf("cleanup events = %q, want bounded telemetry cleanup only", got)
	}
}

func TestRunDoesNotCallOSExitBeforeDeferredCleanup(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var run *ast.FuncDecl
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if ok && function.Name.Name == "run" {
			run = function
			break
		}
	}
	if run == nil {
		t.Fatal("run function is missing")
	}
	ast.Inspect(run.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		identifier, identifierOK := selector.X.(*ast.Ident)
		if ok && identifierOK && identifier.Name == "os" && selector.Sel.Name == "Exit" {
			t.Error("run must return so deferred telemetry shutdown always executes; os.Exit is only allowed in main")
		}
		return true
	})
}

func TestHTTPServerUsesFailClosedErrorLog(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "main.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	ast.Inspect(file, func(node ast.Node) bool {
		literal, ok := node.(*ast.CompositeLit)
		if !ok {
			return true
		}
		selector, ok := literal.Type.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		packageName, packageOK := selector.X.(*ast.Ident)
		if !packageOK || packageName.Name != "http" || selector.Sel.Name != "Server" {
			return true
		}
		for _, element := range literal.Elts {
			field, fieldOK := element.(*ast.KeyValueExpr)
			if !fieldOK {
				continue
			}
			name, nameOK := field.Key.(*ast.Ident)
			if !nameOK || name.Name != "ErrorLog" {
				continue
			}
			call, callOK := field.Value.(*ast.CallExpr)
			if !callOK {
				continue
			}
			constructor, constructorOK := call.Fun.(*ast.SelectorExpr)
			if !constructorOK {
				continue
			}
			owner, ownerOK := constructor.X.(*ast.Ident)
			found = ownerOK && owner.Name == "safelog" && constructor.Sel.Name == "NewHTTPServerErrorLog"
		}
		return true
	})
	if !found {
		t.Fatal("http.Server.ErrorLog must discard net/http panic values, raw remote addresses, and stacks through safelog")
	}
}

func TestMaximumAIReservationUSDUsesOperationOutputLimit(t *testing.T) {
	t.Parallel()

	const (
		maxInputTokens      = 1_000
		maxProviderAttempts = 2
		inputPrice          = 1.0
		outputPrice         = 2.0
	)

	goalRefine := maximumAIReservationUSD(maxInputTokens, 400, maxProviderAttempts, inputPrice, outputPrice)
	action := maximumAIReservationUSD(maxInputTokens, 800, maxProviderAttempts, inputPrice, outputPrice)

	if math.Abs(goalRefine-0.0036) > 1e-12 {
		t.Fatalf("Goal Refine reservation = %.12f, want 0.0036", goalRefine)
	}
	if math.Abs(action-0.0052) > 1e-12 {
		t.Fatalf("Action reservation = %.12f, want 0.0052", action)
	}
	if goalRefine >= action {
		t.Fatalf("Goal Refine reservation %.12f must be lower than Action reservation %.12f", goalRefine, action)
	}
}
