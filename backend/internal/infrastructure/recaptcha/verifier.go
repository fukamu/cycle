package recaptcha

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"errors"
	"net"
	"strings"
	"time"

	client "cloud.google.com/go/recaptchaenterprise/v2/apiv1"
	recaptchapb "cloud.google.com/go/recaptchaenterprise/v2/apiv1/recaptchaenterprisepb"

	"github.com/matoruru/PDCAI/backend/internal/application/ports"
)

type RateLimiter interface {
	Check(context.Context, []byte, time.Time) error
}

type Clock interface {
	Now() time.Time
}

type AssessmentClient interface {
	CreateAssessment(context.Context, *recaptchapb.CreateAssessmentRequest, ...any) (*recaptchapb.Assessment, error)
}

type cloudAssessmentClient struct {
	client *client.Client
}

func (adapter cloudAssessmentClient) CreateAssessment(ctx context.Context, request *recaptchapb.CreateAssessmentRequest, _ ...any) (*recaptchapb.Assessment, error) {
	return adapter.client.CreateAssessment(ctx, request)
}

type Verifier struct {
	client         AssessmentClient
	limiter        RateLimiter
	clock          Clock
	projectID      string
	siteKey        string
	expectedAction string
	expectedHost   string
	threshold      float32
	rateHashKey    []byte
}

type Settings struct {
	ProjectID      string
	SiteKey        string
	ExpectedAction string
	ExpectedHost   string
	ScoreThreshold float64
	RateHashKey    []byte
}

func NewVerifier(cloudClient *client.Client, limiter RateLimiter, clock Clock, settings Settings) *Verifier {
	return &Verifier{
		client: cloudAssessmentClient{client: cloudClient}, limiter: limiter, clock: clock,
		projectID: settings.ProjectID, siteKey: settings.SiteKey, expectedAction: settings.ExpectedAction,
		expectedHost: settings.ExpectedHost, threshold: float32(settings.ScoreThreshold),
		rateHashKey: append([]byte(nil), settings.RateHashKey...),
	}
}

func (verifier *Verifier) VerifyAnonymousCreation(ctx context.Context, input ports.AnonymousAbuseInput) error {
	if strings.TrimSpace(input.RecaptchaToken) == "" {
		return ports.ErrAnonymousCreationBlocked
	}
	assessment, err := verifier.client.CreateAssessment(ctx, &recaptchapb.CreateAssessmentRequest{
		Parent: "projects/" + verifier.projectID,
		Assessment: &recaptchapb.Assessment{Event: &recaptchapb.Event{
			Token: input.RecaptchaToken, SiteKey: verifier.siteKey,
			ExpectedAction: verifier.expectedAction, UserAgent: input.UserAgent, UserIpAddress: input.RemoteAddress,
		}},
	})
	if err != nil {
		return errors.Join(ports.ErrAntiAbuseUnavailable, err)
	}
	properties := assessment.GetTokenProperties()
	risk := assessment.GetRiskAnalysis()
	if properties == nil || risk == nil || !properties.GetValid() || properties.GetAction() != verifier.expectedAction ||
		!strings.EqualFold(properties.GetHostname(), verifier.expectedHost) || risk.GetScore() < verifier.threshold {
		return ports.ErrAnonymousCreationBlocked
	}
	if err := verifier.limiter.Check(ctx, hash(verifier.rateHashKey, normalizeIP(input.RemoteAddress)), verifier.clock.Now().UTC()); err != nil {
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

func hash(key []byte, value string) []byte {
	digest := hmac.New(sha256.New, key)
	_, _ = digest.Write([]byte(value))
	return digest.Sum(nil)
}
