package csrftoken

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"testing"
)

func TestDeriveUsesStableV1Contract(t *testing.T) {
	t.Parallel()

	const sessionID = "0198c20b-7b95-7000-8000-000000000001"
	token, err := Derive([]byte("csrf-key"), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if token != "5EDL2zt0LvqlR_R__dige5KPoaFbtWvPHd0pLDyhfmM" {
		t.Fatalf("Derive() = %q", token)
	}
	if len(token) != 43 {
		t.Fatalf("token length = %d, want 43", len(token))
	}
	repeated, err := Derive([]byte("csrf-key"), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if repeated != token {
		t.Fatalf("repeated token = %q, want %q", repeated, token)
	}
	otherSession, err := Derive([]byte("csrf-key"), "0198c20b-7b95-7000-8000-000000000002")
	if err != nil {
		t.Fatal(err)
	}
	if otherSession == token {
		t.Fatal("different Session ID produced the same token")
	}
	otherKey, err := Derive([]byte("other-csrf-key"), sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if otherKey == token {
		t.Fatal("different key produced the same token")
	}

	message := append([]byte("fukamu-csrf-token-v1"), byte(0x00))
	message = append(message, []byte(sessionID)...)
	digest := hmac.New(sha256.New, []byte("csrf-key"))
	_, _ = digest.Write(message)
	byteLevelToken := base64.RawURLEncoding.EncodeToString(digest.Sum(nil))
	if byteLevelToken != token {
		t.Fatalf("byte-level token = %q, want %q", byteLevelToken, token)
	}
}

func TestDeriveRejectsNonCanonicalSessionID(t *testing.T) {
	t.Parallel()

	for _, sessionID := range []string{
		"",
		"0198C20B-7B95-7000-8000-000000000001",
		"0198c20b-7b95-4000-8000-000000000001",
		"not-a-session-id",
	} {
		t.Run(sessionID, func(t *testing.T) {
			token, err := Derive([]byte("csrf-key"), sessionID)
			if token != "" || !errors.Is(err, ErrSessionIDInvalid) {
				t.Fatalf("Derive(%q) = %q, %v", sessionID, token, err)
			}
		})
	}
}

func TestIsValidRequiresCanonicalRawBase64URLOf32Bytes(t *testing.T) {
	t.Parallel()

	valid, err := Derive([]byte("csrf-key"), "0198c20b-7b95-7000-8000-000000000001")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name  string
		value string
		want  bool
	}{
		{name: "valid", value: valid, want: true},
		{name: "empty", value: ""},
		{name: "padded", value: valid + "="},
		{name: "short", value: valid[:len(valid)-1]},
		{name: "standard base64 character", value: "+" + valid[1:]},
		{name: "noncanonical trailing bits", value: valid[:len(valid)-1] + "n"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := IsValid(test.value); got != test.want {
				t.Fatalf("IsValid(%q) = %t, want %t", test.value, got, test.want)
			}
		})
	}
}
