package httpapi

import (
	"context"
	"net/http"

	"github.com/fukamu/cycle/backend/internal/application/account"
	appsession "github.com/fukamu/cycle/backend/internal/application/session"
	"github.com/fukamu/cycle/backend/internal/domain/user"
)

const googleTokenBodyLimit = 16 << 10

type AccountService interface {
	UpgradeGoogle(context.Context, user.ID, string, string) (account.View, error)
	LoginGoogle(context.Context, string, string) (account.View, error)
	Delete(context.Context, user.ID, bool) error
}

type googleTokenRequest struct {
	IDToken string `json:"idToken" validate:"required"`
}

type deleteAccountRequest struct {
	Confirmed bool `json:"confirmed"`
}

func (server *api) upgradeGoogle(writer http.ResponseWriter, request *http.Request) {
	metricResult := "failure"
	defer func() {
		if server.dependencies.Metrics != nil {
			server.dependencies.Metrics.AccountUpgrade(request.Context(), metricResult)
		}
	}()
	var input googleTokenRequest
	if err := server.decodeAndValidateJSON(writer, request, &input, googleTokenBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	record, _ := authenticatedSession(request.Context())
	view, err := server.dependencies.Account.UpgradeGoogle(request.Context(), record.UserID, record.ID, input.IDToken)
	if err != nil {
		server.writeError(writer, request, stableUseCaseError(err, errAccountUpgradeFailed), nil)
		return
	}
	setSessionCookie(writer, view.SessionToken)
	metricResult = "success"
	writeJSON(writer, http.StatusOK, sessionResponseFromAccount(view))
}

func (server *api) loginGoogle(writer http.ResponseWriter, request *http.Request) {
	var input googleTokenRequest
	if err := server.decodeAndValidateJSON(writer, request, &input, googleTokenBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	record, _ := authenticatedSession(request.Context())
	view, err := server.dependencies.Account.LoginGoogle(request.Context(), record.ID, input.IDToken)
	if err != nil {
		server.writeError(writer, request, stableUseCaseError(err, errGoogleLoginFailed), nil)
		return
	}
	setSessionCookie(writer, view.SessionToken)
	writeJSON(writer, http.StatusOK, sessionResponseFromAccount(view))
}

func (server *api) deleteAccount(writer http.ResponseWriter, request *http.Request) {
	metricResult := "failure"
	defer func() {
		if server.dependencies.Metrics != nil {
			server.dependencies.Metrics.AccountDelete(request.Context(), metricResult)
		}
	}()
	var input deleteAccountRequest
	if err := server.decodeAndValidateJSON(writer, request, &input, defaultBodyLimit); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	record, _ := authenticatedSession(request.Context())
	if err := server.dependencies.Account.Delete(request.Context(), record.UserID, input.Confirmed); err != nil {
		server.writeError(writer, request, err, nil)
		return
	}
	clearSessionCookie(writer)
	metricResult = "success"
	writer.WriteHeader(http.StatusNoContent)
}

func sessionResponseFromAccount(view account.View) sessionResponse {
	return mapSession(appsession.View{
		UserID: view.UserID, GoogleConnected: view.GoogleConnected,
		GoogleEmail: view.GoogleEmail,
		CSRFToken:   view.CSRFToken, SessionToken: view.SessionToken,
	})
}

func setSessionCookie(writer http.ResponseWriter, token string) {
	http.SetCookie(writer, &http.Cookie{
		Name: sessionCookieName, Value: token, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode,
	})
}

func clearSessionCookie(writer http.ResponseWriter) {
	http.SetCookie(writer, &http.Cookie{
		Name: sessionCookieName, Value: "", Path: "/", Secure: true, HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: -1,
	})
}
