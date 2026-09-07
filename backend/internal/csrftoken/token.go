package csrftoken

import (
	"encoding/base64"
	"errors"

	"github.com/fukamu/cycle/backend/internal/identifier"
	"github.com/fukamu/cycle/backend/internal/securehash"
)

const (
	stableTokenContextV1 = "fukamu-csrf-token-v1"
	encodedTokenLength   = 43
	decodedTokenLength   = 32
)

// ErrSessionIDInvalid identifies a non-canonical Session identifier without
// including the rejected value.
var ErrSessionIDInvalid = errors.New("CSRF token Session ID is invalid")

// Derive returns the stable CSRF token for a Session under the v1 contract.
func Derive(key []byte, sessionID string) (string, error) {
	if !identifier.IsCanonicalUUIDv7(sessionID) {
		return "", ErrSessionIDInvalid
	}
	message := make([]byte, 0, len(stableTokenContextV1)+1+len(sessionID))
	message = append(message, stableTokenContextV1...)
	message = append(message, 0x00)
	message = append(message, sessionID...)
	digest := securehash.HMACSHA256(key, message)
	return base64.RawURLEncoding.EncodeToString(digest), nil
}

// IsValid reports whether value is the canonical wire representation of a
// 32-byte CSRF token.
func IsValid(value string) bool {
	if len(value) != encodedTokenLength {
		return false
	}
	for index := range value {
		character := value[index]
		if character >= 'a' && character <= 'z' ||
			character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' ||
			character == '-' || character == '_' {
			continue
		}
		return false
	}
	decoded, err := base64.RawURLEncoding.Strict().DecodeString(value)
	return err == nil && len(decoded) == decodedTokenLength &&
		base64.RawURLEncoding.EncodeToString(decoded) == value
}
