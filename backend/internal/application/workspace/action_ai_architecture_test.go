package workspace

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

var actionAIHighLevelOperations = []string{
	"GenerateAction",
	"RefineAction",
	"RunActionAI",
	"BeginActionAI",
	"FinishActionAI",
}

var actionAITxPrimitiveMethods = []string{
	"LockUser",
	"LockGoalWithCurrentVersion",
	"LockActionCycle",
	"ListAIContextCycles",
	"FindActionAIReplay",
	"LockExpiredGenerations",
	"SumLockedReservationsByMonth",
	"ReleaseBudgetReservationCAS",
	"ExpireGenerationCAS",
	"ExpireUsageCAS",
	"HasRunningCycleGeneration",
	"CountRollingUsage",
	"EnsureBudgetMonth",
	"LockBudgetMonth",
	"IncrementRateBucket",
	"ReserveBudgetCAS",
	"InsertActionAIGeneration",
	"InsertAcceptedUsage",
	"FindGenerationLocator",
	"LockActionAIGeneration",
	"ApplyActionAICAS",
	"TerminalizeActionAIGenerationCAS",
	"SettleBudgetCAS",
	"FinalizeUsageCAS",
	"FindUsageLocator",
	"LockUsage",
	"AddLateActualCostCAS",
	"FinalizeLateUsageCAS",
}

var genericAIProviderIdentifiers = map[string]bool{
	"AIProvider":        true,
	"AIProviderRequest": true,
	"AIProviderResult":  true,
	"ActionAIInput":     true,
}

var postgresAIPolicyIdentifiers = map[string]bool{
	"rollinglimit":          true,
	"monthlybudgetusd":      true,
	"reservationusd":        true,
	"leaseduration":         true,
	"ratehashkey":           true,
	"aiperuserminute":       true,
	"aipersessionminute":    true,
	"aiperipminute":         true,
	"goalpromptversion":     true,
	"generatepromptversion": true,
	"refinepromptversion":   true,
}

var postgresAIConfigMetadataFields = map[string]bool{
	"provider":      true,
	"model":         true,
	"promptversion": true,
}

func TestActionAIBoundaryIsOwnedByApplication(t *testing.T) {
	t.Parallel()

	application := parseProductionGoPackage(t, ".")
	postgresDirectory := filepath.Join("..", "..", "infrastructure", "postgres")
	postgres := parseProductionGoPackage(t, postgresDirectory)
	provider := parseProductionGoPackage(t, filepath.Join("..", "..", "infrastructure", "aiprovider"))
	promptRegistry := parseProductionGoPackage(t, filepath.Join("..", "..", "ai", "prompts"))
	server := parseProductionGoPackage(t, filepath.Join("..", "..", "..", "cmd", "server"))
	backend := parseActionAIProductionTree(t, filepath.Join("..", "..", ".."))

	t.Run("typed Unit of Work callback and narrow transaction primitives", func(t *testing.T) {
		assertActionAITransactionPorts(t, application)
	})
	t.Run("generic Store excludes Action AI commands", func(t *testing.T) {
		store := findInterfaceType(t, application, "Store")
		assertInterfaceFieldsExcludeActionAIOperations(t, application, "Store", store, make(map[*ast.InterfaceType]bool))
	})
	t.Run("Service Action entrypoints use Application transactions", func(t *testing.T) {
		assertActionAIEntrypointsUseUnitOfWork(t, application)
	})
	t.Run("Postgres excludes Action AI use case orchestration", func(t *testing.T) {
		assertPostgresExcludesActionAIOrchestration(t, postgres)
	})
	t.Run("Postgres implements one generic Action AI transaction adapter", func(t *testing.T) {
		assertPostgresActionAIUnitOfWorkAdapter(t, postgres)
	})
	t.Run("Postgres Store excludes AI policy and float budget control", func(t *testing.T) {
		assertPostgresExcludesAIPolicyControl(t, postgres)
	})
	t.Run("composition does not inject AI policy into Postgres", func(t *testing.T) {
		assertCompositionDoesNotInjectPostgresAIPolicy(t, server)
	})
	t.Run("provider boundary remains operation specific", func(t *testing.T) {
		assertTypedAIProviderPorts(t, application)
		assertNoGenericProviderExecute(t, application, provider)
		assertNoRawProviderOperationDispatch(t, provider)
	})
	t.Run("prompt registry uses the Domain operation type", func(t *testing.T) {
		assertPromptRegistryUsesTypedOperations(t, promptRegistry)
	})
	t.Run("production excludes legacy generic provider API", func(t *testing.T) {
		assertNoGenericAIProviderIdentifiers(t, backend)
	})
}

func assertPromptRegistryUsesTypedOperations(t *testing.T, prompts parsedGoPackage) {
	t.Helper()

	key := findStructType(t, prompts, "registryKey")
	typedOperation := false
	for _, field := range key.Fields.List {
		for _, name := range field.Names {
			if name.Name == "operation" && isSelectorType(field.Type, "domainai", "OperationType") {
				typedOperation = true
			}
		}
	}
	if !typedOperation {
		t.Fatal("prompt registryKey.operation must use domain/ai.OperationType")
	}
	for _, file := range prompts.files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Recv != nil || function.Name.Name != "lookup" {
				continue
			}
			parameters := fieldTypes(function.Type.Params)
			if len(parameters) != 2 || !isSelectorType(parameters[0], "domainai", "OperationType") ||
				!isIdentifierType(parameters[1], "string") {
				t.Fatal("prompt lookup must accept (domain/ai.OperationType, string)")
			}
			return
		}
	}
	t.Fatal("typed prompt lookup function is missing")
}

func assertPostgresExcludesAIPolicyControl(t *testing.T, postgres parsedGoPackage) {
	t.Helper()

	for path, file := range postgres.files {
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
				if typeSpec.Name.Name == "WorkspaceStoreSettings" {
					position := postgres.fileSet.Position(typeSpec.Pos())
					t.Errorf("Postgres production still defines WorkspaceStoreSettings in %s:%d", path, position.Line)
				}
				structType, ok := typeSpec.Type.(*ast.StructType)
				if !ok {
					continue
				}
				configLike := actionAIConfigLikeTypeName(typeSpec.Name.Name)
				for _, field := range structType.Fields.List {
					for _, name := range field.Names {
						normalized := strings.ToLower(name.Name)
						position := postgres.fileSet.Position(name.Pos())
						if typeSpec.Name.Name == "WorkspaceStore" && normalized == "settings" {
							t.Errorf("WorkspaceStore still owns settings in %s:%d", path, position.Line)
						}
						if postgresAIPolicyIdentifiers[normalized] {
							t.Errorf("Postgres production struct %s still owns AI policy field %s in %s:%d",
								typeSpec.Name.Name, name.Name, path, position.Line)
						}
						if configLike && postgresAIConfigMetadataFields[normalized] {
							t.Errorf("Postgres production config %s still owns AI metadata policy field %s in %s:%d",
								typeSpec.Name.Name, name.Name, path, position.Line)
						}
					}
					if len(field.Names) == 0 && actionAIConfigLikeTypeName(baseTypeName(field.Type)) && typeSpec.Name.Name == "WorkspaceStore" {
						position := postgres.fileSet.Position(field.Pos())
						t.Errorf("WorkspaceStore embeds production config %s in %s:%d", baseTypeName(field.Type), path, position.Line)
					}
				}
			}
		}
	}
}

func actionAIConfigLikeTypeName(name string) bool {
	normalized := strings.ToLower(name)
	return strings.Contains(normalized, "setting") || strings.Contains(normalized, "config") ||
		strings.Contains(normalized, "policy") || strings.Contains(normalized, "option")
}

func assertCompositionDoesNotInjectPostgresAIPolicy(t *testing.T, server parsedGoPackage) {
	t.Helper()

	constructorCalls := 0
	for path, file := range server.files {
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			selector, ok := call.Fun.(*ast.SelectorExpr)
			if !ok || selector.Sel.Name != "NewWorkspaceStore" {
				return true
			}
			qualifier, ok := selector.X.(*ast.Ident)
			if !ok || qualifier.Name != "postgres" {
				return true
			}
			constructorCalls++
			if len(call.Args) != 1 {
				position := server.fileSet.Position(call.Pos())
				t.Errorf("composition root passes %d arguments to postgres.NewWorkspaceStore in %s:%d; want only the database pool",
					len(call.Args), path, position.Line)
			}
			return true
		})
	}
	if constructorCalls != 1 {
		t.Errorf("composition root postgres.NewWorkspaceStore calls = %d, want exactly 1", constructorCalls)
	}
}

func assertActionAITransactionPorts(t *testing.T, application parsedGoPackage) {
	t.Helper()

	unitOfWork := findInterfaceType(t, application, "ActionAIUnitOfWork")
	if len(unitOfWork.Methods.List) != 1 {
		t.Fatalf("ActionAIUnitOfWork must expose only WithinActionAITransaction; got %d fields", len(unitOfWork.Methods.List))
	}
	transaction := findNamedInterfaceMethod(t, unitOfWork, "WithinActionAITransaction")
	function := transaction.Type.(*ast.FuncType)
	parameters := fieldTypes(function.Params)
	if len(parameters) != 2 || !isSelectorType(parameters[0], "context", "Context") {
		t.Fatalf("ActionAIUnitOfWork.WithinActionAITransaction parameters must start with context.Context; got %s",
			formatExpressionList(parameters))
	}
	callback, ok := parameters[1].(*ast.FuncType)
	if !ok {
		t.Fatalf("ActionAIUnitOfWork.WithinActionAITransaction second parameter must be func(ActionAITx) error; got %T", parameters[1])
	}
	callbackParameters := fieldTypes(callback.Params)
	if len(callbackParameters) != 1 || !isIdentifierType(callbackParameters[0], "ActionAITx") ||
		!returnsOnlyError(callback) || !returnsOnlyError(function) {
		t.Fatal("ActionAIUnitOfWork.WithinActionAITransaction must have signature (context.Context, func(ActionAITx) error) error")
	}

	tx := findInterfaceType(t, application, "ActionAITx")
	want := make(map[string]bool, len(actionAITxPrimitiveMethods))
	for _, name := range actionAITxPrimitiveMethods {
		want[name] = true
	}
	got := make(map[string]bool, len(tx.Methods.List))
	for _, field := range tx.Methods.List {
		if len(field.Names) != 1 {
			t.Fatal("ActionAITx must list its narrow primitives explicitly and must not embed another interface")
		}
		name := field.Names[0].Name
		method, ok := field.Type.(*ast.FuncType)
		if !ok {
			t.Fatalf("ActionAITx.%s must be a method", name)
		}
		got[name] = true
		if !want[name] {
			t.Errorf("ActionAITx exposes unexpected non-primitive method %s", name)
		}
		methodParameters := fieldTypes(method.Params)
		if len(methodParameters) == 0 || !isSelectorType(methodParameters[0], "context", "Context") {
			t.Errorf("ActionAITx.%s must be an owner-scoped SQL primitive starting with context.Context", name)
		}
		if actionAIExpressionContainsFuncType(method) {
			t.Errorf("ActionAITx.%s must not add a nested orchestration callback", name)
		}
	}
	for _, name := range actionAITxPrimitiveMethods {
		if !got[name] {
			t.Errorf("ActionAITx narrow primitive %s is missing", name)
		}
	}

	useCases := findStructType(t, application, "ActionAIUseCases")
	if !structHasFieldType(useCases, "ActionAIUnitOfWork") {
		t.Fatal("ActionAIUseCases must own ActionAIUnitOfWork")
	}
	service := findStructType(t, application, "Service")
	if !structHasFieldType(service, "ActionAIUseCases") {
		t.Fatal("Service must own typed ActionAIUseCases separately from its query Store")
	}
}

func actionAIExpressionContainsFuncType(expression ast.Expr) bool {
	found := false
	ast.Inspect(expression, func(node ast.Node) bool {
		if _, ok := node.(*ast.FuncType); ok && node != expression {
			found = true
			return false
		}
		return true
	})
	return found
}

func assertInterfaceFieldsExcludeActionAIOperations(
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
			if operation, found := matchingActionAIHighLevelOperation(name.Name); found {
				t.Errorf("%s still exposes high-level %s orchestration", interfaceName, operation)
			}
		}
		if len(field.Names) != 0 {
			continue
		}
		embedded := lookupTypeSpec(application, baseTypeName(field.Type))
		if embedded == nil {
			continue
		}
		if nested, ok := embedded.Type.(*ast.InterfaceType); ok {
			assertInterfaceFieldsExcludeActionAIOperations(t, application, interfaceName, nested, visited)
		}
	}
}

func assertActionAIEntrypointsUseUnitOfWork(t *testing.T, application parsedGoPackage) {
	t.Helper()

	functions := indexApplicationFunctions(application)
	fields := indexApplicationStructFields(application)
	for _, entrypoint := range []string{"GenerateAction", "RefineAction"} {
		key := applicationFunctionKey{receiver: "Service", name: entrypoint}
		if functions[key] == nil {
			t.Errorf("Application entrypoint (*Service).%s is missing", entrypoint)
			continue
		}
		count := countReachableNamedCalls(key, "WithinActionAITransaction", functions, fields, make(map[applicationFunctionKey]bool))
		if count != 2 {
			t.Errorf("(*Service).%s reaches WithinActionAITransaction %d times, want one start and one finish transaction", entrypoint, count)
		}
	}
}

func assertPostgresExcludesActionAIOrchestration(t *testing.T, postgres parsedGoPackage) {
	t.Helper()

	applicationLevelTypes := map[string]bool{
		"AISnapshot":          true,
		"AIResponse":          true,
		"AIExecutionResult":   true,
		"ActionGenerateInput": true,
		"ActionRefineInput":   true,
		"ActionAIInput":       true,
		"AIProviderRequest":   true,
		"AIProviderResult":    true,
	}
	for path, file := range postgres.files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok {
				continue
			}
			position := postgres.fileSet.Position(function.Pos())
			if operation, found := matchingActionAIHighLevelOperation(function.Name.Name); found {
				t.Errorf("Postgres production still owns %s orchestration in %s:%d", operation, path, position.Line)
			}
			ast.Inspect(function.Type, func(node ast.Node) bool {
				selector, ok := node.(*ast.SelectorExpr)
				if ok && applicationLevelTypes[selector.Sel.Name] {
					t.Errorf("Postgres production function %s still crosses the use-case boundary with %s in %s:%d",
						function.Name.Name, selector.Sel.Name, path, position.Line)
				}
				return true
			})
		}
	}
}

func assertPostgresActionAIUnitOfWorkAdapter(t *testing.T, postgres parsedGoPackage) {
	t.Helper()

	var adapter *ast.FuncDecl
	for _, file := range postgres.files {
		for _, declaration := range file.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if ok && function.Recv != nil && function.Name.Name == "WithinActionAITransaction" {
				if adapter != nil {
					t.Fatal("Postgres must have exactly one WithinActionAITransaction adapter")
				}
				adapter = function
			}
		}
	}
	if adapter == nil {
		t.Fatal("Postgres must implement ActionAIUnitOfWork with WithinActionAITransaction")
	}

	beginCalls, commitCalls, callbackCalls, databaseCalls, readCommitted := 0, 0, 0, 0, false
	callbackNames := functionParameterNamesOfType(adapter.Type, func(expression ast.Expr) bool {
		_, ok := expression.(*ast.FuncType)
		return ok
	})
	ast.Inspect(adapter.Body, func(node ast.Node) bool {
		switch current := node.(type) {
		case *ast.CallExpr:
			switch called := current.Fun.(type) {
			case *ast.SelectorExpr:
				switch called.Sel.Name {
				case "BeginTx":
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
		case *ast.SelectorExpr:
			if qualifier, ok := current.X.(*ast.Ident); ok && qualifier.Name == "pgx" && current.Sel.Name == "ReadCommitted" {
				readCommitted = true
			}
		}
		return true
	})
	if beginCalls != 1 || commitCalls != 1 || callbackCalls != 1 || !readCommitted {
		t.Fatalf("WithinActionAITransaction BeginTx/callback/commit/READ COMMITTED = %d/%d/%d/%v, want 1/1/1/true",
			beginCalls, callbackCalls, commitCalls, readCommitted)
	}
	if databaseCalls != 0 {
		t.Fatalf("WithinActionAITransaction contains %d SQL calls; SQL belongs in ActionAITx primitives", databaseCalls)
	}
}

func assertTypedAIProviderPorts(t *testing.T, application parsedGoPackage) {
	t.Helper()

	goalRefiner := findInterfaceType(t, application, "GoalRefiner")
	assertExactInterfaceMethods(t, goalRefiner, []string{"RefineGoal"})
	assertTypedProviderMethodSignature(t, findNamedInterfaceMethod(t, goalRefiner, "RefineGoal"),
		"RefineGoalAIInput", "GoalRefineAIResult")
	actionGenerator := findInterfaceType(t, application, "ActionGenerator")
	assertExactInterfaceMethods(t, actionGenerator, []string{"GenerateAction", "RefineAction"})
	assertTypedProviderMethodSignature(t, findNamedInterfaceMethod(t, actionGenerator, "GenerateAction"),
		"GenerateActionAIInput", "GenerateActionAIResult")
	assertTypedProviderMethodSignature(t, findNamedInterfaceMethod(t, actionGenerator, "RefineAction"),
		"RefineActionAIInput", "RefineActionAIResult")
	for _, name := range []string{"RefineGoalAIInput", "GenerateActionAIInput", "RefineActionAIInput"} {
		input := findStructType(t, application, name)
		if _, exists := namedStructFieldTypes(input)["Operation"]; exists {
			t.Errorf("typed provider input %s must not carry a raw Operation dispatch field", name)
		}
	}
	observation := findStructType(t, application, "AIObservation")
	typedObservation := false
	for _, field := range observation.Fields.List {
		for _, name := range field.Names {
			if name.Name == "Operation" && isSelectorType(field.Type, "domainai", "OperationType") {
				typedObservation = true
			}
		}
	}
	if !typedObservation {
		t.Error("AIObservation.Operation must preserve domain/ai.OperationType until the metrics adapter")
	}
}

func assertTypedProviderMethodSignature(t *testing.T, method *ast.Field, inputType, resultType string) {
	t.Helper()

	function := method.Type.(*ast.FuncType)
	parameters := fieldTypes(function.Params)
	results := fieldTypes(function.Results)
	if len(parameters) != 2 || !isSelectorType(parameters[0], "context", "Context") ||
		!isIdentifierType(parameters[1], inputType) {
		t.Errorf("typed provider method must accept (context.Context, %s)", inputType)
	}
	if len(results) != 3 || !isIdentifierType(results[0], resultType) ||
		!isIdentifierType(results[1], "AIUsage") || !isIdentifierType(results[2], "error") {
		t.Errorf("typed provider method must return (%s, AIUsage, error)", resultType)
	}
}

func assertExactInterfaceMethods(t *testing.T, interfaceType *ast.InterfaceType, expected []string) {
	t.Helper()

	want := make(map[string]bool, len(expected))
	for _, name := range expected {
		want[name] = true
	}
	got := make(map[string]bool, len(interfaceType.Methods.List))
	for _, field := range interfaceType.Methods.List {
		if len(field.Names) != 1 {
			t.Fatal("typed provider ports must declare their operation-specific methods explicitly")
		}
		name := field.Names[0].Name
		got[name] = true
		if !want[name] {
			t.Errorf("typed provider port exposes unexpected method %s", name)
		}
	}
	for _, name := range expected {
		if !got[name] {
			t.Errorf("typed provider port method %s is missing", name)
		}
	}
}

func assertNoGenericProviderExecute(t *testing.T, packages ...parsedGoPackage) {
	t.Helper()

	for _, parsed := range packages {
		for path, file := range parsed.files {
			ast.Inspect(file, func(node ast.Node) bool {
				switch current := node.(type) {
				case *ast.FuncDecl:
					if current.Name.Name == "Execute" {
						position := parsed.fileSet.Position(current.Pos())
						t.Errorf("generic provider Execute method returned in %s:%d", path, position.Line)
					}
				case *ast.CallExpr:
					if selector, ok := current.Fun.(*ast.SelectorExpr); ok && selector.Sel.Name == "Execute" {
						position := parsed.fileSet.Position(current.Pos())
						t.Errorf("generic provider Execute dispatch returned in %s:%d", path, position.Line)
					}
				}
				return true
			})
		}
	}
}

func assertNoRawProviderOperationDispatch(t *testing.T, provider parsedGoPackage) {
	t.Helper()

	for path, file := range provider.files {
		ast.Inspect(file, func(node ast.Node) bool {
			switch current := node.(type) {
			case *ast.Field:
				for _, name := range current.Names {
					if name.Name == "Operation" {
						position := provider.fileSet.Position(name.Pos())
						t.Errorf("raw provider Operation field returned in %s:%d", path, position.Line)
					}
				}
			case *ast.SwitchStmt:
				if actionAIContainsOperationSelector(current.Tag) {
					position := provider.fileSet.Position(current.Pos())
					t.Errorf("raw provider Operation switch returned in %s:%d", path, position.Line)
				}
			}
			return true
		})
	}
}

func actionAIContainsOperationSelector(expression ast.Expr) bool {
	if expression == nil {
		return false
	}
	found := false
	ast.Inspect(expression, func(node ast.Node) bool {
		selector, ok := node.(*ast.SelectorExpr)
		if ok && selector.Sel.Name == "Operation" {
			found = true
			return false
		}
		return true
	})
	return found
}

func assertNoGenericAIProviderIdentifiers(t *testing.T, backend parsedGoPackage) {
	t.Helper()

	for path, file := range backend.files {
		ast.Inspect(file, func(node ast.Node) bool {
			identifier, ok := node.(*ast.Ident)
			if !ok || !genericAIProviderIdentifiers[identifier.Name] {
				return true
			}
			position := backend.fileSet.Position(identifier.Pos())
			t.Errorf("legacy generic AI identifier %s remains in production source %s:%d", identifier.Name, path, position.Line)
			return true
		})
	}
}

func parseActionAIProductionTree(t *testing.T, root string) parsedGoPackage {
	t.Helper()

	fileSet := token.NewFileSet()
	files := make(map[string]*ast.File)
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if entry.Name() == "testdata" || entry.Name() == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(entry.Name(), ".go") || strings.HasSuffix(entry.Name(), "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(fileSet, path, nil, 0)
		if err != nil {
			return err
		}
		files[path] = file
		return nil
	})
	if err != nil {
		t.Fatalf("parse production Go tree %s: %v", root, err)
	}
	if len(files) == 0 {
		t.Fatalf("no production Go files found in %s", root)
	}
	return parsedGoPackage{files: files, fileSet: fileSet}
}

func matchingActionAIHighLevelOperation(name string) (string, bool) {
	for _, operation := range actionAIHighLevelOperations {
		if strings.EqualFold(name, operation) {
			return operation, true
		}
	}
	return "", false
}
