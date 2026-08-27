package identifier

import "testing"

func TestIsCanonicalUUIDv7(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "canonical", value: "0198c20b-7b95-7000-8000-000000000001", want: true},
		{name: "variant b", value: "0198c20b-7b95-7fff-bfff-ffffffffffff", want: true},
		{name: "uppercase", value: "0198C20B-7B95-7000-8000-000000000001"},
		{name: "version four", value: "123e4567-e89b-42d3-a456-426614174000"},
		{name: "invalid variant", value: "0198c20b-7b95-7000-7000-000000000001"},
		{name: "missing hyphens", value: "0198c20b7b9570008000000000000001"},
		{name: "non hex", value: "0198c20b-7b95-7000-8000-00000000000g"},
		{name: "empty"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := IsCanonicalUUIDv7(test.value); got != test.want {
				t.Fatalf("IsCanonicalUUIDv7(%q) = %t, want %t", test.value, got, test.want)
			}
		})
	}
}
