package postgres

import (
	"context"
	"testing"

	"github.com/fukamu/cycle/backend/internal/domain/user"
)

func TestLaunchGateRepositoryDecisionSourcesAndReadiness(t *testing.T) {
	pool := integrationPool(t)
	resetDatabase(t, pool)
	repository := NewLaunchGateRepository(pool)
	ctx := context.Background()
	const allowedUserID = "10000000-0000-7000-8000-000000000001"
	const unknownUserID = "10000000-0000-7000-8000-000000000002"

	if err := repository.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	closed, err := repository.Read(ctx, user.ID(unknownUserID))
	if err != nil || closed.PublicAccessEnabled || closed.UserAllowed {
		t.Fatalf("closed unknown facts/error = %#v/%v", closed, err)
	}

	if _, err = pool.Exec(ctx, `INSERT INTO users(id,last_active_at,created_at,updated_at)
VALUES($1,now(),now(),now())`, allowedUserID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO launch_allowed_users(user_id) VALUES($1)`, allowedUserID); err != nil {
		t.Fatal(err)
	}
	allowed, err := repository.Read(ctx, user.ID(allowedUserID))
	if err != nil || allowed.PublicAccessEnabled || !allowed.UserAllowed {
		t.Fatalf("closed allowed facts/error = %#v/%v", allowed, err)
	}

	if _, err = pool.Exec(ctx, `UPDATE launch_config SET public_access_enabled=TRUE WHERE singleton=TRUE`); err != nil {
		t.Fatal(err)
	}
	opened, err := repository.Read(ctx, user.ID(unknownUserID))
	if err != nil || !opened.PublicAccessEnabled || opened.UserAllowed {
		t.Fatalf("public unknown facts/error = %#v/%v", opened, err)
	}

	if _, err = pool.Exec(ctx, `DELETE FROM launch_config WHERE singleton=TRUE`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, restoreErr := pool.Exec(context.Background(), `INSERT INTO launch_config(singleton,public_access_enabled) VALUES(TRUE,FALSE) ON CONFLICT(singleton) DO UPDATE SET public_access_enabled=FALSE`)
		if restoreErr != nil {
			t.Errorf("restore launch config: %v", restoreErr)
		}
	})
	if err = repository.Ready(ctx); err == nil {
		t.Fatal("missing launch singleton was ready")
	}
	if _, err = repository.Read(ctx, user.ID(allowedUserID)); err == nil {
		t.Fatal("missing launch singleton returned facts")
	}
}
