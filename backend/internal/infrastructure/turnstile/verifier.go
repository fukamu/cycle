package turnstile

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"

	"github.com/fukamu/cycle/backend/internal/application/ports"
	"github.com/fukamu/cycle/backend/internal/securehash"
)

const (
	defaultSiteverifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
	responseBodyLimit    = 64 << 10
)

type RateLimiter interface {
	Check(context.Context, []byte, time.Time) error
}

type Clock interface {
	Now() time.Time
}

type HTTPClient interface {
	Do(*http.Request) (*http.Response, error)
}

type Observer interface {
	TurnstileVerification(context.Context, string)
	RateLimitRejected(context.Context, string)
}

type Settings struct {
	SecretKey      string
	ExpectedAction string
	ExpectedHost   string
	RateHashKey    []byte
	SiteverifyURL  string
	Observer       Observer
}

type Verifier struct {
	client         HTTPClient
	limiter        RateLimiter
	clock          Clock
	secretKey      string
	expectedAction string
	expectedHost   string
	rateHashKey    []byte
	siteverifyURL  string
	observer       Observer
}

type siteverifyResponse struct {
	Success    bool     `json:"success"`
	Hostname   string   `json:"hostname"`
	Action     string   `json:"action"`
	ErrorCodes []string `json:"error-codes"`
}

func NewVerifier(client HTTPClient, limiter RateLimiter, clock Clock, settings Settings) *Verifier {
	endpoint := strings.TrimSpace(settings.SiteverifyURL)
	if endpoint == "" {
		endpoint = defaultSiteverifyURL
	}
	return &Verifier{
		client: client, limiter: limiter, clock: clock,
		secretKey: settings.SecretKey, expectedAction: settings.ExpectedAction,
		expectedHost: settings.ExpectedHost, rateHashKey: append([]byte(nil), settings.RateHashKey...),
		siteverifyURL: endpoint, observer: settings.Observer,
	}
}

func (verifier *Verifier) VerifyAnonymousCreation(ctx context.Context, input ports.AnonymousAbuseInput) error {
	ctx, span := otel.Tracer("fukamu-cycle/turnstile").Start(ctx, "turnstile.siteverify")
	defer span.End()
	metricResult := "unavailable"
	defer func() {
		if verifier.observer != nil {
			verifier.observer.TurnstileVerification(context.WithoutCancel(ctx), metricResult)
		}
	}()
	if strings.TrimSpace(input.TurnstileToken) == "" {
		metricResult = "blocked"
		return ports.ErrAnonymousCreationBlocked
	}

	form := url.Values{
		"secret":   {verifier.secretKey},
		"response": {input.TurnstileToken},
		"remoteip": {normalizeIP(input.RemoteAddress)},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, verifier.siteverifyURL, strings.NewReader(form.Encode()))
	if err != nil {
		return errors.Join(ports.ErrAntiAbuseUnavailable, err)
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	response, err := verifier.client.Do(request)
	if err != nil {
		span.SetStatus(codes.Error, "siteverify request failed")
		return errors.Join(ports.ErrAntiAbuseUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		span.SetStatus(codes.Error, "siteverify returned non-200")
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, responseBodyLimit))
		return ports.ErrAntiAbuseUnavailable
	}

	var verification siteverifyResponse
	decoder := json.NewDecoder(io.LimitReader(response.Body, responseBodyLimit))
	if err := decoder.Decode(&verification); err != nil {
		span.SetStatus(codes.Error, "siteverify response invalid")
		return errors.Join(ports.ErrAntiAbuseUnavailable, err)
	}
	if !verification.Success || verification.Action != verifier.expectedAction ||
		!strings.EqualFold(verification.Hostname, verifier.expectedHost) {
		metricResult = "blocked"
		return ports.ErrAnonymousCreationBlocked
	}
	metricResult = "success"
	if err := verifier.limiter.Check(ctx, securehash.HMACSHA256(verifier.rateHashKey, []byte(normalizeIP(input.RemoteAddress))), verifier.clock.Now().UTC()); err != nil {
		if errors.Is(err, ports.ErrRateLimitExceeded) && verifier.observer != nil {
			verifier.observer.RateLimitRejected(context.WithoutCancel(ctx), "anonymous")
		}
		return err
	}
	return nil
}

func normalizeIP(value string) string {
	value = strings.TrimSpace(value)
	if host, _, err := net.SplitHostPort(value); err == nil {
		value = host
	}
	if parsed := net.ParseIP(value); parsed != nil {
		return parsed.String()
	}
	return value
}
