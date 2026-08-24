package safelog

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
)

func TestAllowedFieldCatalogMatchesSourceOfTruth(t *testing.T) {
	want := []string{
		"ai_generation_id", "ai_model", "ai_operation_type", "cleanup_batch_count", "cleanup_candidate_count",
		"cleanup_deleted_count", "cleanup_mode", "cleanup_resource", "context_changed", "context_cycle_count",
		"cycle_state_from", "cycle_state_to", "error_class", "error_code", "estimated_cost_usd",
		"failure_count", "goal_state_from", "goal_state_to", "input_tokens", "latency_ms", "method",
		"migration_applied_count", "migration_direction", "migration_duration_ms", "migration_file",
		"migration_no_change", "migration_version", "operation", "output_tokens", "prompt_version",
		"provider_latency_ms", "request_id", "route_template", "status_code", "trace_id",
	}
	got := make([]string, 0, len(allowedFields))
	for field := range allowedFields {
		got = append(got, field)
	}
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("safe-log field catalog = %v, want docs/design.md section 42.2 fields %v", got, want)
	}
}

func TestProductionLogSourcesCannotBypassSafeFieldBoundary(t *testing.T) {
	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test file")
	}
	backendRoot := filepath.Clean(filepath.Join(filepath.Dir(currentFile), "..", "..", ".."))
	fileSet := token.NewFileSet()
	var violations []string
	err := filepath.WalkDir(backendRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || filepath.Ext(path) != ".go" || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, parseErr := parser.ParseFile(fileSet, path, nil, 0)
		if parseErr != nil {
			return parseErr
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, callOK := node.(*ast.CallExpr)
			if !callOK {
				return true
			}
			if identifier, identifierOK := call.Fun.(*ast.Ident); identifierOK && (identifier.Name == "print" || identifier.Name == "println") {
				position := fileSet.Position(call.Pos())
				relative := strings.TrimPrefix(path, backendRoot+string(filepath.Separator))
				violations = append(violations, fmt.Sprintf("%s:%d uses raw production output", relative, position.Line))
				return true
			}
			selector, selectorOK := call.Fun.(*ast.SelectorExpr)
			if !selectorOK {
				return true
			}
			position := fileSet.Position(call.Pos())
			location := fmt.Sprintf("%s:%d", strings.TrimPrefix(path, backendRoot+string(filepath.Separator)), position.Line)
			if packageName, packageOK := selector.X.(*ast.Ident); packageOK && packageName.Name == "fmt" &&
				isRawPrintMethod(selector.Sel.Name) && !isFixedConfigCheckOutput(path, backendRoot, selector.Sel.Name, call.Args) {
				violations = append(violations, location+" uses raw production output outside the fixed configcheck status")
			}
			if packageName, packageOK := selector.X.(*ast.Ident); packageOK && packageName.Name == "log" && isRawPrintMethod(selector.Sel.Name) {
				violations = append(violations, location+" uses raw production log output")
			}
			if packageName, packageOK := selector.X.(*ast.Ident); packageOK && packageName.Name == "slog" {
				switch selector.Sel.Name {
				case "NewJSONHandler", "NewTextHandler":
					if filepath.Clean(path) != filepath.Join(filepath.Dir(currentFile), "safelog.go") {
						violations = append(violations, location+" constructs a raw production slog handler")
					}
				case "Any", "Group":
					violations = append(violations, location+" uses an unbounded slog attribute constructor")
				default:
					if isSlogAttributeConstructor(selector.Sel.Name) && len(call.Args) != 0 {
						violations = appendInvalidLiteralField(violations, location, call.Args[0])
						if len(call.Args) > 1 && containsRawErrorIdentifier(call.Args[1]) {
							violations = append(violations, location+" passes a raw error value to a structured log")
						}
					}
				}
			}
			if isKeyValueStructuredLogMethod(selector.Sel.Name) && (len(call.Args) < 2 || !isSlogAttributeCall(call.Args[1])) {
				for index := 1; index+1 < len(call.Args); index += 2 {
					violations = appendInvalidLiteralField(violations, location, call.Args[index])
					if containsRawErrorIdentifier(call.Args[index+1]) {
						violations = append(violations, location+" passes a raw error value to a structured log")
					}
				}
			}
			return true
		})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(violations) != 0 {
		slices.Sort(violations)
		t.Fatalf("production log boundary violations:\n%s", strings.Join(violations, "\n"))
	}
}

func isRawPrintMethod(name string) bool {
	switch name {
	case "Print", "Printf", "Println", "Fprint", "Fprintf", "Fprintln":
		return true
	default:
		return false
	}
}

func isFixedConfigCheckOutput(path, backendRoot, method string, arguments []ast.Expr) bool {
	if strings.TrimPrefix(path, backendRoot+string(filepath.Separator)) != filepath.Join("cmd", "configcheck", "main.go") ||
		method != "Fprintln" || len(arguments) != 2 {
		return false
	}
	destination, destinationOK := arguments[0].(*ast.SelectorExpr)
	if !destinationOK {
		return false
	}
	osPackage, osPackageOK := destination.X.(*ast.Ident)
	message, messageOK := arguments[1].(*ast.Ident)
	if !osPackageOK || osPackage.Name != "os" || !messageOK {
		return false
	}
	return destination.Sel.Name == "Stderr" && message.Name == "failureMessage" ||
		destination.Sel.Name == "Stdout" && message.Name == "successMessage"
}

func appendInvalidLiteralField(violations []string, location string, expression ast.Expr) []string {
	literal, ok := expression.(*ast.BasicLit)
	if !ok || literal.Kind != token.STRING {
		return append(violations, location+" uses a non-literal structured-log field")
	}
	field, err := strconv.Unquote(literal.Value)
	if err != nil {
		return append(violations, location+" uses an invalid structured-log field literal")
	}
	if _, allowed := allowedFields[field]; !allowed {
		return append(violations, fmt.Sprintf("%s uses non-SoT structured-log field %q", location, field))
	}
	return violations
}

func isSlogAttributeConstructor(name string) bool {
	switch name {
	case "String", "Int", "Int64", "Uint64", "Float64", "Bool", "Duration", "Time":
		return true
	default:
		return false
	}
}

func isKeyValueStructuredLogMethod(name string) bool {
	switch name {
	case "Debug", "Info", "Warn", "Error":
		return true
	default:
		return false
	}
}

func isSlogAttributeCall(expression ast.Expr) bool {
	call, ok := expression.(*ast.CallExpr)
	if !ok {
		return false
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	identifier, ok := selector.X.(*ast.Ident)
	return ok && identifier.Name == "slog" && isSlogAttributeConstructor(selector.Sel.Name)
}

func containsRawErrorIdentifier(expression ast.Expr) bool {
	found := false
	ast.Inspect(expression, func(node ast.Node) bool {
		identifier, ok := node.(*ast.Ident)
		if !ok || identifier.Obj == nil {
			return true
		}
		name := strings.ToLower(identifier.Name)
		if name == "err" || name == "error" || strings.HasSuffix(name, "err") || strings.HasSuffix(name, "error") {
			found = true
			return false
		}
		return true
	})
	return found
}
