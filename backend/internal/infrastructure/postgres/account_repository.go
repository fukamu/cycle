package postgres

import (
	"context"
	"errors"
	"math"
	"math/big"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/account"
	"github.com/fukamu/cycle/backend/internal/domain/user"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

type AccountRepository struct {
	pool *pgxpool.Pool
}

type accountMonthlyExposure struct {
	month             time.Time
	reservedToRelease string
	unattributedToAdd string
}

func NewAccountRepository(pool *pgxpool.Pool) *AccountRepository {
	return &AccountRepository{pool: pool}
}

func (repository *AccountRepository) UpgradeGoogle(ctx context.Context, input account.UpgradeRecord) (result account.AuthResult, err error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return result, err
	}
	defer rollbackOnError(ctx, tx, &err)
	queries := db.New(tx)
	if err = lockUser(ctx, tx, input.CurrentUserID); err != nil {
		return result, err
	}
	linkedIdentity, findErr := queries.FindGoogleIdentityBySubject(ctx, input.Identity.Subject)
	if errors.Is(findErr, pgx.ErrNoRows) {
		err = queries.InsertGoogleIdentity(ctx, db.InsertGoogleIdentityParams{
			IdentityID:          mustUUID(input.IdentityID),
			UserID:              mustUUID(string(input.CurrentUserID)),
			ProviderSubject:     input.Identity.Subject,
			EmailAtLink:         input.Identity.Email,
			EmailVerifiedAtLink: input.Identity.EmailVerified,
			CreatedAt:           timestamptz(input.Now),
		})
		if err != nil {
			if isUniqueViolation(err) {
				return result, account.ErrGoogleIdentityLinked
			}
			return result, err
		}
		result.GoogleEmail = verifiedGoogleEmail(input.Identity)
	} else {
		if findErr != nil {
			return result, findErr
		}
		linkedUserID, linkedEmail, mappingErr := accountGoogleIdentity(linkedIdentity)
		if mappingErr != nil {
			return result, mappingErr
		}
		if linkedUserID != string(input.CurrentUserID) {
			return result, account.ErrGoogleIdentityLinked
		}
		result.GoogleEmail = linkedEmail
	}
	if err = queries.DeleteAnonymousBootstrapsByUser(ctx, mustUUID(string(input.CurrentUserID))); err != nil {
		return result, err
	}
	if err = rotateSession(ctx, queries, input.CurrentSessionID, input.NewSessionID, input.CurrentUserID,
		input.SessionTokenHash, input.CSRFTokenHash, input.Now, input.IdleExpiresAt, input.AbsoluteExpiresAt); err != nil {
		return result, err
	}
	result.UserID = input.CurrentUserID
	err = tx.Commit(ctx)
	return result, err
}

func (repository *AccountRepository) LoginGoogle(ctx context.Context, input account.LoginRecord) (result account.AuthResult, err error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return result, err
	}
	defer rollbackOnError(ctx, tx, &err)
	queries := db.New(tx)
	linkedIdentity, findErr := queries.FindGoogleIdentityBySubject(ctx, input.Identity.Subject)
	if errors.Is(findErr, pgx.ErrNoRows) {
		return result, account.ErrGoogleAccountNotLinked
	}
	if findErr != nil {
		return result, findErr
	}
	targetUserID, googleEmail, mappingErr := accountGoogleIdentity(linkedIdentity)
	if mappingErr != nil {
		return result, mappingErr
	}
	result.UserID = user.ID(targetUserID)
	result.GoogleEmail = googleEmail
	if err = lockUser(ctx, tx, result.UserID); err != nil {
		return result, err
	}
	rows, updateErr := queries.RevokeSession(ctx, db.RevokeSessionParams{
		SessionID: mustUUID(input.CurrentSessionID),
		Now:       timestamptz(input.Now),
	})
	if updateErr != nil {
		return result, updateErr
	}
	if rows != 1 {
		return result, pgx.ErrNoRows
	}
	if err = insertAccountSession(ctx, queries, input.NewSessionID, result.UserID, input.SessionTokenHash, input.CSRFTokenHash,
		input.Now, input.IdleExpiresAt, input.AbsoluteExpiresAt); err != nil {
		return result, err
	}
	err = tx.Commit(ctx)
	return result, err
}

func (repository *AccountRepository) DeleteAccount(
	ctx context.Context,
	userID user.ID,
	now time.Time,
) (result account.DeleteResult, err error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return result, err
	}
	defer rollbackOnError(ctx, tx, &err)
	queries := db.New(tx)
	if err = lockUser(ctx, tx, userID); err != nil {
		return result, err
	}
	userUUID := mustUUID(string(userID))
	if _, err = queries.LockAccountGoalIDs(ctx, userUUID); err != nil {
		return result, err
	}
	if _, err = queries.LockAccountGoalDraftIDs(ctx, userUUID); err != nil {
		return result, err
	}
	if _, err = queries.LockAccountCycleIDs(ctx, userUUID); err != nil {
		return result, err
	}

	type generationExposure struct {
		id          string
		month       time.Time
		reservation string
	}
	generationRows, err := queries.LockAccountRunningGenerationExposures(ctx, userUUID)
	if err != nil {
		return result, err
	}
	generationExposures := make([]generationExposure, 0, len(generationRows))
	generationByID := make(map[string]generationExposure, len(generationRows))
	for _, row := range generationRows {
		if row == nil {
			return result, errors.New("account delete generation exposure row is nil")
		}
		generationID := uuidString(row.ID)
		generationMonth, mappingErr := accountExposureDate(row.BudgetMonthUtc)
		if generationID == "" || mappingErr != nil {
			return result, errors.New("account delete generation exposure mapping invariant failed")
		}
		generation := generationExposure{
			id: generationID, month: generationMonth, reservation: row.BudgetReservedCostUsd,
		}
		generationExposures = append(generationExposures, generation)
		generationByID[generation.id] = generation
	}
	type releasedUsageExposure struct {
		operationID string
		month       time.Time
		reservation string
	}
	usageRows, err := queries.LockAccountUnfinalizedUsageExposures(ctx, userUUID)
	if err != nil {
		return result, err
	}
	releasedUsageExposures := make([]releasedUsageExposure, 0, len(usageRows))
	for _, row := range usageRows {
		if row == nil {
			return result, errors.New("account delete usage exposure row is nil")
		}
		operationID := uuidString(row.OperationID)
		usageMonth, mappingErr := accountExposureDate(row.SettlementBudgetMonthUtc)
		if operationID == "" || mappingErr != nil {
			return result, errors.New("account delete usage exposure mapping invariant failed")
		}
		usage := releasedUsageExposure{
			operationID: operationID, month: usageMonth, reservation: row.SettlementReservationCostUsd,
		}
		if generation, running := generationByID[usage.operationID]; running {
			if !generation.month.Equal(usage.month) || generation.reservation != usage.reservation {
				return result, errors.New("account delete running AI settlement exposure invariant failed")
			}
			continue
		}
		releasedUsageExposures = append(releasedUsageExposures, usage)
	}
	result.SettlementOperationCount = int64(len(generationExposures) + len(releasedUsageExposures))
	exposureRows, err := queries.ListAccountMonthlyExposures(ctx, userUUID)
	if err != nil {
		return result, err
	}
	monthlyExposures := make([]accountMonthlyExposure, 0, len(exposureRows))
	for _, row := range exposureRows {
		if row == nil {
			return result, errors.New("account delete monthly exposure row is nil")
		}
		exposureMonth, mappingErr := accountExposureDate(row.MonthUtc)
		if mappingErr != nil {
			return result, errors.New("account delete monthly exposure mapping invariant failed")
		}
		monthlyExposures = append(monthlyExposures, accountMonthlyExposure{
			month:             exposureMonth,
			reservedToRelease: row.ReservedToRelease,
			unattributedToAdd: row.UnattributedToAdd,
		})
	}
	for _, generation := range generationExposures {
		rows, updateErr := queries.ReleaseAccountGenerationReservationCAS(
			ctx,
			db.ReleaseAccountGenerationReservationCASParams{
				UserID:                 userUUID,
				GenerationID:           mustUUID(generation.id),
				ExpectedBudgetMonthUtc: accountDateParam(generation.month),
				ExpectedReservationUsd: generation.reservation,
			},
		)
		if updateErr != nil {
			return result, updateErr
		}
		if rows != 1 {
			return result, errors.New("account delete generation reservation invariant failed")
		}
	}
	unattributedCostUSD, sumErr := sumUnattributedCost(monthlyExposures)
	if sumErr != nil {
		return result, sumErr
	}
	for _, exposure := range monthlyExposures {
		rows, updateErr := queries.MoveAccountExposureToUnattributedCAS(
			ctx,
			db.MoveAccountExposureToUnattributedCASParams{
				ReservedToRelease: exposure.reservedToRelease,
				UnattributedToAdd: exposure.unattributedToAdd,
				UpdatedAt:         timestamptz(now),
				MonthUtc:          accountDateParam(exposure.month),
			},
		)
		if updateErr != nil {
			return result, updateErr
		}
		if rows != 1 {
			return result, errors.New("account delete budget settlement exposure invariant failed")
		}
	}
	for _, usage := range releasedUsageExposures {
		rows, deleteErr := queries.DeleteReleasedAccountUsageExposureCAS(
			ctx,
			db.DeleteReleasedAccountUsageExposureCASParams{
				UserID:                 userUUID,
				OperationID:            mustUUID(usage.operationID),
				ExpectedBudgetMonthUtc: accountDateParam(usage.month),
				ExpectedReservationUsd: usage.reservation,
			},
		)
		if deleteErr != nil {
			return result, deleteErr
		}
		if rows != 1 {
			return result, errors.New("account delete released AI usage exposure invariant failed")
		}
	}
	rows, err := queries.DeleteAccountUserCAS(ctx, userUUID)
	if err != nil {
		return result, err
	}
	if rows != 1 {
		return result, pgx.ErrNoRows
	}
	err = tx.Commit(ctx)
	if err == nil {
		result.UnattributedCostUSD = unattributedCostUSD
	}
	return result, err
}

func sumUnattributedCost(exposures []accountMonthlyExposure) (float64, error) {
	total := new(big.Rat)
	for _, exposure := range exposures {
		value, ok := new(big.Rat).SetString(exposure.unattributedToAdd)
		if !ok || value.Sign() < 0 {
			return 0, errors.New("account delete unattributed cost mapping invariant failed")
		}
		total.Add(total, value)
	}
	amount, _ := total.Float64()
	if math.IsNaN(amount) || math.IsInf(amount, 0) || amount < 0 {
		return 0, errors.New("account delete unattributed cost total invariant failed")
	}
	return amount, nil
}

func lockUser(ctx context.Context, tx pgx.Tx, userID user.ID) error {
	_, err := db.New(tx).LockUser(ctx, mustUUID(string(userID)))
	return err
}

func rotateSession(ctx context.Context, queries *db.Queries, currentSessionID, newSessionID string, userID user.ID, tokenHash, csrfHash []byte, now, idleExpiry, absoluteExpiry time.Time) error {
	rows, err := queries.RevokeOwnedSession(ctx, db.RevokeOwnedSessionParams{
		SessionID: mustUUID(currentSessionID),
		UserID:    mustUUID(string(userID)),
		Now:       timestamptz(now),
	})
	if err != nil {
		return err
	}
	if rows != 1 {
		return pgx.ErrNoRows
	}
	return insertAccountSession(ctx, queries, newSessionID, userID, tokenHash, csrfHash, now, idleExpiry, absoluteExpiry)
}

func insertAccountSession(ctx context.Context, queries *db.Queries, sessionID string, userID user.ID, tokenHash, csrfHash []byte, now, idleExpiry, absoluteExpiry time.Time) error {
	return queries.InsertSession(ctx, db.InsertSessionParams{
		SessionID:         mustUUID(sessionID),
		UserID:            mustUUID(string(userID)),
		TokenHash:         tokenHash,
		CsrfTokenHash:     csrfHash,
		Now:               timestamptz(now),
		IdleExpiresAt:     timestamptz(idleExpiry),
		AbsoluteExpiresAt: timestamptz(absoluteExpiry),
	})
}

func verifiedGoogleEmail(identity account.GoogleIdentity) *string {
	if identity.Email == nil || identity.EmailVerified == nil || !*identity.EmailVerified {
		return nil
	}
	email := *identity.Email
	return &email
}

func accountGoogleIdentity(row *db.FindGoogleIdentityBySubjectRow) (string, *string, error) {
	if row == nil {
		return "", nil, errors.New("Google identity row is nil")
	}
	userID := uuidString(row.UserID)
	if userID == "" {
		return "", nil, errors.New("Google identity user ID is invalid")
	}
	switch value := row.VerifiedEmail.(type) {
	case nil:
		return userID, nil, nil
	case string:
		email := value
		return userID, &email, nil
	case []byte:
		email := string(value)
		return userID, &email, nil
	case pgtype.Text:
		if !value.Valid {
			return userID, nil, nil
		}
		email := value.String
		return userID, &email, nil
	default:
		return "", nil, errors.New("Google identity verified email has an invalid database type")
	}
}

func accountExposureDate(value pgtype.Date) (time.Time, error) {
	if !value.Valid || value.InfinityModifier != pgtype.Finite {
		return time.Time{}, errors.New("account exposure date is invalid")
	}
	return time.Date(value.Time.Year(), value.Time.Month(), value.Time.Day(), 0, 0, 0, 0, time.UTC), nil
}

func accountDateParam(value time.Time) pgtype.Date {
	return pgtype.Date{
		Time:  time.Date(value.Year(), value.Month(), value.Day(), 0, 0, 0, 0, time.UTC),
		Valid: true,
	}
}
