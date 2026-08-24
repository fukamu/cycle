package postgres

import "testing"

func TestSQLOperation(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		statement string
		want      string
	}{
		{name: "sqlc comment", statement: "-- name: GetSession :one\nSELECT id FROM sessions", want: "select"},
		{name: "block comment", statement: "/* generated */ UPDATE sessions SET last_seen_at = now()", want: "update"},
		{name: "multiple comments", statement: "-- generated\n/* sqlc */\nDELETE FROM sessions", want: "delete"},
		{name: "plain statement", statement: "INSERT INTO users (id) VALUES ($1)", want: "insert"},
		{name: "line comment only", statement: "-- name: Missing", want: "query"},
		{name: "block comment only", statement: "/* generated */", want: "query"},
		{name: "empty", statement: "  ", want: "query"},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := sqlOperation(test.statement); got != test.want {
				t.Fatalf("sqlOperation() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestNormalizeObservedSQL(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		statement string
		want      string
	}{
		{
			name:      "sqlc owner lock",
			statement: "-- name: LockUser :one\nSELECT id FROM users WHERE id = $1::uuid FOR UPDATE",
			want:      "select id from users where id=$1 for update",
		},
		{
			name:      "typed comparison",
			statement: "/* generated */ UPDATE goals SET status = $1::text, revision = $2::bigint WHERE updated_at <= $3::timestamptz",
			want:      "update goals set status=$1,revision=$2 where updated_at<=$3",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := normalizeObservedSQL(test.statement); got != test.want {
				t.Fatalf("normalizeObservedSQL() = %q, want %q", got, test.want)
			}
		})
	}
}
