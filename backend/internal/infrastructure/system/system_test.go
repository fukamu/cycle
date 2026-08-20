package system

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestRandomGenerator(t *testing.T) {
	t.Parallel()

	generator := RandomGenerator{}
	id, err := generator.NewID()
	if err != nil || len(id) != 36 || id[14] != '7' || !strings.ContainsRune("89ab", rune(id[19])) {
		t.Fatalf("NewID() = %q, %v", id, err)
	}
	token, err := generator.NewToken(32)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(raw) != 32 {
		t.Fatalf("NewToken() bytes = %d, %v", len(raw), err)
	}
}
