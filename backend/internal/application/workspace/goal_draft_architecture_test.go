package workspace

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// AbandonDraft remains on the unchanged Store path until the quota-retention decision recorded in the ExecPlan is resolved.
var goalDraftHighLevelCommands = []string{
	"CreateDraft",
	"SaveDraft",
	"SaveReview",
	"StartGoal",
	"BeginGoalRefine",
	"FinishGoalRefine",
	"AdoptGoalSuggestion",
}

func TestGoalDraftStartTransactionBoundaryIsOwnedByApplication(t *testing.T) {
	t.Parallel()

	application := parseProductionGoPackage(t, ".")
	postgresDirectory := filepath.Join("..", "..", "infrastructure", "postgres")
	postgres := parseProductionGoPackage(t, postgresDirectory)
	postgresWithTests := parseAllGoPackage(t, postgresDirectory)

	t.Run("typed Unit of Work port", func(t *testing.T) {
		assertGoalDraftUnitOfWorkPort(t, application)
	})
	t.Run("query Store excludes commands", func(t *testing.T) {
		assertInterfaceExcludesGoalDraftCommands(t, application, "Store")
	})
	t.Run("Application entrypoints enter Unit of Work", func(t *testing.T) {
		assertGoalDraftEntrypointsUseUnitOfWork(t, application)
	})
	t.Run("Postgres excludes use case orchestration", func(t *testing.T) {
		assertPostgresExcludesGoalDraftCommands(t, postgres)
	})
	t.Run("Postgres tests do not reattach commands to WorkspaceStore", func(t *testing.T) {
		assertWorkspaceStoreReceiverExcludesGoalDraftCommands(t, postgresWithTests)
	})
	t.Run("Postgres implements only the generic transaction adapter", func(t *testing.T) {
		assertPostgresGoalDraftUnitOfWorkAdapter(t, postgres)
	})
}

type parsedGoPackage struct {
	files   map[string]*ast.File
	fileSet *token.FileSet
}

func parseProductionGoPackage(t *testing.T, directory string) parsedGoPackage {
	t.Helper()
	return parseGoPackage(t, directory, false)
}

func parseAllGoPackage(t *testing.T, directory string) parsedGoPackage {
	t.Helper()
	return parseGoPackage(t, directory, true)
}

func parseGoPackage(t *testing.T, directory string, includeTests bool) parsedGoPackage {
	t.Helper()

	fileSet := token.NewFileSet()
	files := make(map[string]*ast.File)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read %s: %v", directory, err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") ||
			(!includeTests && strings.HasSuffix(entry.Name(), "_test.go")) {
			continue
		}
		path := filepath.Join(directory, entry.Name())
		file, parseErr := parser.ParseFile(fileSet, path, nil, 0)
		if parseErr != nil {
			t.Fatalf("parse %s: %v", path, parseErr)
		}
		files[path] = file
	}
	if len(files) == 0 {
		t.Fatalf("no production Go files found in %s", directory)
	}
	return parsedGoPackage{files: files, fileSet: fileSet}
}

func assertGoalDraftUnitOfWorkPort(t *testing.T, application parsedGoPackage) {
	t.Helper()

	unitOfWork := findInterfaceType(t, application, "GoalDraftUnitOfWork")
	transaction := findNamedInterfaceMethod(t, unitOfWork, "WithinGoalDraftTransaction")
	parameters := fieldTypes(transaction.Type.(*ast.FuncType).Params)
	if len(parameters) != 2 || !isSelectorType(parameters[0], "context", "Context") {
		t.Fatalf("GoalDraftUnitOfWork.WithinGoalDraftTransaction parameters must start with context.Context; got %s",
			formatExpressionList(parameters))
	}
	callback, ok := parameters[1].(*ast.FuncType)
	if !ok {
		t.Fatalf("GoalDraftUnitOfWork.WithinGoalDraftTransaction second parameter must be func(GoalDraftTx) error; got %T", parameters[1])
	}
	callbackParameters := fieldTypes(callback.Params)
	if len(callbackParameters) != 1 || !isIdentifierType(callbackParameters[0], "GoalDraftTx") || !returnsOnlyError(callback) {
		t.Fatal("GoalDraftUnitOfWork.WithinGoalDraftTransaction callback must have signature func(GoalDraftTx) error")
	}
	if !returnsOnlyError(transaction.Type.(*ast.FuncType)) {
		t.Fatal("GoalDraftUnitOfWork.WithinGoalDraftTransaction must return only error")
	}

	transactionPort := findInterfaceType(t, application, "GoalDraftTx")
	if len(transactionPort.Methods.List) == 0 {
		t.Fatal("GoalDraftTx must expose narrow SQL/lock primitives")
	}
	assertInterfaceFieldsExcludeGoalDraftCommands(t, application, "GoalDraftTx", transactionPort, make(map[*ast.InterfaceType]bool))

	useCases := findStructType(t, application, "GoalDraftUseCases")
	if !structHasFieldType(useCases, "GoalDraftUnitOfWork") {
		t.Fatal("GoalDraftUseCases must own GoalDraftUnitOfWork")
	}
	service := findStructType(t, application, "Service")
	if !structHasFieldType(service, "GoalDraftUseCases") {
		t.Fatal("Service must depend on typed GoalDraftUseCases separately from its query Store")
	}
}

func assertInterfaceExcludesGoalDraftCommands(t *testing.T, application parsedGoPackage, interfaceName string) {
	t.Helper()
	interfaceType := findInterfaceType(t, application, interfaceName)
	assertInterfaceFieldsExcludeGoalDraftCommands(t, application, interfaceName, interfaceType, make(map[*ast.InterfaceType]bool))
}

func assertInterfaceFieldsExcludeGoalDraftCommands(
	t *testing.T,
	application parsedGoPackage,
	interfaceName string,
	interfaceType *ast.InterfaceType,
	visited map[*ast.InterfaceType]bool,
) {
	t.Helper()
	if visited[interfaceType] {
		return
	}
	visited[interfaceType] = true
	for _, field := range interfaceType.Methods.List {
		for _, name := range field.Names {
			if command, found := matchingGoalDraftCommand(name.Name); found {
				t.Errorf("%s still exposes high-level %s orchestration", interfaceName, command)
			}
		}
		if len(field.Names) != 0 {
			continue
		}
		embeddedName := baseTypeName(field.Type)
		embeddedSpec := lookupTypeSpec(application, embeddedName)
		if embeddedSpec == nil {
			continue
		}
		embeddedInterface, ok := embeddedSpec.Type.(*ast.InterfaceType)
		if ok {
			assertInterfaceFieldsExcludeGoalDraftCommands(t, application, interfaceName, embeddedInterface, visited)
		}
	}
}

func assertGoalDraftEntrypointsUseUnitOfWork(t *testing.T, application parsedGoPackage) {
	t.Helper()

	functions := indexApplicationFunctions(application)
	structFields := indexApplicationStructFields(application)
	expectedTransactions := map[string]int{
		"CreateDraft":         1,
		"SaveDraft":           1,
		"SaveReview":          1,
		"StartGoal":           1,
		"RefineGoal":          2,
		"AdoptGoalSuggestion": 1,
	}
	for entrypoint, minimum := range expectedTransactions {
		key := applicationFunctionKey{receiver: "Service", name: entrypoint}
		if functions[key] == nil {
			t.Errorf("Application entrypoint (*Service).%s is missing", entrypoint)
			continue
		}
		count := countReachableTransactionCalls(key, functions, structFields, make(map[applicationFunctionKey]bool))
		if count < minimum {
			t.Errorf("(*Service).%s reaches WithinGoalDraftTransaction %d times, want at least %d", entrypoint, count, minimum)
		}
	}
}

type applicationFunctionKey struct {
	receiver string
	name     string
}

type applicationFunction struct {
	declaration  *ast.FuncDecl
	receiverName string
}

func indexApplicationFunctions(application parsedGoPackage) map[applicationFunctionKey]*applicationFunction {
	functions := make(map[applicationFunctionKey]*applicationFunction)
	for _, file := range application.files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Body == nil {
				continue
			}
			key := applicationFunctionKey{name: function.Name.Name}
			receiverName := ""
			if function.Recv != nil && len(function.Recv.List) == 1 {
				key.receiver = baseTypeName(function.Recv.List[0].Type)
				if len(function.Recv.List[0].Names) == 1 {
					receiverName = function.Recv.List[0].Names[0].Name
				}
			}
			functions[key] = &applicationFunction{declaration: function, receiverName: receiverName}
		}
	}
	return functions
}

func indexApplicationStructFields(application parsedGoPackage) map[string]map[string]string {
	fields := make(map[string]map[string]string)
	for _, file := range application.files {
		for _, declaration := range file.Decls {
			general, ok := declaration.(*ast.GenDecl)
			if !ok || general.Tok != token.TYPE {
				continue
			}
			for _, specification := range general.Specs {
				typeSpec, ok := specification.(*ast.TypeSpec)
				if !ok {
					continue
				}
				structType, ok := typeSpec.Type.(*ast.StructType)
				if ok {
					fields[typeSpec.Name.Name] = namedStructFieldTypes(structType)
				}
			}
		}
	}
	return fields
}

func countReachableTransactionCalls(
	key applicationFunctionKey,
	functions map[applicationFunctionKey]*applicationFunction,
	structFields map[string]map[string]string,
	active map[applicationFunctionKey]bool,
) int {
	if active[key] {
		return 0
	}
	function := functions[key]
	if function == nil {
		return 0
	}
	active[key] = true
	defer delete(active, key)

	count := 0
	var callees []applicationFunctionKey
	ast.Inspect(function.declaration.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch called := call.Fun.(type) {
		case *ast.SelectorExpr:
			if called.Sel.Name == "WithinGoalDraftTransaction" {
				count++
				return true
			}
			switch receiver := called.X.(type) {
			case *ast.Ident:
				if function.receiverName != "" && receiver.Name == function.receiverName {
					callees = append(callees, applicationFunctionKey{receiver: key.receiver, name: called.Sel.Name})
				}
			case *ast.SelectorExpr:
				owner, ok := receiver.X.(*ast.Ident)
				if ok && function.receiverName != "" && owner.Name == function.receiverName {
					fieldType := structFields[key.receiver][receiver.Sel.Name]
					if fieldType != "" {
						callees = append(callees, applicationFunctionKey{receiver: fieldType, name: called.Sel.Name})
					}
				}
			}
		case *ast.Ident:
			callees = append(callees, applicationFunctionKey{name: called.Name})
		}
		return true
	})
	for _, callee := range callees {
		count += countReachableTransactionCalls(callee, functions, structFields, active)
	}
	return count
}

func structHasFieldType(structType *ast.StructType, typeName string) bool {
	for _, fieldType := range namedStructFieldTypes(structType) {
		if fieldType == typeName {
			return true
		}
	}
	return false
}

func namedStructFieldTypes(structType *ast.StructType) map[string]string {
	fields := make(map[string]string)
	for _, field := range structType.Fields.List {
		for _, name := range field.Names {
			fields[name.Name] = baseTypeName(field.Type)
		}
	}
	return fields
}

func assertPostgresExcludesGoalDraftCommands(t *testing.T, postgres parsedGoPackage) {
	t.Helper()

	for path, file := range postgres.files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok {
				continue
			}
			if command, found := matchingGoalDraftCommand(function.Name.Name); found {
				position := postgres.fileSet.Position(function.Pos())
				t.Errorf("Postgres production still owns %s orchestration in %s:%d", command, path, position.Line)
			}
		}
	}
}

func assertWorkspaceStoreReceiverExcludesGoalDraftCommands(t *testing.T, postgres parsedGoPackage) {
	t.Helper()

	for path, file := range postgres.files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv == nil || len(function.Recv.List) != 1 ||
				baseTypeName(function.Recv.List[0].Type) != "WorkspaceStore" {
				continue
			}
			if command, found := matchingGoalDraftCommand(function.Name.Name); found {
				position := postgres.fileSet.Position(function.Pos())
				t.Errorf("WorkspaceStore receiver reattaches high-level %s in %s:%d", command, path, position.Line)
			}
		}
	}
}

func assertPostgresGoalDraftUnitOfWorkAdapter(t *testing.T, postgres parsedGoPackage) {
	t.Helper()

	var adapter *ast.FuncDecl
	for _, file := range postgres.files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if ok && function.Recv != nil && function.Name.Name == "WithinGoalDraftTransaction" {
				if adapter != nil {
					t.Fatal("Postgres must have exactly one WithinGoalDraftTransaction adapter")
				}
				adapter = function
			}
		}
	}
	if adapter == nil {
		t.Fatal("Postgres must implement GoalDraftUnitOfWork with WithinGoalDraftTransaction")
	}

	beginCalls := 0
	commitCalls := 0
	callbackCalls := 0
	databaseCalls := 0
	callbackNames := functionParameterNamesOfType(adapter.Type, func(expression ast.Expr) bool {
		_, ok := expression.(*ast.FuncType)
		return ok
	})
	ast.Inspect(adapter.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		switch called := call.Fun.(type) {
		case *ast.SelectorExpr:
			switch called.Sel.Name {
			case "Begin", "BeginTx":
				beginCalls++
			case "Commit":
				commitCalls++
			case "Query", "QueryRow", "Exec", "SendBatch":
				databaseCalls++
			}
		case *ast.Ident:
			if callbackNames[called.Name] {
				callbackCalls++
			}
		}
		return true
	})
	if beginCalls != 1 || commitCalls != 1 || callbackCalls != 1 {
		t.Fatalf("WithinGoalDraftTransaction begin/callback/commit calls = %d/%d/%d, want 1/1/1", beginCalls, callbackCalls, commitCalls)
	}
	if databaseCalls != 0 {
		t.Fatalf("WithinGoalDraftTransaction contains %d SQL calls; orchestration belongs in Application and SQL belongs in GoalDraftTx primitives", databaseCalls)
	}
}

func findInterfaceType(t *testing.T, parsed parsedGoPackage, name string) *ast.InterfaceType {
	t.Helper()
	typeSpec := findTypeSpec(t, parsed, name)
	interfaceType, ok := typeSpec.Type.(*ast.InterfaceType)
	if !ok {
		t.Fatalf("%s must be an interface, got %T", name, typeSpec.Type)
	}
	return interfaceType
}

func findStructType(t *testing.T, parsed parsedGoPackage, name string) *ast.StructType {
	t.Helper()
	typeSpec := findTypeSpec(t, parsed, name)
	structType, ok := typeSpec.Type.(*ast.StructType)
	if !ok {
		t.Fatalf("%s must be a struct, got %T", name, typeSpec.Type)
	}
	return structType
}

func findTypeSpec(t *testing.T, parsed parsedGoPackage, name string) *ast.TypeSpec {
	t.Helper()
	typeSpec := lookupTypeSpec(parsed, name)
	if typeSpec != nil {
		return typeSpec
	}
	t.Fatalf("Application type %s is missing", name)
	return nil
}

func lookupTypeSpec(parsed parsedGoPackage, name string) *ast.TypeSpec {
	for _, file := range parsed.files {
		for _, declaration := range file.Decls {
			general, ok := declaration.(*ast.GenDecl)
			if !ok || general.Tok != token.TYPE {
				continue
			}
			for _, specification := range general.Specs {
				typeSpec, ok := specification.(*ast.TypeSpec)
				if ok && typeSpec.Name.Name == name {
					return typeSpec
				}
			}
		}
	}
	return nil
}

func findNamedInterfaceMethod(t *testing.T, interfaceType *ast.InterfaceType, name string) *ast.Field {
	t.Helper()
	for _, method := range interfaceType.Methods.List {
		if len(method.Names) == 1 && method.Names[0].Name == name {
			if _, ok := method.Type.(*ast.FuncType); !ok {
				t.Fatalf("%s must be an interface method", name)
			}
			return method
		}
	}
	t.Fatalf("interface method %s is missing", name)
	return nil
}

func fieldTypes(fields *ast.FieldList) []ast.Expr {
	if fields == nil {
		return nil
	}
	var expressions []ast.Expr
	for _, field := range fields.List {
		count := len(field.Names)
		if count == 0 {
			count = 1
		}
		for range count {
			expressions = append(expressions, field.Type)
		}
	}
	return expressions
}

func functionParameterNamesOfType(function *ast.FuncType, matches func(ast.Expr) bool) map[string]bool {
	names := make(map[string]bool)
	if function.Params == nil {
		return names
	}
	for _, field := range function.Params.List {
		if !matches(field.Type) {
			continue
		}
		for _, name := range field.Names {
			names[name.Name] = true
		}
	}
	return names
}

func returnsOnlyError(function *ast.FuncType) bool {
	results := fieldTypes(function.Results)
	return len(results) == 1 && isIdentifierType(results[0], "error")
}

func isIdentifierType(expression ast.Expr, name string) bool {
	identifier, ok := expression.(*ast.Ident)
	return ok && identifier.Name == name
}

func isSelectorType(expression ast.Expr, packageName, typeName string) bool {
	selector, ok := expression.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != typeName {
		return false
	}
	identifier, ok := selector.X.(*ast.Ident)
	return ok && identifier.Name == packageName
}

func baseTypeName(expression ast.Expr) string {
	switch expression := expression.(type) {
	case *ast.Ident:
		return expression.Name
	case *ast.StarExpr:
		return baseTypeName(expression.X)
	case *ast.IndexExpr:
		return baseTypeName(expression.X)
	case *ast.IndexListExpr:
		return baseTypeName(expression.X)
	default:
		return ""
	}
}

func matchingGoalDraftCommand(name string) (string, bool) {
	for _, command := range goalDraftHighLevelCommands {
		if strings.EqualFold(name, command) {
			return command, true
		}
	}
	return "", false
}

func formatExpressionList(expressions []ast.Expr) string {
	parts := make([]string, 0, len(expressions))
	for _, expression := range expressions {
		parts = append(parts, baseTypeName(expression))
	}
	return strings.Join(parts, ", ")
}
