package httpapi

import (
	"net/http"

	appsession "github.com/fukamu/cycle/backend/internal/application/session"
)

type sessionResponse struct {
	User struct {
		ID              string  `json:"id"`
		GoogleConnected bool    `json:"googleConnected"`
		GoogleEmail     *string `json:"googleEmail"`
	} `json:"user"`
	CSRFToken string `json:"csrfToken"`
}

type createAnonymousRequest struct {
	BootstrapID    string `json:"bootstrapId" validate:"required,uuid_v7"`
	TurnstileToken string `json:"turnstileToken"`
}

func (server *api) getSession(writer http.ResponseWriter, request *http.Request) {
	cookie, _ := request.Cookie(sessionCookieName)
	view, err := server.dependencies.Sessions.Refresh(request.Context(), cookie.Value)
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	writeJSON(writer, http.StatusOK, mapSession(view))
}

func (server *api) createAnonymous(writer http.ResponseWriter, request *http.Request) {
	metricResult := "failure"
	defer func() {
		if server.dependencies.Metrics != nil {
			server.dependencies.Metrics.AnonymousCreate(request.Context(), metricResult)
		}
	}()
	if !server.validOrigin(request) {
		server.writeError(writer, request, appsession.ErrCSRFInvalid, nil)
		return
	}
	if cookie, err := request.Cookie(sessionCookieName); err == nil {
		if view, refreshErr := server.dependencies.Sessions.Refresh(request.Context(), cookie.Value); refreshErr == nil {
			metricResult = "idempotent"
			writeJSON(writer, http.StatusOK, mapSession(view))
			return
		}
	}
	var input createAnonymousRequest
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	view, err := server.dependencies.Sessions.CreateAnonymous(request.Context(), appsession.CreateAnonymousInput{
		BootstrapID: input.BootstrapID, TurnstileToken: input.TurnstileToken,
		RemoteAddress: server.remoteIP(request), UserAgent: request.UserAgent(),
	})
	if err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	setSessionCookie(writer, view.SessionToken)
	metricResult = "idempotent"
	if view.Created {
		metricResult = "success"
	}
	writeJSON(writer, http.StatusCreated, mapSession(view))
}

func mapSession(view appsession.View) sessionResponse {
	var response sessionResponse
	response.User.ID = string(view.UserID)
	response.User.GoogleConnected = view.GoogleConnected
	response.User.GoogleEmail = view.GoogleEmail
	response.CSRFToken = view.CSRFToken
	return response
}
