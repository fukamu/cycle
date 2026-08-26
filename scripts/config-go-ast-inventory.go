package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

var environmentMembers = map[string]struct{}{
	"Clearenv":  {},
	"Environ":   {},
	"ExpandEnv": {},
	"Getenv":    {},
	"LookupEnv": {},
	"Setenv":    {},
	"Unsetenv":  {},
}

type inventory struct {
	EnvironmentImports  []environmentImport `json:"environmentImports"`
	EnvironmentAccesses []environmentAccess `json:"environmentAccesses"`
	LookupParameters    []lookupParameter   `json:"lookupParameters"`
	Config              configInventory     `json:"config"`
}

type environmentImport struct {
	Path       string `json:"path"`
	ImportPath string `json:"importPath"`
	Name       string `json:"name"`
	Literal    string `json:"literal"`
}

type environmentAccess struct {
	Path       string `json:"path"`
	Identifier string `json:"identifier"`
	Kind       string `json:"kind"`
	Key        string `json:"key"`
	Consumer   string `json:"consumer"`
}

type lookupParameter struct {
	Path     string      `json:"path"`
	Function string      `json:"function"`
	Name     string      `json:"name"`
	Type     string      `json:"type"`
	Uses     []lookupUse `json:"uses"`
}

type lookupUse struct {
	Kind       string `json:"kind"`
	Expression string `json:"expression"`
}

type configInventory struct {
	ReaderMethods  []string       `json:"readerMethods"`
	LoadAccesses   []readerAccess `json:"loadAccesses"`
	LookupAccesses []lookupAccess `json:"lookupAccesses"`
}

type readerAccess struct {
	Receiver string `json:"receiver"`
	Member   string `json:"member"`
	Kind     string `json:"kind"`
	Key      string `json:"key"`
}

type lookupAccess struct {
	Function string `json:"function"`
	Receiver string `json:"receiver"`
	Kind     string `json:"kind"`
	Key      string `json:"key"`
}

type parsedFile struct {
	path string
	fset *token.FileSet
	file *ast.File
}

func main() {
	if len(os.Args) < 3 {
		fatalf("usage: config-go-ast-inventory ROOT FILE...")
	}
	root, err := filepath.Abs(os.Args[1])
	if err != nil {
		fatalf("resolve repository root: %v", err)
	}

	result := inventory{}
	var configSource *parsedFile
	for _, requestedPath := range os.Args[2:] {
		relativePath := filepath.ToSlash(filepath.Clean(requestedPath))
		if filepath.IsAbs(requestedPath) || relativePath == ".." || strings.HasPrefix(relativePath, "../") {
			fatalf("source path escapes repository: %s", requestedPath)
		}
		absolutePath := filepath.Join(root, filepath.FromSlash(relativePath))
		fset := token.NewFileSet()
		file, parseErr := parser.ParseFile(fset, absolutePath, nil, parser.AllErrors)
		if parseErr != nil {
			fatalf("parse %s: %v", relativePath, parseErr)
		}
		source := parsedFile{path: relativePath, fset: fset, file: file}
		collectEnvironmentImports(&result, source)
		collectEnvironmentAccesses(&result, source)
		parameters, parameterErr := collectLookupParameters(source)
		if parameterErr != nil {
			fatalf("inventory %s lookup parameters: %v", relativePath, parameterErr)
		}
		result.LookupParameters = append(result.LookupParameters, parameters...)
		if relativePath == "backend/internal/config/config.go" {
			current := source
			configSource = &current
		}
	}
	if configSource == nil {
		fatalf("backend/internal/config/config.go was not provided")
	}
	result.Config = collectConfigInventory(*configSource)
	sortInventory(&result)

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		fatalf("encode inventory: %v", err)
	}
}

func collectEnvironmentImports(result *inventory, source parsedFile) {
	for _, specification := range source.file.Imports {
		importPath := decodeImportPath(source, specification)
		if importPath != "os" && importPath != "syscall" {
			continue
		}
		name := ""
		if specification.Name != nil {
			name = specification.Name.Name
		}
		result.EnvironmentImports = append(result.EnvironmentImports, environmentImport{
			Path:       source.path,
			ImportPath: importPath,
			Name:       name,
			Literal:    specification.Path.Value,
		})
	}
}

func collectEnvironmentAccesses(result *inventory, source parsedFile) {
	bindings := importBindings(source)
	inspect(source.file, func(node ast.Node, stack []ast.Node) {
		selector, ok := node.(*ast.SelectorExpr)
		if !ok {
			return
		}
		packageName, ok := selector.X.(*ast.Ident)
		if !ok || packageName.Obj != nil {
			return
		}
		importPath, imported := bindings[packageName.Name]
		if !imported || importPath != packageName.Name || (importPath != "os" && importPath != "syscall") {
			return
		}
		if _, ok := environmentMembers[selector.Sel.Name]; !ok {
			return
		}

		access := environmentAccess{
			Path:       source.path,
			Identifier: packageName.Name + "." + selector.Sel.Name,
			Kind:       "value",
			Key:        "",
			Consumer:   consumer(source.fset, stack),
		}
		if call := directSelectorCall(selector, stack); call != nil {
			access.Kind = "call"
			if selector.Sel.Name == "Environ" || selector.Sel.Name == "Clearenv" {
				access.Key = "<all>"
			} else {
				access.Key = stringArgument(call.Args)
			}
		}
		result.EnvironmentAccesses = append(result.EnvironmentAccesses, access)
	})
}

func decodeImportPath(source parsedFile, specification *ast.ImportSpec) string {
	importPath, err := strconv.Unquote(specification.Path.Value)
	if err != nil {
		fatalf("decode %s import: %v", source.path, err)
	}
	return importPath
}

func importBindings(source parsedFile) map[string]string {
	bindings := map[string]string{}
	for _, specification := range source.file.Imports {
		importPath := decodeImportPath(source, specification)
		name := ""
		if specification.Name != nil {
			name = specification.Name.Name
		} else if slash := strings.LastIndexByte(importPath, '/'); slash >= 0 {
			name = importPath[slash+1:]
		} else {
			name = importPath
		}
		if name == "_" || name == "." {
			continue
		}
		if previous, exists := bindings[name]; exists {
			fatalf("ambiguous %s import binding %s for %s and %s", source.path, name, previous, importPath)
		}
		bindings[name] = importPath
	}
	return bindings
}

func collectLookupParameters(source parsedFile) ([]lookupParameter, error) {
	result := []lookupParameter{}
	for _, declaration := range source.file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok || function.Body == nil || function.Type.Params == nil {
			continue
		}
		for _, field := range function.Type.Params.List {
			if !isLookupType(field.Type) {
				continue
			}
			for _, name := range field.Names {
				if name.Obj == nil {
					return nil, fmt.Errorf("parameter %s.%s has no parser object", function.Name.Name, name.Name)
				}
				parameter := lookupParameter{
					Path:     source.path,
					Function: function.Name.Name,
					Name:     name.Name,
					Type:     render(source.fset, field.Type),
				}
				inspect(function.Body, func(node ast.Node, stack []ast.Node) {
					identifier, ok := node.(*ast.Ident)
					if !ok || identifier.Obj != name.Obj {
						return
					}
					if len(stack) > 0 {
						if keyValue, ok := stack[len(stack)-1].(*ast.KeyValueExpr); ok && keyValue.Key == identifier {
							return
						}
					}
					parameter.Uses = append(parameter.Uses, lookupReference(source.fset, identifier, stack))
				})
				result = append(result, parameter)
			}
		}
	}
	return result, nil
}

func isLookupType(expression ast.Expr) bool {
	switch current := expression.(type) {
	case *ast.Ident:
		return current.Name == "LookupEnv"
	case *ast.SelectorExpr:
		return current.Sel.Name == "LookupEnv"
	case *ast.FuncType:
		return fieldTypes(current.Params, "string") &&
			fieldTypes(current.Results, "string", "bool")
	default:
		return false
	}
}

func fieldTypes(fields *ast.FieldList, expected ...string) bool {
	if fields == nil {
		return len(expected) == 0
	}
	actual := []string{}
	for _, field := range fields.List {
		identifier, ok := field.Type.(*ast.Ident)
		if !ok {
			return false
		}
		count := len(field.Names)
		if count == 0 {
			count = 1
		}
		for range count {
			actual = append(actual, identifier.Name)
		}
	}
	return strings.Join(actual, "\x00") == strings.Join(expected, "\x00")
}

func lookupReference(fset *token.FileSet, identifier *ast.Ident, stack []ast.Node) lookupUse {
	if len(stack) > 0 {
		if call, ok := stack[len(stack)-1].(*ast.CallExpr); ok && call.Fun == identifier {
			return lookupUse{Kind: "call", Expression: render(fset, call)}
		}
	}
	for index := len(stack) - 1; index >= 0; index-- {
		switch ancestor := stack[index].(type) {
		case *ast.KeyValueExpr:
			return lookupUse{Kind: "value", Expression: render(fset, ancestor)}
		case *ast.CallExpr:
			return lookupUse{Kind: "argument", Expression: render(fset, ancestor)}
		case ast.Stmt:
			return lookupUse{Kind: "reference", Expression: render(fset, ancestor)}
		}
	}
	return lookupUse{Kind: "reference", Expression: identifier.Name}
}

func collectConfigInventory(source parsedFile) configInventory {
	result := configInventory{}
	methodNames := map[string]struct{}{}
	var load *ast.FuncDecl
	for _, declaration := range source.file.Decls {
		function, ok := declaration.(*ast.FuncDecl)
		if !ok {
			continue
		}
		if function.Recv == nil && function.Name.Name == "Load" {
			load = function
		}
		if receiverType(function) == "envReader" {
			methodNames[function.Name.Name] = struct{}{}
			result.ReaderMethods = append(result.ReaderMethods, function.Name.Name)
		}
	}
	if load == nil || load.Body == nil {
		fatalf("backend config Load function was not found")
	}

	loadReader := canonicalLoadReaderObject(load)
	inspect(load.Body, func(node ast.Node, stack []ast.Node) {
		selector, ok := node.(*ast.SelectorExpr)
		if !ok {
			return
		}
		receiverIdentifier, receiverIsIdentifier := selector.X.(*ast.Ident)
		_, knownMethod := methodNames[selector.Sel.Name]
		if !(receiverIsIdentifier && receiverIdentifier.Name == "reader") && !knownMethod {
			return
		}
		receiver := render(source.fset, selector.X)
		if receiverIsIdentifier && receiverIdentifier.Name == "reader" && receiverIdentifier.Obj != loadReader {
			receiver = "<noncanonical:" + receiver + ">"
		}
		access := readerAccess{
			Receiver: receiver,
			Member:   selector.Sel.Name,
			Kind:     "value",
			Key:      "",
		}
		if call := directSelectorCall(selector, stack); call != nil {
			access.Kind = "call"
			access.Key = stringArgument(call.Args)
		}
		result.LoadAccesses = append(result.LoadAccesses, access)
	})

	inspect(source.file, func(node ast.Node, stack []ast.Node) {
		selector, ok := node.(*ast.SelectorExpr)
		if !ok || selector.Sel.Name != "lookup" {
			return
		}
		function := enclosingFunctionDeclaration(stack)
		receiver := render(source.fset, selector.X)
		if identifier, ok := selector.X.(*ast.Ident); ok && identifier.Name == "reader" {
			if expected := envReaderReceiverObject(function); expected == nil || identifier.Obj != expected {
				receiver = "<noncanonical:" + receiver + ">"
			}
		}
		access := lookupAccess{
			Function: functionName(function),
			Receiver: receiver,
			Kind:     "value",
			Key:      "",
		}
		if call := directSelectorCall(selector, stack); call != nil {
			access.Kind = "call"
			if len(call.Args) > 0 {
				access.Key = render(source.fset, call.Args[0])
			} else {
				access.Key = "<missing>"
			}
		}
		result.LookupAccesses = append(result.LookupAccesses, access)
	})
	return result
}

func canonicalLoadReaderObject(load *ast.FuncDecl) *ast.Object {
	var result *ast.Object
	inspect(load.Body, func(node ast.Node, _ []ast.Node) {
		assignment, ok := node.(*ast.AssignStmt)
		if !ok || assignment.Tok != token.DEFINE || len(assignment.Lhs) != 1 || len(assignment.Rhs) != 1 {
			return
		}
		identifier, ok := assignment.Lhs[0].(*ast.Ident)
		if !ok || identifier.Name != "reader" {
			return
		}
		literal, ok := assignment.Rhs[0].(*ast.CompositeLit)
		if !ok {
			return
		}
		typeIdentifier, ok := literal.Type.(*ast.Ident)
		if !ok || typeIdentifier.Name != "envReader" {
			return
		}
		if identifier.Obj == nil {
			fatalf("backend config Load reader declaration has no parser object")
		}
		if result != nil {
			fatalf("backend config Load has multiple envReader declarations named reader")
		}
		result = identifier.Obj
	})
	if result == nil {
		fatalf("backend config Load canonical reader declaration was not found")
	}
	return result
}

func envReaderReceiverObject(function *ast.FuncDecl) *ast.Object {
	if function == nil || receiverType(function) != "envReader" || len(function.Recv.List) != 1 {
		return nil
	}
	names := function.Recv.List[0].Names
	if len(names) != 1 || names[0].Name != "reader" {
		return nil
	}
	return names[0].Obj
}

func receiverType(function *ast.FuncDecl) string {
	if function.Recv == nil || len(function.Recv.List) != 1 {
		return ""
	}
	expression := function.Recv.List[0].Type
	if pointer, ok := expression.(*ast.StarExpr); ok {
		expression = pointer.X
	}
	identifier, ok := expression.(*ast.Ident)
	if !ok {
		return ""
	}
	return identifier.Name
}

func enclosingFunctionDeclaration(stack []ast.Node) *ast.FuncDecl {
	for index := len(stack) - 1; index >= 0; index-- {
		if function, ok := stack[index].(*ast.FuncDecl); ok {
			return function
		}
	}
	return nil
}

func functionName(function *ast.FuncDecl) string {
	if function == nil {
		return "<package>"
	}
	return function.Name.Name
}

func directSelectorCall(selector *ast.SelectorExpr, stack []ast.Node) *ast.CallExpr {
	if len(stack) == 0 {
		return nil
	}
	call, ok := stack[len(stack)-1].(*ast.CallExpr)
	if !ok || call.Fun != selector {
		return nil
	}
	return call
}

func stringArgument(arguments []ast.Expr) string {
	if len(arguments) == 0 {
		return "<missing>"
	}
	literal, ok := arguments[0].(*ast.BasicLit)
	if !ok || literal.Kind != token.STRING {
		return "<dynamic>"
	}
	value, err := strconv.Unquote(literal.Value)
	if err != nil {
		return "<invalid>"
	}
	return value
}

func consumer(fset *token.FileSet, stack []ast.Node) string {
	for index := len(stack) - 1; index >= 0; index-- {
		switch ancestor := stack[index].(type) {
		case *ast.AssignStmt, *ast.ReturnStmt, *ast.ExprStmt, *ast.DeclStmt,
			*ast.GoStmt, *ast.DeferStmt, *ast.SendStmt, *ast.IncDecStmt:
			return render(fset, ancestor)
		case *ast.RangeStmt:
			return rangeHeader(fset, ancestor)
		case *ast.ValueSpec, *ast.GenDecl:
			return render(fset, ancestor)
		}
	}
	return "<unknown>"
}

func rangeHeader(fset *token.FileSet, statement *ast.RangeStmt) string {
	assignment := ""
	if statement.Key != nil {
		assignment = render(fset, statement.Key)
		if statement.Value != nil {
			assignment += ", " + render(fset, statement.Value)
		}
		assignment += " " + statement.Tok.String() + " "
	}
	return "for " + assignment + "range " + render(fset, statement.X)
}

func inspect(root ast.Node, visit func(ast.Node, []ast.Node)) {
	stack := []ast.Node{}
	ast.Inspect(root, func(node ast.Node) bool {
		if node == nil {
			stack = stack[:len(stack)-1]
			return false
		}
		visit(node, stack)
		stack = append(stack, node)
		return true
	})
}

func render(fset *token.FileSet, node any) string {
	var output bytes.Buffer
	if err := format.Node(&output, fset, node); err != nil {
		fatalf("format AST node: %v", err)
	}
	return strings.TrimSpace(output.String())
}

func sortInventory(result *inventory) {
	sort.Slice(result.EnvironmentImports, func(left, right int) bool {
		a := result.EnvironmentImports[left]
		b := result.EnvironmentImports[right]
		return a.Path+"\x00"+a.ImportPath+"\x00"+a.Name+"\x00"+a.Literal <
			b.Path+"\x00"+b.ImportPath+"\x00"+b.Name+"\x00"+b.Literal
	})
	sort.Slice(result.EnvironmentAccesses, func(left, right int) bool {
		a := result.EnvironmentAccesses[left]
		b := result.EnvironmentAccesses[right]
		return a.Path+"\x00"+a.Identifier+"\x00"+a.Kind+"\x00"+a.Key+"\x00"+a.Consumer <
			b.Path+"\x00"+b.Identifier+"\x00"+b.Kind+"\x00"+b.Key+"\x00"+b.Consumer
	})
	for index := range result.LookupParameters {
		sort.Slice(result.LookupParameters[index].Uses, func(left, right int) bool {
			a := result.LookupParameters[index].Uses[left]
			b := result.LookupParameters[index].Uses[right]
			return a.Kind+"\x00"+a.Expression < b.Kind+"\x00"+b.Expression
		})
	}
	sort.Slice(result.LookupParameters, func(left, right int) bool {
		a := result.LookupParameters[left]
		b := result.LookupParameters[right]
		return a.Path+"\x00"+a.Function+"\x00"+a.Name < b.Path+"\x00"+b.Function+"\x00"+b.Name
	})
	sort.Strings(result.Config.ReaderMethods)
	sort.Slice(result.Config.LoadAccesses, func(left, right int) bool {
		a := result.Config.LoadAccesses[left]
		b := result.Config.LoadAccesses[right]
		return a.Member+"\x00"+a.Receiver+"\x00"+a.Kind+"\x00"+a.Key <
			b.Member+"\x00"+b.Receiver+"\x00"+b.Kind+"\x00"+b.Key
	})
	sort.Slice(result.Config.LookupAccesses, func(left, right int) bool {
		a := result.Config.LookupAccesses[left]
		b := result.Config.LookupAccesses[right]
		return a.Function+"\x00"+a.Receiver+"\x00"+a.Kind+"\x00"+a.Key <
			b.Function+"\x00"+b.Receiver+"\x00"+b.Kind+"\x00"+b.Key
	})
}

func fatalf(format string, arguments ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", arguments...)
	os.Exit(1)
}
