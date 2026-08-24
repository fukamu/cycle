package postgres

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

func TestSessionAdaptersAndSharedUserLockDoNotEmbedRawSQL(t *testing.T) {
	t.Parallel()

	fileSet := token.NewFileSet()
	sessionFile, err := parser.ParseFile(fileSet, "session_repository.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	violations := sessionRawSQLViolations(fileSet, "session_repository.go", sessionFile, "")
	accountFile, err := parser.ParseFile(fileSet, "account_repository.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	violations = append(violations, accountSessionRawSQLViolations(fileSet, accountFile)...)

	productionFiles, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range productionFiles {
		if path == "session_repository.go" || strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, parseErr := parser.ParseFile(fileSet, path, nil, 0)
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		violations = append(violations, sessionRawSQLViolations(fileSet, path, file, "lockUser")...)
	}
	if len(violations) == 0 {
		return
	}
	sort.Strings(violations)
	t.Fatalf("Session SQL must live in queries/*.sql and be called through generated methods; raw SQL found:\n%s",
		strings.Join(violations, "\n"))
}

func accountSessionRawSQLViolations(fileSet *token.FileSet, file *ast.File) []string {
	var violations []string
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Body == nil {
			continue
		}
		ast.Inspect(function.Body, func(node ast.Node) bool {
			literal, ok := node.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			value, unquoteErr := strconv.Unquote(literal.Value)
			if unquoteErr != nil {
				return true
			}
			normalized := strings.Join(strings.Fields(value), " ")
			lower := strings.ToLower(normalized)
			if !looksLikeSessionRawSQL(normalized) ||
				!strings.Contains(lower, " sessions ") && !strings.Contains(lower, " anonymous_bootstraps ") {
				return true
			}
			position := fileSet.Position(literal.Pos())
			violations = append(violations, fmt.Sprintf(
				"account_repository.go:%d %s: %s",
				position.Line,
				function.Name.Name,
				normalized,
			))
			return true
		})
	}
	return violations
}

func sessionRawSQLViolations(fileSet *token.FileSet, path string, file *ast.File, onlyFunction string) []string {
	var violations []string
	for _, declaration := range file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Body == nil || onlyFunction != "" && function.Name.Name != onlyFunction {
			continue
		}
		ast.Inspect(function.Body, func(node ast.Node) bool {
			literal, ok := node.(*ast.BasicLit)
			if !ok || literal.Kind != token.STRING {
				return true
			}
			value, unquoteErr := strconv.Unquote(literal.Value)
			if unquoteErr != nil {
				return true
			}
			normalized := strings.Join(strings.Fields(value), " ")
			if !looksLikeSessionRawSQL(normalized) {
				return true
			}
			position := fileSet.Position(literal.Pos())
			violations = append(violations, fmt.Sprintf("%s:%d %s: %s", path, position.Line, function.Name.Name, normalized))
			return true
		})
	}
	return violations
}

func looksLikeSessionRawSQL(value string) bool {
	lower := strings.ToLower(value)
	return strings.HasPrefix(lower, "insert into ") ||
		strings.HasPrefix(lower, "delete from ") ||
		strings.HasPrefix(lower, "update ") && strings.Contains(lower, " set ") ||
		strings.HasPrefix(lower, "select ") && strings.Contains(lower, " from ") ||
		strings.HasPrefix(lower, "with ") && strings.Contains(lower, " select ")
}
