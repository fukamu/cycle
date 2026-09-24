package launchgate

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/cycle/backend/internal/domain/user"
)

type repositoryStub struct {
	facts Facts
	err   error
}

func (stub repositoryStub) Read(context.Context, user.ID) (Facts, error) {
	return stub.facts, stub.err
}

func (stub repositoryStub) Ready(context.Context) error { return stub.err }

func TestDecideLaunchAccessMatrix(t *testing.T) {
	t.Parallel()
	tests := []struct {
		public, allowed, want bool
	}{
		{false, false, false},
		{false, true, true},
		{true, false, true},
		{true, true, true},
	}
	for _, test := range tests {
		decision := Decide(Facts{PublicAccessEnabled: test.public, UserAllowed: test.allowed})
		if decision.CanAccess != test.want {
			t.Fatalf("Decide(%t, %t) = %t, want %t", test.public, test.allowed, decision.CanAccess, test.want)
		}
	}
}

func TestServiceFailsClosedAndBypassesOnlyWhenExplicitlyDisabled(t *testing.T) {
	t.Parallel()
	failure := errors.New("database unavailable")
	enforced := NewService(repositoryStub{err: failure}, true)
	if _, err := enforced.Check(context.Background(), user.ID("user")); !errors.Is(err, ErrUnavailable) || !errors.Is(err, failure) {
		t.Fatalf("Check error = %v", err)
	}
	if err := enforced.Ready(context.Background()); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("Ready error = %v", err)
	}

	disabled := NewService(nil, false)
	decision, err := disabled.Check(context.Background(), user.ID("user"))
	if err != nil || !decision.PublicAccessEnabled || !decision.CanAccess || decision.UserAllowed {
		t.Fatalf("disabled decision = %#v, error = %v", decision, err)
	}
}
