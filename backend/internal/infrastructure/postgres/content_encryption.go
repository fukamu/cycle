package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/domain/cycle"
	"github.com/fukamu/cycle/backend/internal/infrastructure/contentcrypto"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

const (
	contentModeLegacy     = "legacy"
	contentModeEncrypting = "encrypting"
	contentModeStrict     = "strict"
	contentStorageLegacy  = "legacy"
	contentStorageV1      = "encrypted-v1"
)

type ContentKeyRepository struct {
	pool    *pgxpool.Pool
	queries *db.Queries
}

type ContentEncryptionState struct {
	Mode       string
	Generation int64
	LegacyRows int64
	RunningAI  int64
}

func NewContentKeyRepository(pool *pgxpool.Pool) *ContentKeyRepository {
	return &ContentKeyRepository{pool: pool, queries: db.New(pool)}
}

func (repository *ContentKeyRepository) ActiveKey(ctx context.Context, userID string) (contentcrypto.WrappedKey, error) {
	row, err := repository.queries.GetActiveUserContentDEK(ctx, mustUUID(userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return contentcrypto.WrappedKey{}, contentcrypto.ErrKeyNotFound
	}
	if err != nil {
		return contentcrypto.WrappedKey{}, err
	}
	return wrappedKeyFromActiveRow(row)
}

func (repository *ContentKeyRepository) Key(ctx context.Context, userID string, version int32) (contentcrypto.WrappedKey, error) {
	row, err := repository.queries.GetUserContentDEK(ctx, db.GetUserContentDEKParams{
		UserID: mustUUID(userID), DekVersion: version,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return contentcrypto.WrappedKey{}, contentcrypto.ErrKeyNotFound
	}
	if err != nil {
		return contentcrypto.WrappedKey{}, err
	}
	createdAt, valid := finiteGoalDeleteTimestamptz(row.CreatedAt)
	if !valid || uuidString(row.UserID) != userID {
		return contentcrypto.WrappedKey{}, contentcrypto.ErrKeyringInvariant
	}
	return contentcrypto.WrappedKey{
		UserID: userID, Version: row.DekVersion, KEKKeyVersion: row.KekKeyVersion,
		WrappedDEK: append([]byte(nil), row.WrappedDek...), WriteKey: row.IsWriteKey, CreatedAt: createdAt,
	}, nil
}

func (repository *ContentKeyRepository) StoreInitialKey(
	ctx context.Context,
	candidate contentcrypto.WrappedKey,
) (contentcrypto.WrappedKey, error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return contentcrypto.WrappedKey{}, err
	}
	defer rollback(ctx, tx)
	queries := repository.queries.WithTx(tx)
	if _, err = queries.LockUserForContentKey(ctx, mustUUID(candidate.UserID)); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return contentcrypto.WrappedKey{}, contentcrypto.ErrKeyringInvariant
		}
		return contentcrypto.WrappedKey{}, err
	}
	existing, err := queries.GetActiveUserContentDEK(ctx, mustUUID(candidate.UserID))
	if err == nil {
		canonical, mapErr := wrappedKeyFromActiveRow(existing)
		if mapErr != nil {
			return contentcrypto.WrappedKey{}, mapErr
		}
		if err = tx.Commit(ctx); err != nil {
			return contentcrypto.WrappedKey{}, err
		}
		return canonical, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return contentcrypto.WrappedKey{}, err
	}
	nextVersion, err := queries.GetNextUserContentDEKVersion(ctx, mustUUID(candidate.UserID))
	if err != nil {
		return contentcrypto.WrappedKey{}, err
	}
	hasContent, err := queries.UserHasEncryptedContent(ctx, mustUUID(candidate.UserID))
	if err != nil {
		return contentcrypto.WrappedKey{}, err
	}
	if nextVersion != 1 || hasContent || candidate.Version != 1 || !candidate.WriteKey {
		return contentcrypto.WrappedKey{}, contentcrypto.ErrKeyringInvariant
	}
	rows, err := queries.InsertUserContentDEK(ctx, db.InsertUserContentDEKParams{
		UserID: mustUUID(candidate.UserID), DekVersion: candidate.Version,
		KekKeyVersion: candidate.KEKKeyVersion, WrappedDek: candidate.WrappedDEK,
		IsWriteKey: true, CreatedAt: timestamptz(candidate.CreatedAt),
	})
	if err != nil || rows != 1 {
		if err == nil {
			err = contentcrypto.ErrKeyringInvariant
		}
		return contentcrypto.WrappedKey{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return contentcrypto.WrappedKey{}, err
	}
	return candidate, nil
}

func (repository *ContentKeyRepository) ReserveNonce(
	ctx context.Context,
	userID string,
	version int32,
	nonce []byte,
	createdAt time.Time,
) (bool, error) {
	rows, err := repository.queries.ReserveUserContentNonce(ctx, db.ReserveUserContentNonceParams{
		UserID: mustUUID(userID), DekVersion: version, Nonce: nonce, CreatedAt: timestamptz(createdAt),
	})
	return rows == 1, err
}

func (repository *ContentKeyRepository) NextKeyVersion(ctx context.Context, userID string) (int32, error) {
	return repository.queries.GetNextUserContentDEKVersion(ctx, mustUUID(userID))
}

func (repository *ContentKeyRepository) StoreRotatedKey(
	ctx context.Context,
	candidate contentcrypto.WrappedKey,
) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	queries := repository.queries.WithTx(tx)
	if _, err = queries.LockUserForContentKey(ctx, mustUUID(candidate.UserID)); err != nil {
		return err
	}
	next, err := queries.GetNextUserContentDEKVersion(ctx, mustUUID(candidate.UserID))
	if err != nil {
		return err
	}
	if next != candidate.Version || candidate.Version < 2 || !candidate.WriteKey {
		return contentcrypto.ErrKeyringInvariant
	}
	rows, err := queries.InsertUserContentDEK(ctx, db.InsertUserContentDEKParams{
		UserID: mustUUID(candidate.UserID), DekVersion: candidate.Version,
		KekKeyVersion: candidate.KEKKeyVersion, WrappedDek: candidate.WrappedDEK,
		IsWriteKey: false, CreatedAt: timestamptz(candidate.CreatedAt),
	})
	if err != nil || rows != 1 {
		if err == nil {
			err = contentcrypto.ErrKeyringInvariant
		}
		return err
	}
	demoted, err := queries.DemoteUserContentWriteDEK(ctx, mustUUID(candidate.UserID))
	if err != nil || demoted != 1 {
		if err == nil {
			err = contentcrypto.ErrKeyringInvariant
		}
		return err
	}
	promoted, err := queries.PromoteUserContentWriteDEK(ctx, db.PromoteUserContentWriteDEKParams{
		UserID: mustUUID(candidate.UserID), DekVersion: candidate.Version,
	})
	if err != nil || promoted != 1 {
		if err == nil {
			err = contentcrypto.ErrKeyringInvariant
		}
		return err
	}
	return tx.Commit(ctx)
}

func (repository *ContentKeyRepository) State(ctx context.Context) (ContentEncryptionState, error) {
	control, err := repository.queries.GetContentEncryptionState(ctx)
	if err != nil {
		return ContentEncryptionState{}, err
	}
	legacyRows, err := repository.queries.CountLegacyContentRows(ctx)
	if err != nil {
		return ContentEncryptionState{}, err
	}
	runningAI, err := repository.queries.CountRunningAIGenerationsForContentActivation(ctx)
	if err != nil {
		return ContentEncryptionState{}, err
	}
	return ContentEncryptionState{
		Mode: control.Mode, Generation: control.Generation, LegacyRows: legacyRows, RunningAI: runningAI,
	}, nil
}

func (repository *ContentKeyRepository) SetMode(ctx context.Context, target string, now time.Time) error {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	queries := repository.queries.WithTx(tx)
	control, err := queries.LockContentEncryptionControl(ctx)
	if err != nil {
		return err
	}
	validTransition := control.Mode == contentModeLegacy && target == contentModeEncrypting ||
		control.Mode == contentModeEncrypting && target == contentModeStrict
	if !validTransition {
		return fmt.Errorf("%w: invalid content encryption mode transition", contentcrypto.ErrKeyringInvariant)
	}
	if target == contentModeEncrypting {
		running, countErr := queries.CountRunningAIGenerationsForContentActivation(ctx)
		if countErr != nil {
			return countErr
		}
		if running != 0 {
			return fmt.Errorf("%w: running AI generations must be drained", contentcrypto.ErrKeyringInvariant)
		}
	}
	if target == contentModeStrict {
		legacy, countErr := queries.CountLegacyContentRows(ctx)
		if countErr != nil {
			return countErr
		}
		if legacy != 0 {
			return fmt.Errorf("%w: legacy content remains", contentcrypto.ErrKeyringInvariant)
		}
	}
	rows, err := queries.SetContentEncryptionModeCAS(ctx, db.SetContentEncryptionModeCASParams{
		NewMode: target, UpdatedAt: timestamptz(now), ExpectedMode: control.Mode,
		ExpectedGeneration: control.Generation,
	})
	if err != nil {
		return err
	}
	if rows != 1 {
		return contentcrypto.ErrKeyringInvariant
	}
	return tx.Commit(ctx)
}

func wrappedKeyFromActiveRow(row *db.GetActiveUserContentDEKRow) (contentcrypto.WrappedKey, error) {
	if row == nil {
		return contentcrypto.WrappedKey{}, contentcrypto.ErrKeyringInvariant
	}
	createdAt, valid := finiteGoalDeleteTimestamptz(row.CreatedAt)
	userID := uuidString(row.UserID)
	if !valid || userID == "" || row.DekVersion < 1 || row.KekKeyVersion == "" || len(row.WrappedDek) == 0 {
		return contentcrypto.WrappedKey{}, contentcrypto.ErrKeyringInvariant
	}
	return contentcrypto.WrappedKey{
		UserID: userID, Version: row.DekVersion, KEKKeyVersion: row.KekKeyVersion,
		WrappedDEK: append([]byte(nil), row.WrappedDek...), WriteKey: true, CreatedAt: createdAt,
	}, nil
}

type contentBoundary struct {
	service       *contentcrypto.Service
	encryptWrites bool
}

func prepareContentBoundary(ctx context.Context, queries *db.Queries, service *contentcrypto.Service) (contentBoundary, error) {
	mode, err := queries.GetContentEncryptionMode(ctx)
	if err != nil {
		return contentBoundary{}, err
	}
	if mode == contentModeLegacy {
		return contentBoundary{service: service}, nil
	}
	if mode != contentModeEncrypting && mode != contentModeStrict {
		return contentBoundary{}, fmt.Errorf("%w: unknown durable mode", contentcrypto.ErrKeyringInvariant)
	}
	if service == nil {
		return contentBoundary{}, contentcrypto.ErrUnavailable
	}
	if _, err = queries.SetEncryptedContentWriter(ctx); err != nil {
		return contentBoundary{}, err
	}
	return contentBoundary{service: service, encryptWrites: true}, nil
}

func (boundary contentBoundary) decode(
	ctx context.Context,
	userID, objectType, objectID, field, stored string,
) (string, error) {
	if !contentcrypto.IsStorageMarker(stored) {
		return stored, nil
	}
	if boundary.service == nil {
		return "", contentcrypto.ErrUnavailable
	}
	return boundary.service.Decrypt(ctx, contentcrypto.Scope{
		UserID: userID, ObjectType: objectType, ObjectID: objectID, Field: field,
	}, stored)
}

func (boundary contentBoundary) encode(
	ctx context.Context,
	userID, objectType, objectID, field string,
	cryptoRevision int64,
	plaintext string,
) (string, error) {
	if !boundary.encryptWrites {
		return plaintext, nil
	}
	return boundary.service.Encrypt(ctx, contentcrypto.Scope{
		UserID: userID, ObjectType: objectType, ObjectID: objectID,
		Field: field, CryptoRevision: cryptoRevision,
	}, plaintext)
}

func (boundary contentBoundary) decodeOptional(
	ctx context.Context,
	userID, objectType, objectID, field string,
	stored *string,
) (*string, error) {
	if stored == nil {
		return nil, nil
	}
	decoded, err := boundary.decode(ctx, userID, objectType, objectID, field, *stored)
	if err != nil {
		return nil, err
	}
	return &decoded, nil
}

func (boundary contentBoundary) encodeOptional(
	ctx context.Context,
	userID, objectType, objectID, field string,
	cryptoRevision int64,
	plaintext *string,
) (*string, error) {
	if plaintext == nil {
		return nil, nil
	}
	encoded, err := boundary.encode(ctx, userID, objectType, objectID, field, cryptoRevision, *plaintext)
	if err != nil {
		return nil, err
	}
	return &encoded, nil
}

func (boundary contentBoundary) decodeCycle(ctx context.Context, current *cycle.PDCACycle) error {
	if current == nil {
		return contentcrypto.ErrIntegrity
	}
	fields := []struct {
		name  string
		value *string
	}{
		{name: "plan", value: &current.Plan},
		{name: "do_text", value: &current.Do},
		{name: "check_text", value: &current.Check},
		{name: "action", value: &current.Action},
	}
	for _, field := range fields {
		decoded, err := boundary.decode(ctx, current.UserID, "pdca_cycles", current.ID, field.name, *field.value)
		if err != nil {
			return err
		}
		*field.value = decoded
	}
	return nil
}

func (boundary contentBoundary) decodeGoalVersion(
	ctx context.Context,
	userID, versionID string,
	body *string,
	successSignal *string,
) error {
	decoded, err := boundary.decode(ctx, userID, "goal_versions", versionID, "body", *body)
	if err != nil {
		return err
	}
	*body = decoded
	if successSignal == nil || *successSignal == "" {
		return nil
	}
	decoded, err = boundary.decode(
		ctx, userID, "goal_version_success_signals", versionID, "success_signal", *successSignal,
	)
	if err != nil {
		return err
	}
	*successSignal = decoded
	return nil
}

func (boundary contentBoundary) decodeDraft(
	ctx context.Context,
	userID, draftID string,
	body *string,
	successSignal *string,
) error {
	decoded, err := boundary.decode(ctx, userID, "goal_drafts", draftID, "body", *body)
	if err != nil {
		return err
	}
	*body = decoded
	if successSignal == nil || *successSignal == "" {
		return nil
	}
	decoded, err = boundary.decode(
		ctx, userID, "goal_draft_success_signals", draftID, "success_signal", *successSignal,
	)
	if err != nil {
		return err
	}
	*successSignal = decoded
	return nil
}

func (boundary contentBoundary) decodeAIField(
	ctx context.Context,
	userID, generationID, field string,
	value *string,
) error {
	if value == nil || *value == "" {
		return nil
	}
	decoded, err := boundary.decode(ctx, userID, "ai_generations", generationID, field, *value)
	if err != nil {
		return err
	}
	*value = decoded
	return nil
}

type encryptedCycleFields struct {
	plan, doText, checkText, action string
}

func (boundary contentBoundary) encodeCycleFields(ctx context.Context, current cycleContent) (encryptedCycleFields, error) {
	values := []struct {
		field    string
		revision int64
		value    string
	}{
		{field: "plan", revision: current.planRevision + 1, value: current.plan},
		{field: "do_text", revision: current.doRevision + 1, value: current.doText},
		{field: "check_text", revision: current.checkRevision + 1, value: current.checkText},
		{field: "action", revision: current.actionRevision + 1, value: current.action},
	}
	encoded := make([]string, len(values))
	for index, value := range values {
		var err error
		encoded[index], err = boundary.encode(
			ctx, current.userID, "pdca_cycles", current.cycleID, value.field, value.revision, value.value,
		)
		if err != nil {
			return encryptedCycleFields{}, err
		}
	}
	return encryptedCycleFields{plan: encoded[0], doText: encoded[1], checkText: encoded[2], action: encoded[3]}, nil
}

func (boundary contentBoundary) encodeCycleField(
	ctx context.Context,
	current cycleContent,
	frame cycle.Frame,
) (string, error) {
	var field, value string
	var revision int64
	switch frame {
	case cycle.FramePlan:
		field, value, revision = "plan", current.plan, current.planRevision
	case cycle.FrameDo:
		field, value, revision = "do_text", current.doText, current.doRevision
	case cycle.FrameCheck:
		field, value, revision = "check_text", current.checkText, current.checkRevision
	case cycle.FrameAction:
		field, value, revision = "action", current.action, current.actionRevision
	default:
		return "", cycle.ErrInvalidFrame
	}
	return boundary.encode(
		ctx, current.userID, "pdca_cycles", current.cycleID, field, revision+1, value,
	)
}

type cycleContent struct {
	userID, cycleID                 string
	plan, doText, checkText, action string
	planRevision, doRevision        int64
	checkRevision, actionRevision   int64
}
