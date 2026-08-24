package postgres

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strings"
	"testing"
)

func TestProductionPostgresAdaptersDoNotCallRawSQL(t *testing.T) {
	t.Parallel()

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	fileSet := token.NewFileSet()
	var violations []string
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
			value, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := value.Fun.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "Exec" && selector.Sel.Name != "Query" && selector.Sel.Name != "QueryRow" {
				return true
			}
			position := fileSet.Position(value.Pos())
			violations = append(violations, fmt.Sprintf("%s:%d calls %s directly", name, position.Line, selector.Sel.Name))
			return true
		})
	}
	if len(violations) == 0 {
		return
	}
	sort.Strings(violations)
	t.Fatalf("production PostgreSQL SQL must live in queries/*.sql and be called through generated methods:\n%s", strings.Join(violations, "\n"))
}
