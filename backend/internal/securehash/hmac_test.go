package securehash

import (
	"encoding/hex"
	"testing"
)

func TestHMACSHA256(t *testing.T) {
	t.Parallel()

	got := hex.EncodeToString(HMACSHA256([]byte("key"), []byte("message")))
	const want = "6e9ef29b75fffc5b7abae527d58fdadb2fe42e7219011976917343065f58ed4a"
	if got != want {
		t.Fatalf("HMACSHA256() = %q, want %q", got, want)
	}
}
