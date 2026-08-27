package postgres

import (
	"bufio"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func TestSQLCNamedQueriesHaveProductionCallers(t *testing.T) {
	t.Parallel()

	named := sqlcNamedQueries(t)
	called := productionSelectorCalls(t)
	unused := make([]string, 0)
	for name := range named {
		if !called[name] {
			unused = append(unused, name)
		}
	}
	if len(unused) == 0 {
		return
	}
	sort.Strings(unused)
	t.Fatalf("sqlc query source must not expose unused generated methods: %s", strings.Join(unused, ", "))
}

func sqlcNamedQueries(t *testing.T) map[string]string {
	t.Helper()
	entries, err := os.ReadDir("queries")
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		path := filepath.Join("queries", entry.Name())
		file, openErr := os.Open(path)
		if openErr != nil {
			t.Fatal(openErr)
		}
		scanner := bufio.NewScanner(file)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if !strings.HasPrefix(line, "-- name: ") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) < 4 || fields[0] != "--" || fields[1] != "name:" {
				t.Fatalf("invalid sqlc query marker in %s: %s", path, line)
			}
			name := fields[2]
			if previous, exists := result[name]; exists {
				t.Fatalf("duplicate sqlc query %s in %s and %s", name, previous, path)
			}
			result[name] = path
		}
		if scanErr := scanner.Err(); scanErr != nil {
			file.Close()
			t.Fatal(scanErr)
		}
		if closeErr := file.Close(); closeErr != nil {
			t.Fatal(closeErr)
		}
	}
	return result
}

func productionSelectorCalls(t *testing.T) map[string]bool {
	t.Helper()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	fileSet := token.NewFileSet()
	called := map[string]bool{}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, parseErr := parser.ParseFile(fileSet, name, nil, 0)
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if ok {
				called[selector.Sel.Name] = true
			}
			return true
		})
	}
	return called
}
