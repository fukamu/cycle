package contentcrypto

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

const (
	Format                = "fukamu-cycle-field-aes-256-gcm/v1"
	Algorithm             = "A256GCM"
	writeMarkerPrefix     = "~fukamu-cycle-content-write-v1~"
	encryptedMarkerPrefix = "~fukamu-cycle-content-encrypted-v1~"
	legacyMarkerPrefix    = "~fukamu-cycle-content-legacy~"
	maximumNonceAttempts  = 4
)

var (
	ErrUnavailable      = errors.New("content encryption unavailable")
	ErrIntegrity        = errors.New("content encryption integrity failure")
	ErrKeyNotFound      = errors.New("content encryption key not found")
	ErrKeyringInvariant = errors.New("content encryption keyring invariant failure")
)

type Scope struct {
	UserID         string
	ObjectType     string
	ObjectID       string
	Field          string
	CryptoRevision int64
}

type WrappedKey struct {
	UserID        string
	Version       int32
	KEKKeyVersion string
	WrappedDEK    []byte
	WriteKey      bool
	CreatedAt     time.Time
}

type KeyRepository interface {
	ActiveKey(context.Context, string) (WrappedKey, error)
	Key(context.Context, string, int32) (WrappedKey, error)
	StoreInitialKey(context.Context, WrappedKey) (WrappedKey, error)
	ReserveNonce(context.Context, string, int32, []byte, time.Time) (bool, error)
}

type KeyManagement interface {
	ActiveKeyVersion(context.Context) (string, error)
	Wrap(context.Context, string, []byte, []byte) ([]byte, error)
	Unwrap(context.Context, string, []byte, []byte) ([]byte, error)
}

type KeyRotationRepository interface {
	NextKeyVersion(context.Context, string) (int32, error)
	StoreRotatedKey(context.Context, WrappedKey) error
}

type Random interface {
	Read([]byte) (int, error)
}

type Service struct {
	repository KeyRepository
	kms        KeyManagement
	random     Random
	now        func() time.Time
	cache      *keyCache
}

func NewService(repository KeyRepository, kms KeyManagement) *Service {
	return NewServiceWithBoundaries(repository, kms, rand.Reader, time.Now)
}

func NewServiceWithBoundaries(repository KeyRepository, kms KeyManagement, random Random, now func() time.Time) *Service {
	return &Service{
		repository: repository,
		kms:        kms,
		random:     random,
		now:        now,
		cache:      newKeyCache(128, 30*time.Second),
	}
}

type envelope struct {
	Format         string `json:"format"`
	Algorithm      string `json:"algorithm"`
	DEKVersion     int32  `json:"dekVersion"`
	CryptoRevision int64  `json:"cryptoRevision"`
	Nonce          string `json:"nonce"`
	SealedPayload  string `json:"sealedPayload"`
}

type legacyEnvelope struct {
	Plaintext string `json:"plaintext"`
}

func (service *Service) Encrypt(ctx context.Context, scope Scope, plaintext string) (string, error) {
	if err := validateScope(scope, true); err != nil {
		return "", err
	}
	keyRecord, key, err := service.activeKey(ctx, scope.UserID)
	if err != nil {
		return "", err
	}
	defer zero(key)
	nonce, err := service.reserveNonce(ctx, scope.UserID, keyRecord.Version)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("%w: invalid data key", ErrKeyringInvariant)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("%w: initialize AES-GCM", ErrUnavailable)
	}
	aad, err := serializeAAD(scope, keyRecord.Version)
	if err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, nonce, []byte(plaintext), aad)
	encoded, err := json.Marshal(envelope{
		Format: Format, Algorithm: Algorithm, DEKVersion: keyRecord.Version,
		CryptoRevision: scope.CryptoRevision,
		Nonce:          base64.StdEncoding.EncodeToString(nonce),
		SealedPayload:  base64.StdEncoding.EncodeToString(sealed),
	})
	if err != nil {
		return "", fmt.Errorf("%w: encode envelope", ErrUnavailable)
	}
	return writeMarkerPrefix + string(encoded), nil
}

func (service *Service) Decrypt(ctx context.Context, scope Scope, stored string) (string, error) {
	if len(stored) >= len(legacyMarkerPrefix) && stored[:len(legacyMarkerPrefix)] == legacyMarkerPrefix {
		var decoded legacyEnvelope
		if err := strictJSON([]byte(stored[len(legacyMarkerPrefix):]), &decoded); err != nil {
			return "", fmt.Errorf("%w: invalid legacy storage wrapper", ErrIntegrity)
		}
		return decoded.Plaintext, nil
	}
	if len(stored) < len(encryptedMarkerPrefix) || stored[:len(encryptedMarkerPrefix)] != encryptedMarkerPrefix {
		return stored, nil
	}
	if err := validateScope(scope, false); err != nil {
		return "", err
	}
	var record envelope
	if err := strictJSON([]byte(stored[len(encryptedMarkerPrefix):]), &record); err != nil {
		return "", fmt.Errorf("%w: invalid encrypted storage wrapper", ErrIntegrity)
	}
	if record.Format != Format || record.Algorithm != Algorithm || record.DEKVersion < 1 || record.CryptoRevision < 1 {
		return "", fmt.Errorf("%w: unsupported encrypted storage format", ErrIntegrity)
	}
	nonce, err := base64.StdEncoding.DecodeString(record.Nonce)
	if err != nil || len(nonce) != 12 {
		return "", fmt.Errorf("%w: invalid nonce", ErrIntegrity)
	}
	sealed, err := base64.StdEncoding.DecodeString(record.SealedPayload)
	if err != nil || len(sealed) < 16 {
		return "", fmt.Errorf("%w: invalid sealed payload", ErrIntegrity)
	}
	key, err := service.key(ctx, scope.UserID, record.DEKVersion)
	if err != nil {
		return "", err
	}
	defer zero(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("%w: invalid data key", ErrKeyringInvariant)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("%w: initialize AES-GCM", ErrUnavailable)
	}
	scope.CryptoRevision = record.CryptoRevision
	aad, err := serializeAAD(scope, record.DEKVersion)
	if err != nil {
		return "", err
	}
	plaintext, err := gcm.Open(nil, nonce, sealed, aad)
	if err != nil {
		return "", fmt.Errorf("%w: authentication failed", ErrIntegrity)
	}
	return string(plaintext), nil
}

func IsEncryptedStorage(stored string) bool {
	return strings.HasPrefix(stored, encryptedMarkerPrefix)
}

func IsStorageMarker(stored string) bool {
	return strings.HasPrefix(stored, encryptedMarkerPrefix) || strings.HasPrefix(stored, legacyMarkerPrefix)
}

func (service *Service) Close() {
	if service != nil && service.cache != nil {
		service.cache.clear()
	}
}

func (service *Service) RotateUserKey(ctx context.Context, userID string) (int32, error) {
	if userID == "" {
		return 0, fmt.Errorf("%w: invalid User", ErrKeyringInvariant)
	}
	repository, ok := service.repository.(KeyRotationRepository)
	if !ok {
		return 0, fmt.Errorf("%w: key rotation is unsupported", ErrKeyringInvariant)
	}
	version, err := repository.NextKeyVersion(ctx, userID)
	if err != nil || version < 2 {
		return 0, fmt.Errorf("%w: resolve next data key version", ErrUnavailable)
	}
	dek := make([]byte, 32)
	if _, err = io.ReadFull(service.random, dek); err != nil {
		return 0, fmt.Errorf("%w: generate rotated data key", ErrUnavailable)
	}
	defer zero(dek)
	keyVersion, err := service.kms.ActiveKeyVersion(ctx)
	if err != nil || keyVersion == "" {
		return 0, fmt.Errorf("%w: resolve KMS key version", ErrUnavailable)
	}
	wrapAAD, err := serializeWrapAAD(userID, version, keyVersion)
	if err != nil {
		return 0, err
	}
	wrapped, err := service.kms.Wrap(ctx, keyVersion, dek, wrapAAD)
	if err != nil {
		return 0, fmt.Errorf("%w: wrap rotated data key", ErrUnavailable)
	}
	if err = repository.StoreRotatedKey(ctx, WrappedKey{
		UserID: userID, Version: version, KEKKeyVersion: keyVersion,
		WrappedDEK: wrapped, WriteKey: true, CreatedAt: service.now().UTC(),
	}); err != nil {
		return 0, err
	}
	service.cache.put(cacheKey(userID, version), dek, service.now())
	return version, nil
}

func (service *Service) activeKey(ctx context.Context, userID string) (WrappedKey, []byte, error) {
	record, err := service.repository.ActiveKey(ctx, userID)
	if errors.Is(err, ErrKeyNotFound) {
		return service.bootstrap(ctx, userID)
	}
	if err != nil {
		return WrappedKey{}, nil, fmt.Errorf("%w: load active key", ErrUnavailable)
	}
	key, err := service.unwrap(ctx, record)
	return record, key, err
}

func (service *Service) bootstrap(ctx context.Context, userID string) (WrappedKey, []byte, error) {
	dek := make([]byte, 32)
	if _, err := io.ReadFull(service.random, dek); err != nil {
		return WrappedKey{}, nil, fmt.Errorf("%w: generate data key", ErrUnavailable)
	}
	defer zero(dek)
	keyVersion, err := service.kms.ActiveKeyVersion(ctx)
	if err != nil || keyVersion == "" {
		return WrappedKey{}, nil, fmt.Errorf("%w: resolve KMS key version", ErrUnavailable)
	}
	wrapAAD, err := serializeWrapAAD(userID, 1, keyVersion)
	if err != nil {
		return WrappedKey{}, nil, err
	}
	wrapped, err := service.kms.Wrap(ctx, keyVersion, dek, wrapAAD)
	if err != nil {
		return WrappedKey{}, nil, fmt.Errorf("%w: wrap data key", ErrUnavailable)
	}
	canonical, err := service.repository.StoreInitialKey(ctx, WrappedKey{
		UserID: userID, Version: 1, KEKKeyVersion: keyVersion,
		WrappedDEK: wrapped, WriteKey: true, CreatedAt: service.now().UTC(),
	})
	if err != nil {
		return WrappedKey{}, nil, err
	}
	if canonical.Version == 1 && canonical.KEKKeyVersion == keyVersion && bytes.Equal(canonical.WrappedDEK, wrapped) {
		result := append([]byte(nil), dek...)
		service.cache.put(cacheKey(userID, canonical.Version), result, service.now())
		return canonical, result, nil
	}
	key, err := service.unwrap(ctx, canonical)
	return canonical, key, err
}

func (service *Service) key(ctx context.Context, userID string, version int32) ([]byte, error) {
	if cached, ok := service.cache.get(cacheKey(userID, version), service.now()); ok {
		return cached, nil
	}
	record, err := service.repository.Key(ctx, userID, version)
	if errors.Is(err, ErrKeyNotFound) {
		return nil, ErrKeyNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("%w: load data key version", ErrUnavailable)
	}
	return service.unwrap(ctx, record)
}

func (service *Service) unwrap(ctx context.Context, record WrappedKey) ([]byte, error) {
	if cached, ok := service.cache.get(cacheKey(record.UserID, record.Version), service.now()); ok {
		return cached, nil
	}
	aad, err := serializeWrapAAD(record.UserID, record.Version, record.KEKKeyVersion)
	if err != nil {
		return nil, err
	}
	dek, err := service.kms.Unwrap(ctx, record.KEKKeyVersion, record.WrappedDEK, aad)
	if err != nil {
		if errors.Is(err, ErrIntegrity) || errors.Is(err, ErrKeyringInvariant) {
			return nil, err
		}
		return nil, fmt.Errorf("%w: unwrap data key", ErrUnavailable)
	}
	if len(dek) != 32 {
		zero(dek)
		return nil, fmt.Errorf("%w: data key length", ErrKeyringInvariant)
	}
	service.cache.put(cacheKey(record.UserID, record.Version), dek, service.now())
	return append([]byte(nil), dek...), nil
}

func (service *Service) reserveNonce(ctx context.Context, userID string, version int32) ([]byte, error) {
	for attempt := 0; attempt < maximumNonceAttempts; attempt++ {
		nonce := make([]byte, 12)
		if _, err := io.ReadFull(service.random, nonce); err != nil {
			return nil, fmt.Errorf("%w: generate nonce", ErrUnavailable)
		}
		reserved, err := service.repository.ReserveNonce(ctx, userID, version, nonce, service.now().UTC())
		if err != nil {
			return nil, fmt.Errorf("%w: reserve nonce", ErrUnavailable)
		}
		if reserved {
			return nonce, nil
		}
	}
	return nil, fmt.Errorf("%w: nonce reservation exhausted", ErrUnavailable)
}

func validateScope(scope Scope, requireRevision bool) error {
	if scope.UserID == "" || scope.ObjectType == "" || scope.ObjectID == "" || scope.Field == "" ||
		(requireRevision && scope.CryptoRevision < 1) {
		return fmt.Errorf("%w: invalid content scope", ErrIntegrity)
	}
	return nil
}

func serializeAAD(scope Scope, version int32) ([]byte, error) {
	return json.Marshal([]any{
		"fukamu-cycle-content-aad/v1", scope.UserID, scope.ObjectType,
		scope.ObjectID, scope.Field, Format, version, scope.CryptoRevision,
	})
}

func serializeWrapAAD(userID string, version int32, keyVersion string) ([]byte, error) {
	if userID == "" || version < 1 || keyVersion == "" {
		return nil, fmt.Errorf("%w: invalid key wrap scope", ErrKeyringInvariant)
	}
	return json.Marshal([]any{"fukamu-cycle-dek-wrap/v1", userID, version, keyVersion})
}

func strictJSON(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON")
	}
	return nil
}

type cacheEntry struct {
	key       []byte
	expiresAt time.Time
	sequence  uint64
}
type keyCache struct {
	mutex    sync.Mutex
	entries  map[string]cacheEntry
	capacity int
	ttl      time.Duration
	sequence uint64
}

func newKeyCache(capacity int, ttl time.Duration) *keyCache {
	return &keyCache{entries: map[string]cacheEntry{}, capacity: capacity, ttl: ttl}
}
func cacheKey(userID string, version int32) string { return fmt.Sprintf("%s:%d", userID, version) }
func (cache *keyCache) get(key string, now time.Time) ([]byte, bool) {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	entry, ok := cache.entries[key]
	if !ok {
		return nil, false
	}
	if !now.Before(entry.expiresAt) {
		zero(entry.key)
		delete(cache.entries, key)
		return nil, false
	}
	cache.sequence++
	entry.sequence = cache.sequence
	cache.entries[key] = entry
	return append([]byte(nil), entry.key...), true
}
func (cache *keyCache) put(key string, value []byte, now time.Time) {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	if old, ok := cache.entries[key]; ok {
		zero(old.key)
	}
	cache.sequence++
	cache.entries[key] = cacheEntry{key: append([]byte(nil), value...), expiresAt: now.Add(cache.ttl), sequence: cache.sequence}
	for len(cache.entries) > cache.capacity {
		var oldest string
		var seq uint64 = ^uint64(0)
		for candidate, entry := range cache.entries {
			if entry.sequence < seq {
				oldest, seq = candidate, entry.sequence
			}
		}
		entry := cache.entries[oldest]
		zero(entry.key)
		delete(cache.entries, oldest)
	}
}
func (cache *keyCache) clear() {
	cache.mutex.Lock()
	defer cache.mutex.Unlock()
	for key, entry := range cache.entries {
		zero(entry.key)
		delete(cache.entries, key)
	}
}
func zero(value []byte) {
	for index := range value {
		value[index] = 0
	}
}
