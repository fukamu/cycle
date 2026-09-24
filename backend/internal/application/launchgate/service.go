package launchgate

import (
	"context"
	"errors"

	"github.com/fukamu/cycle/backend/internal/domain/user"
)

var (
	ErrUnavailable  = errors.New("production launch gate unavailable")
	ErrAccessDenied = errors.New("production launch access denied")
)

type Facts struct {
	PublicAccessEnabled bool
	UserAllowed         bool
}

type Decision struct {
	PublicAccessEnabled bool
	UserAllowed         bool
	CanAccess           bool
}

type Repository interface {
	Read(context.Context, user.ID) (Facts, error)
	Ready(context.Context) error
}

type Service struct {
	repository Repository
	enforced   bool
}

func NewService(repository Repository, enforced bool) *Service {
	return &Service{repository: repository, enforced: enforced}
}

func Decide(facts Facts) Decision {
	return Decision{
		PublicAccessEnabled: facts.PublicAccessEnabled,
		UserAllowed:         facts.UserAllowed,
		CanAccess:           facts.PublicAccessEnabled || facts.UserAllowed,
	}
}

func (service *Service) Check(ctx context.Context, userID user.ID) (Decision, error) {
	if !service.enforced {
		return Decide(Facts{PublicAccessEnabled: true}), nil
	}
	if service.repository == nil {
		return Decision{}, ErrUnavailable
	}
	facts, err := service.repository.Read(ctx, userID)
	if err != nil {
		return Decision{}, errors.Join(ErrUnavailable, err)
	}
	return Decide(facts), nil
}

func (service *Service) Ready(ctx context.Context) error {
	if !service.enforced {
		return nil
	}
	if service.repository == nil {
		return ErrUnavailable
	}
	if err := service.repository.Ready(ctx); err != nil {
		return errors.Join(ErrUnavailable, err)
	}
	return nil
}
