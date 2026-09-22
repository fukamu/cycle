package contentcrypto

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

func TestCanonicalAADEncodingIsStable(t *testing.T) {
	t.Parallel()
	scope := Scope{
		UserID: "10000000-0000-7000-8000-000000000001", ObjectType: "pdca_cycles",
		ObjectID: "41000000-0000-7000-8000-000000000001", Field: "action", CryptoRevision: 7,
	}
	encoded, err := serializeAAD(scope, 3)
	if err != nil {
		t.Fatal(err)
	}
	want := `["fukamu-cycle-content-aad/v1","10000000-0000-7000-8000-000000000001","pdca_cycles","41000000-0000-7000-8000-000000000001","action","fukamu-cycle-field-aes-256-gcm/v1",3,7]`
	if string(encoded) != want {
		t.Fatalf("AAD = %s, want %s", encoded, want)
	}
}

type memoryKeyRepository struct {
	mutex        sync.Mutex
	keys         map[string]map[int32]WrappedKey
	active       map[string]int32
	reservations map[string]bool
}

func newMemoryKeyRepository() *memoryKeyRepository {
	return &memoryKeyRepository{
		keys: map[string]map[int32]WrappedKey{}, active: map[string]int32{}, reservations: map[string]bool{},
	}
}

func (repository *memoryKeyRepository) ActiveKey(_ context.Context, userID string) (WrappedKey, error) {
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	version := repository.active[userID]
	if version == 0 {
		return WrappedKey{}, ErrKeyNotFound
	}
	return repository.keys[userID][version], nil
}

func (repository *memoryKeyRepository) Key(_ context.Context, userID string, version int32) (WrappedKey, error) {
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	record, ok := repository.keys[userID][version]
	if !ok {
		return WrappedKey{}, ErrKeyNotFound
	}
	return record, nil
}

func (repository *memoryKeyRepository) StoreInitialKey(_ context.Context, candidate WrappedKey) (WrappedKey, error) {
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	if version := repository.active[candidate.UserID]; version != 0 {
		return repository.keys[candidate.UserID][version], nil
	}
	repository.keys[candidate.UserID] = map[int32]WrappedKey{candidate.Version: candidate}
	repository.active[candidate.UserID] = candidate.Version
	return candidate, nil
}

func (repository *memoryKeyRepository) ReserveNonce(
	_ context.Context,
	userID string,
	version int32,
	nonce []byte,
	_ time.Time,
) (bool, error) {
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	key := cacheKey(userID, version) + ":" + base64.StdEncoding.EncodeToString(nonce)
	if repository.reservations[key] {
		return false, nil
	}
	repository.reservations[key] = true
	return true, nil
}

func (repository *memoryKeyRepository) NextKeyVersion(_ context.Context, userID string) (int32, error) {
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	return repository.active[userID] + 1, nil
}

func (repository *memoryKeyRepository) StoreRotatedKey(_ context.Context, candidate WrappedKey) error {
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	if candidate.Version != repository.active[candidate.UserID]+1 {
		return ErrKeyringInvariant
	}
	for version, record := range repository.keys[candidate.UserID] {
		record.WriteKey = false
		repository.keys[candidate.UserID][version] = record
	}
	repository.keys[candidate.UserID][candidate.Version] = candidate
	repository.active[candidate.UserID] = candidate.Version
	return nil
}

func TestServiceRoundTripTamperScopeAndRotation(t *testing.T) {
	t.Parallel()
	repository := newMemoryKeyRepository()
	kms, err := NewFixtureKMS("fixture/key/cryptoKeyVersions/1", []byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(repository, kms)
	defer service.Close()
	scope := Scope{
		UserID: "10000000-0000-7000-8000-000000000001", ObjectType: "goal_versions",
		ObjectID: "13000000-0000-7000-8000-000000000001", Field: "body", CryptoRevision: 1,
	}
	storedV1, err := service.Encrypt(context.Background(), scope, "毎週3回歩く")
	if err != nil {
		t.Fatal(err)
	}
	readScope := scope
	readScope.CryptoRevision = 0
	plaintext, err := service.Decrypt(context.Background(), readScope, encryptedStorageMarker(t, storedV1))
	if err != nil || plaintext != "毎週3回歩く" {
		t.Fatalf("round trip plaintext = %q, error = %v", plaintext, err)
	}

	wrongScope := readScope
	wrongScope.ObjectID = "13000000-0000-7000-8000-000000000002"
	if _, err = service.Decrypt(context.Background(), wrongScope, encryptedStorageMarker(t, storedV1)); !errors.Is(err, ErrIntegrity) {
		t.Fatalf("scope swap error = %v, want integrity failure", err)
	}

	tampered := tamperStorageMarker(t, storedV1)
	if _, err = service.Decrypt(context.Background(), readScope, tampered); !errors.Is(err, ErrIntegrity) {
		t.Fatalf("tamper error = %v, want integrity failure", err)
	}

	version, err := service.RotateUserKey(context.Background(), scope.UserID)
	if err != nil || version != 2 {
		t.Fatalf("rotation version = %d, error = %v", version, err)
	}
	storedV2, err := service.Encrypt(context.Background(), scope, "毎週4回歩く")
	if err != nil {
		t.Fatal(err)
	}
	if envelopeVersion(t, storedV2) != 2 || envelopeVersion(t, storedV1) != 1 {
		t.Fatal("new writes must use the new DEK while old ciphertext retains its DEK version")
	}
	if plaintext, err = service.Decrypt(context.Background(), readScope, encryptedStorageMarker(t, storedV1)); err != nil || plaintext != "毎週3回歩く" {
		t.Fatalf("old DEK read after rotation = %q, error = %v", plaintext, err)
	}
}

func TestServiceConcurrentBootstrapConvergesOnOneCanonicalKey(t *testing.T) {
	t.Parallel()
	repository := newMemoryKeyRepository()
	kms, err := NewFixtureKMS("fixture/key/cryptoKeyVersions/1", []byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(repository, kms)
	defer service.Close()
	const calls = 16
	errorsFound := make(chan error, calls)
	var wait sync.WaitGroup
	for index := 0; index < calls; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			_, encryptErr := service.Encrypt(context.Background(), Scope{
				UserID: "10000000-0000-7000-8000-000000000001", ObjectType: "goal_drafts",
				ObjectID: "11000000-0000-7000-8000-000000000001", Field: "body", CryptoRevision: int64(index + 1),
			}, "body")
			errorsFound <- encryptErr
		}(index)
	}
	wait.Wait()
	close(errorsFound)
	for err = range errorsFound {
		if err != nil {
			t.Fatal(err)
		}
	}
	repository.mutex.Lock()
	defer repository.mutex.Unlock()
	if len(repository.keys["10000000-0000-7000-8000-000000000001"]) != 1 {
		t.Fatalf("bootstrap keys = %d, want one canonical key", len(repository.keys))
	}
}

func TestServiceRetriesPersistentNonceReservationCollision(t *testing.T) {
	t.Parallel()
	const (
		userID     = "10000000-0000-7000-8000-000000000001"
		keyVersion = "fixture/key/cryptoKeyVersions/1"
	)
	repository := newMemoryKeyRepository()
	kms, err := NewFixtureKMS(keyVersion, []byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	dek := []byte("abcdef0123456789abcdef0123456789")
	wrapAAD, err := serializeWrapAAD(userID, 1, keyVersion)
	if err != nil {
		t.Fatal(err)
	}
	wrapped, err := kms.Wrap(context.Background(), keyVersion, dek, wrapAAD)
	if err != nil {
		t.Fatal(err)
	}
	repository.keys[userID] = map[int32]WrappedKey{1: {
		UserID: userID, Version: 1, KEKKeyVersion: keyVersion,
		WrappedDEK: wrapped, WriteKey: true, CreatedAt: time.Unix(1, 0).UTC(),
	}}
	repository.active[userID] = 1
	duplicate := bytes.Repeat([]byte{1}, 12)
	unique := bytes.Repeat([]byte{2}, 12)
	repository.reservations[cacheKey(userID, 1)+":"+base64.StdEncoding.EncodeToString(duplicate)] = true
	service := NewServiceWithBoundaries(
		repository, kms, bytes.NewReader(append(duplicate, unique...)), func() time.Time { return time.Unix(2, 0).UTC() },
	)
	defer service.Close()
	stored, err := service.Encrypt(context.Background(), Scope{
		UserID: userID, ObjectType: "goal_drafts",
		ObjectID: "11000000-0000-7000-8000-000000000001", Field: "body", CryptoRevision: 1,
	}, "body")
	if err != nil {
		t.Fatal(err)
	}
	var record envelope
	if err = strictJSON([]byte(stored[len(writeMarkerPrefix):]), &record); err != nil {
		t.Fatal(err)
	}
	if record.Nonce != base64.StdEncoding.EncodeToString(unique) {
		t.Fatalf("reserved nonce = %s, want retry nonce", record.Nonce)
	}
}

func encryptedStorageMarker(t *testing.T, writeMarker string) string {
	t.Helper()
	if len(writeMarker) <= len(writeMarkerPrefix) || writeMarker[:len(writeMarkerPrefix)] != writeMarkerPrefix {
		t.Fatalf("invalid write marker")
	}
	return encryptedMarkerPrefix + writeMarker[len(writeMarkerPrefix):]
}

func envelopeVersion(t *testing.T, writeMarker string) int32 {
	t.Helper()
	var record envelope
	if err := strictJSON([]byte(writeMarker[len(writeMarkerPrefix):]), &record); err != nil {
		t.Fatal(err)
	}
	return record.DEKVersion
}

func tamperStorageMarker(t *testing.T, writeMarker string) string {
	t.Helper()
	var record envelope
	if err := strictJSON([]byte(writeMarker[len(writeMarkerPrefix):]), &record); err != nil {
		t.Fatal(err)
	}
	sealed, err := base64.StdEncoding.DecodeString(record.SealedPayload)
	if err != nil {
		t.Fatal(err)
	}
	sealed[len(sealed)-1] ^= 1
	record.SealedPayload = base64.StdEncoding.EncodeToString(sealed)
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	return encryptedMarkerPrefix + string(encoded)
}
