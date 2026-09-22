package contentcrypto

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"strings"

	"google.golang.org/api/cloudkms/v1"
	"google.golang.org/api/option"

	"github.com/fukamu/cycle/backend/internal/config"
)

type FixtureKMS struct {
	keyVersion string
	key        []byte
}

func NewFixtureKMS(keyVersion string, key []byte) (*FixtureKMS, error) {
	if keyVersion == "" || len(key) != 32 {
		return nil, fmt.Errorf("%w: invalid fixture KMS configuration", ErrKeyringInvariant)
	}
	return &FixtureKMS{keyVersion: keyVersion, key: append([]byte(nil), key...)}, nil
}

func (kms *FixtureKMS) ActiveKeyVersion(context.Context) (string, error) {
	return kms.keyVersion, nil
}

func (kms *FixtureKMS) Wrap(_ context.Context, keyVersion string, plaintext, aad []byte) ([]byte, error) {
	if keyVersion != kms.keyVersion {
		return nil, fmt.Errorf("%w: fixture key version mismatch", ErrKeyringInvariant)
	}
	block, err := aes.NewCipher(kms.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return append(nonce, gcm.Seal(nil, nonce, plaintext, aad)...), nil
}

func (kms *FixtureKMS) Unwrap(_ context.Context, keyVersion string, wrapped, aad []byte) ([]byte, error) {
	if keyVersion != kms.keyVersion {
		return nil, fmt.Errorf("%w: fixture key version mismatch", ErrKeyringInvariant)
	}
	block, err := aes.NewCipher(kms.key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(wrapped) < gcm.NonceSize()+gcm.Overhead() {
		return nil, fmt.Errorf("%w: fixture wrapped key is truncated", ErrIntegrity)
	}
	plaintext, err := gcm.Open(nil, wrapped[:gcm.NonceSize()], wrapped[gcm.NonceSize():], aad)
	if err != nil {
		return nil, fmt.Errorf("%w: fixture unwrap authentication failed", ErrIntegrity)
	}
	return plaintext, nil
}

type RawKMSAPI interface {
	RawEncrypt(context.Context, string, *cloudkms.RawEncryptRequest) (*cloudkms.RawEncryptResponse, error)
	RawDecrypt(context.Context, string, *cloudkms.RawDecryptRequest) (*cloudkms.RawDecryptResponse, error)
}

type googleRawKMSAPI struct{ service *cloudkms.Service }

func NewGoogleRawKMSAPI(service *cloudkms.Service) RawKMSAPI {
	return &googleRawKMSAPI{service: service}
}

func NewConfiguredKeyManagement(
	ctx context.Context,
	settings config.ContentEncryptionConfig,
) (KeyManagement, error) {
	switch settings.KMSProvider {
	case "fixture":
		return NewFixtureKMS(
			"fixture/projects/local/locations/local/keyRings/cycle/cryptoKeys/content/cryptoKeyVersions/1",
			[]byte("fukamu-cycle-local-fixture-key-1"),
		)
	case "gcp":
		service, err := cloudkms.NewService(
			ctx,
			option.WithCredentialsJSON([]byte(settings.GCPCredentialsJSON)),
		)
		if err != nil {
			return nil, ErrUnavailable
		}
		return NewGCPKMS(NewGoogleRawKMSAPI(service), settings.GCPKeyVersion)
	default:
		return nil, ErrKeyringInvariant
	}
}

func (api *googleRawKMSAPI) RawEncrypt(ctx context.Context, name string, request *cloudkms.RawEncryptRequest) (*cloudkms.RawEncryptResponse, error) {
	return api.service.Projects.Locations.KeyRings.CryptoKeys.CryptoKeyVersions.RawEncrypt(name, request).Context(ctx).Do()
}

func (api *googleRawKMSAPI) RawDecrypt(ctx context.Context, name string, request *cloudkms.RawDecryptRequest) (*cloudkms.RawDecryptResponse, error) {
	return api.service.Projects.Locations.KeyRings.CryptoKeys.CryptoKeyVersions.RawDecrypt(name, request).Context(ctx).Do()
}

type GCPKMS struct {
	api        RawKMSAPI
	keyVersion string
	parentKey  string
}

func NewGCPKMS(api RawKMSAPI, keyVersion string) (*GCPKMS, error) {
	parent, valid := gcpKMSKeyVersionParent(keyVersion)
	if api == nil || !valid {
		return nil, fmt.Errorf("%w: invalid GCP KMS key version", ErrKeyringInvariant)
	}
	return &GCPKMS{api: api, keyVersion: keyVersion, parentKey: parent}, nil
}

func gcpKMSKeyVersionParent(value string) (string, bool) {
	parts := strings.Split(value, "/")
	if len(parts) != 10 || parts[0] != "projects" || parts[2] != "locations" ||
		parts[4] != "keyRings" || parts[6] != "cryptoKeys" || parts[8] != "cryptoKeyVersions" {
		return "", false
	}
	for _, index := range []int{1, 3, 5, 7, 9} {
		if parts[index] == "" || strings.TrimSpace(parts[index]) != parts[index] {
			return "", false
		}
	}
	return strings.Join(parts[:8], "/"), true
}

func (kms *GCPKMS) ActiveKeyVersion(context.Context) (string, error) { return kms.keyVersion, nil }

type gcpWrappedDEK struct {
	Ciphertext           string `json:"ciphertext"`
	InitializationVector string `json:"initializationVector"`
	TagLength            int64  `json:"tagLength"`
}

func (kms *GCPKMS) Wrap(ctx context.Context, keyVersion string, plaintext, aad []byte) ([]byte, error) {
	if keyVersion != kms.keyVersion || !strings.HasPrefix(keyVersion, kms.parentKey+"/cryptoKeyVersions/") || len(plaintext) != 32 {
		return nil, fmt.Errorf("%w: GCP KMS wrap scope mismatch", ErrKeyringInvariant)
	}
	response, err := kms.api.RawEncrypt(ctx, keyVersion, &cloudkms.RawEncryptRequest{
		Plaintext:                         base64.StdEncoding.EncodeToString(plaintext),
		PlaintextCrc32c:                   crc32c(plaintext),
		AdditionalAuthenticatedData:       base64.StdEncoding.EncodeToString(aad),
		AdditionalAuthenticatedDataCrc32c: crc32c(aad),
	})
	if err != nil {
		return nil, fmt.Errorf("GCP KMS raw encrypt failed")
	}
	if response == nil || response.Name != keyVersion || response.TagLength != 16 ||
		!response.VerifiedPlaintextCrc32c || !response.VerifiedAdditionalAuthenticatedDataCrc32c {
		return nil, fmt.Errorf("%w: GCP KMS raw encrypt response verification", ErrIntegrity)
	}
	ciphertext, cipherErr := base64.StdEncoding.DecodeString(response.Ciphertext)
	iv, ivErr := base64.StdEncoding.DecodeString(response.InitializationVector)
	if cipherErr != nil || ivErr != nil || len(ciphertext) < 16 || len(iv) == 0 ||
		int64(crc32.Checksum(ciphertext, crc32.MakeTable(crc32.Castagnoli))) != response.CiphertextCrc32c ||
		int64(crc32.Checksum(iv, crc32.MakeTable(crc32.Castagnoli))) != response.InitializationVectorCrc32c {
		return nil, fmt.Errorf("%w: GCP KMS raw encrypt checksum", ErrIntegrity)
	}
	encoded, err := json.Marshal(gcpWrappedDEK{
		Ciphertext:           response.Ciphertext,
		InitializationVector: response.InitializationVector,
		TagLength:            response.TagLength,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: encode wrapped DEK", ErrUnavailable)
	}
	return encoded, nil
}

func (kms *GCPKMS) Unwrap(ctx context.Context, keyVersion string, wrapped, aad []byte) ([]byte, error) {
	parent, valid := gcpKMSKeyVersionParent(keyVersion)
	if !valid || parent != kms.parentKey {
		return nil, fmt.Errorf("%w: GCP KMS unwrap scope mismatch", ErrKeyringInvariant)
	}
	var record gcpWrappedDEK
	if err := strictJSON(wrapped, &record); err != nil || record.TagLength != 16 {
		return nil, fmt.Errorf("%w: invalid wrapped DEK", ErrIntegrity)
	}
	ciphertext, cipherErr := base64.StdEncoding.DecodeString(record.Ciphertext)
	iv, ivErr := base64.StdEncoding.DecodeString(record.InitializationVector)
	if cipherErr != nil || ivErr != nil || len(ciphertext) < 16 || len(iv) == 0 {
		return nil, fmt.Errorf("%w: invalid wrapped DEK encoding", ErrIntegrity)
	}
	response, err := kms.api.RawDecrypt(ctx, keyVersion, &cloudkms.RawDecryptRequest{
		Ciphertext:                        record.Ciphertext,
		CiphertextCrc32c:                  crc32c(ciphertext),
		InitializationVector:              record.InitializationVector,
		InitializationVectorCrc32c:        crc32c(iv),
		AdditionalAuthenticatedData:       base64.StdEncoding.EncodeToString(aad),
		AdditionalAuthenticatedDataCrc32c: crc32c(aad),
		TagLength:                         record.TagLength,
	})
	if err != nil {
		return nil, fmt.Errorf("GCP KMS raw decrypt failed")
	}
	if response == nil || !response.VerifiedCiphertextCrc32c ||
		!response.VerifiedInitializationVectorCrc32c || !response.VerifiedAdditionalAuthenticatedDataCrc32c {
		return nil, fmt.Errorf("%w: GCP KMS raw decrypt response verification", ErrIntegrity)
	}
	plaintext, err := base64.StdEncoding.DecodeString(response.Plaintext)
	if err != nil || len(plaintext) != 32 || crc32c(plaintext) != response.PlaintextCrc32c {
		return nil, fmt.Errorf("%w: GCP KMS raw decrypt checksum", ErrIntegrity)
	}
	return plaintext, nil
}

func crc32c(value []byte) int64 {
	return int64(crc32.Checksum(value, crc32.MakeTable(crc32.Castagnoli)))
}
