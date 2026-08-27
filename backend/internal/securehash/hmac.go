package securehash

import (
	"crypto/hmac"
	"crypto/sha256"
)

func HMACSHA256(key, message []byte) []byte {
	digest := hmac.New(sha256.New, key)
	_, _ = digest.Write(message)
	return digest.Sum(nil)
}
