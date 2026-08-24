package postgres

import (
	"crypto/sha256"
	"encoding/hex"
)

func sha256Hex(canonical []byte) string {
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:])
}
