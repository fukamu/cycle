package contentcrypto

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"

	"google.golang.org/api/cloudkms/v1"
)

type fakeRawKMSAPI struct {
	rawEncrypt func(context.Context, string, *cloudkms.RawEncryptRequest) (*cloudkms.RawEncryptResponse, error)
	rawDecrypt func(context.Context, string, *cloudkms.RawDecryptRequest) (*cloudkms.RawDecryptResponse, error)
}

func (api *fakeRawKMSAPI) RawEncrypt(
	ctx context.Context,
	name string,
	request *cloudkms.RawEncryptRequest,
) (*cloudkms.RawEncryptResponse, error) {
	return api.rawEncrypt(ctx, name, request)
}

func (api *fakeRawKMSAPI) RawDecrypt(
	ctx context.Context,
	name string,
	request *cloudkms.RawDecryptRequest,
) (*cloudkms.RawDecryptResponse, error) {
	return api.rawDecrypt(ctx, name, request)
}

func TestGCPKMSVerifiesIntegrityAndReadsOlderVersionInSameKey(t *testing.T) {
	t.Parallel()
	const (
		activeVersion = "projects/project/locations/global/keyRings/ring/cryptoKeys/content/cryptoKeyVersions/3"
		oldVersion    = "projects/project/locations/global/keyRings/ring/cryptoKeys/content/cryptoKeyVersions/2"
	)
	dek := []byte("0123456789abcdef0123456789abcdef")
	aad := []byte("wrap-aad")
	ciphertext := bytes.Repeat([]byte{0x41}, 48)
	iv := bytes.Repeat([]byte{0x42}, 12)
	api := &fakeRawKMSAPI{}
	api.rawEncrypt = func(_ context.Context, name string, request *cloudkms.RawEncryptRequest) (*cloudkms.RawEncryptResponse, error) {
		if name != activeVersion || request.PlaintextCrc32c != crc32c(dek) ||
			request.AdditionalAuthenticatedDataCrc32c != crc32c(aad) {
			t.Fatal("raw encrypt request did not bind the exact key version and checksums")
		}
		return &cloudkms.RawEncryptResponse{
			Name: name, Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
			InitializationVector: base64.StdEncoding.EncodeToString(iv), TagLength: 16,
			CiphertextCrc32c: crc32c(ciphertext), InitializationVectorCrc32c: crc32c(iv),
			VerifiedPlaintextCrc32c: true, VerifiedAdditionalAuthenticatedDataCrc32c: true,
		}, nil
	}
	api.rawDecrypt = func(_ context.Context, name string, request *cloudkms.RawDecryptRequest) (*cloudkms.RawDecryptResponse, error) {
		if name != oldVersion || request.CiphertextCrc32c != crc32c(ciphertext) ||
			request.InitializationVectorCrc32c != crc32c(iv) ||
			request.AdditionalAuthenticatedDataCrc32c != crc32c(aad) || request.TagLength != 16 {
			t.Fatal("raw decrypt request did not bind the stored key version and checksums")
		}
		return &cloudkms.RawDecryptResponse{
			Plaintext: base64.StdEncoding.EncodeToString(dek), PlaintextCrc32c: crc32c(dek),
			VerifiedCiphertextCrc32c: true, VerifiedInitializationVectorCrc32c: true,
			VerifiedAdditionalAuthenticatedDataCrc32c: true,
		}, nil
	}
	kms, err := NewGCPKMS(api, activeVersion)
	if err != nil {
		t.Fatal(err)
	}
	wrapped, err := kms.Wrap(context.Background(), activeVersion, dek, aad)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = kms.Wrap(context.Background(), oldVersion, dek, aad); !errors.Is(err, ErrKeyringInvariant) {
		t.Fatalf("wrap with inactive KEK error = %v", err)
	}
	var record gcpWrappedDEK
	if err = strictJSON(wrapped, &record); err != nil {
		t.Fatal(err)
	}
	oldWrapped, err := encodeGCPWrappedDEK(record)
	if err != nil {
		t.Fatal(err)
	}
	unwrapped, err := kms.Unwrap(context.Background(), oldVersion, oldWrapped, aad)
	if err != nil || !bytes.Equal(unwrapped, dek) {
		t.Fatalf("old-version unwrap = %x, error = %v", unwrapped, err)
	}
	otherKey := "projects/project/locations/global/keyRings/ring/cryptoKeys/other/cryptoKeyVersions/2"
	if _, err = kms.Unwrap(context.Background(), otherKey, oldWrapped, aad); !errors.Is(err, ErrKeyringInvariant) {
		t.Fatalf("other-key unwrap error = %v", err)
	}
	if _, err = kms.Unwrap(context.Background(), oldVersion+"/extra", oldWrapped, aad); !errors.Is(err, ErrKeyringInvariant) {
		t.Fatalf("malformed-version unwrap error = %v", err)
	}
}

func TestNewGCPKMSRejectsNonExactKeyVersionResources(t *testing.T) {
	t.Parallel()

	api := &fakeRawKMSAPI{}
	for _, keyVersion := range []string{
		"projects/project/locations/global/keyRings/ring/cryptoKeys/content",
		"projects/project/locations/global/keyRings/ring/cryptoKeys/content/cryptoKeyVersions/1/extra",
		"projects/project/locations/global/keyRings/ring/cryptoKeys/content/cryptoKeyVersions/ 1",
	} {
		if _, err := NewGCPKMS(api, keyVersion); !errors.Is(err, ErrKeyringInvariant) {
			t.Fatalf("NewGCPKMS(%q) error = %v", keyVersion, err)
		}
	}
}

func TestGCPKMSRejectsUnverifiedOrCorruptResponses(t *testing.T) {
	t.Parallel()
	const version = "projects/project/locations/global/keyRings/ring/cryptoKeys/content/cryptoKeyVersions/1"
	api := &fakeRawKMSAPI{
		rawEncrypt: func(_ context.Context, name string, _ *cloudkms.RawEncryptRequest) (*cloudkms.RawEncryptResponse, error) {
			ciphertext := bytes.Repeat([]byte{1}, 32)
			iv := bytes.Repeat([]byte{2}, 12)
			return &cloudkms.RawEncryptResponse{
				Name: name, Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
				InitializationVector: base64.StdEncoding.EncodeToString(iv), TagLength: 16,
				CiphertextCrc32c: crc32c(ciphertext) + 1, InitializationVectorCrc32c: crc32c(iv),
				VerifiedPlaintextCrc32c: true, VerifiedAdditionalAuthenticatedDataCrc32c: true,
			}, nil
		},
		rawDecrypt: func(context.Context, string, *cloudkms.RawDecryptRequest) (*cloudkms.RawDecryptResponse, error) {
			t.Fatal("raw decrypt should not be called")
			return nil, nil
		},
	}
	kms, err := NewGCPKMS(api, version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = kms.Wrap(context.Background(), version, make([]byte, 32), []byte("aad")); !errors.Is(err, ErrIntegrity) {
		t.Fatalf("corrupt raw encrypt response error = %v", err)
	}
}

func encodeGCPWrappedDEK(record gcpWrappedDEK) ([]byte, error) {
	return json.Marshal(record)
}
