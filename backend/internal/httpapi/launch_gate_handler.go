package httpapi

import (
	"net/http"

	"github.com/fukamu/cycle/backend/internal/application/launchgate"
	appsession "github.com/fukamu/cycle/backend/internal/application/session"
)

type launchStatusResponse struct {
	PublicAccessEnabled bool `json:"publicAccessEnabled"`
	UserAllowed         bool `json:"userAllowed"`
	CanAccess           bool `json:"canAccess"`
}

func (server *api) getLaunchStatus(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Add("Vary", "Cookie")
	record, ok := authenticatedSession(request.Context())
	if !ok {
		server.writeError(writer, request, appsession.ErrSessionMissing, nil)
		return
	}
	if server.dependencies.LaunchGate == nil {
		if server.dependencies.Production {
			server.writeError(writer, request, launchgate.ErrUnavailable, nil)
			return
		}
		writeJSON(writer, http.StatusOK, launchStatusResponse{PublicAccessEnabled: true, CanAccess: true})
		return
	}
	decision, err := server.dependencies.LaunchGate.Check(request.Context(), record.UserID)
	if err != nil {
		server.writeError(writer, request, launchgate.ErrUnavailable, nil)
		return
	}
	writeJSON(writer, http.StatusOK, launchStatusResponse{
		PublicAccessEnabled: decision.PublicAccessEnabled,
		UserAllowed:         decision.UserAllowed,
		CanAccess:           decision.CanAccess,
	})
}
