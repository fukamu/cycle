package postgres

import "strings"

// normalizeObservedSQL keeps concurrency barriers coupled to statement
// semantics instead of sqlc comments, explicit casts, or harmless spacing.
func normalizeObservedSQL(statement string) string {
	normalized := strings.ToLower(strings.Join(strings.Fields(sqlWithoutLeadingComments(statement)), " "))
	for _, cast := range []string{
		"::text[]", "::uuid[]", "::timestamptz", "::smallint", "::integer",
		"::bigint", "::numeric", "::boolean", "::bytea", "::uuid", "::text",
	} {
		normalized = strings.ReplaceAll(normalized, cast, "")
	}
	return strings.NewReplacer(
		", ", ",",
		" ,", ",",
		" <= ", "<=",
		" >= ", ">=",
		" <> ", "<>",
		" = ", "=",
		" < ", "<",
		" > ", ">",
	).Replace(normalized)
}
