package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/fukamu/cycle/backend/internal/application/launchgate"
	"github.com/fukamu/cycle/backend/internal/domain/user"
	db "github.com/fukamu/cycle/backend/internal/infrastructure/postgres/generated"
)

type LaunchGateRepository struct {
	queries *db.Queries
}

var _ launchgate.Repository = (*LaunchGateRepository)(nil)

func NewLaunchGateRepository(pool *pgxpool.Pool) *LaunchGateRepository {
	return &LaunchGateRepository{queries: db.New(pool)}
}

func (repository *LaunchGateRepository) Read(ctx context.Context, userID user.ID) (launchgate.Facts, error) {
	row, err := repository.queries.GetProductionLaunchGate(ctx, mustUUID(string(userID)))
	if err != nil {
		return launchgate.Facts{}, err
	}
	return launchgate.Facts{
		PublicAccessEnabled: row.PublicAccessEnabled,
		UserAllowed:         row.UserAllowed,
	}, nil
}

func (repository *LaunchGateRepository) Ready(ctx context.Context) error {
	_, err := repository.queries.GetProductionLaunchGate(ctx, mustUUID("00000000-0000-7000-8000-000000000000"))
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("launch config singleton is missing: %w", err)
	}
	return err
}
