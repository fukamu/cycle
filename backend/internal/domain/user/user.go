package user

import "time"

type ID string

type User struct {
	ID           ID
	LastActiveAt time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

func New(id ID, now time.Time) User {
	now = now.UTC()
	return User{
		ID:           id,
		LastActiveAt: now,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
}
