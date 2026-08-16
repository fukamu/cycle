package recaptcha

import (
	"context"
	"errors"
	"testing"
	"time"

	recaptchapb "cloud.google.com/go/recaptchaenterprise/v2/apiv1/recaptchaenterprisepb"

	"github.com/matoruru/PDCAI/backend/internal/application/ports"
)

func TestVerifierAcceptsMatchingAssessmentAndHashesNormalizedIP(t *testing.T) {
	t.Parallel()
	limiter := &fakeLimiter{}
	verifier := testVerifier(&fakeAssessmentClient{assessment: validAssessment(0.8)}, limiter)
	err := verifier.VerifyAnonymousCreation(context.Background(), ports.AnonymousAbuseInput{
		RecaptchaToken: "opaque-token", RemoteAddress: "203.0.113.10:54321", UserAgent: "test-agent",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(limiter.key) == 0 || string(limiter.key) == "203.0.113.10" {
		t.Fatalf("rate key was not pseudonymized: %q", limiter.key)
	}
}

func TestVerifierFailsClosedForInvalidSignals(t *testing.T) {
	t.Parallel()
	tests := map[string]*recaptchapb.Assessment{
		"low score": validAssessment(0.49),
		"wrong action": {
			TokenProperties: &recaptchapb.TokenProperties{Valid: true, Action: "other", Hostname: "pdcai.example"},
			RiskAnalysis:    &recaptchapb.RiskAnalysis{Score: 0.9},
		},
		"wrong hostname": {
			TokenProperties: &recaptchapb.TokenProperties{Valid: true, Action: "anonymous_bootstrap", Hostname: "evil.example"},
			RiskAnalysis:    &recaptchapb.RiskAnalysis{Score: 0.9},
		},
	}
	for name, assessment := range tests {
		assessment := assessment
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			err := testVerifier(&fakeAssessmentClient{assessment: assessment}, &fakeLimiter{}).VerifyAnonymousCreation(
				context.Background(), ports.AnonymousAbuseInput{RecaptchaToken: "token", RemoteAddress: "203.0.113.1"},
			)
			if !errors.Is(err, ports.ErrAnonymousCreationBlocked) {
				t.Fatalf("error = %v", err)
			}
		})
	}
}

func TestVerifierTreatsAssessmentFailureAsUnavailable(t *testing.T) {
	t.Parallel()
	err := testVerifier(&fakeAssessmentClient{err: errors.New("service down")}, &fakeLimiter{}).VerifyAnonymousCreation(
		context.Background(), ports.AnonymousAbuseInput{RecaptchaToken: "token", RemoteAddress: "203.0.113.1"},
	)
	if !errors.Is(err, ports.ErrAntiAbuseUnavailable) {
		t.Fatalf("error = %v", err)
	}
}

func validAssessment(score float32) *recaptchapb.Assessment {
	return &recaptchapb.Assessment{
		TokenProperties: &recaptchapb.TokenProperties{Valid: true, Action: "anonymous_bootstrap", Hostname: "pdcai.example"},
		RiskAnalysis:    &recaptchapb.RiskAnalysis{Score: score},
	}
}

func testVerifier(client AssessmentClient, limiter RateLimiter) *Verifier {
	return &Verifier{
		client: client, limiter: limiter, clock: recaptchaFakeClock{}, projectID: "project", siteKey: "site",
		expectedAction: "anonymous_bootstrap", expectedHost: "pdcai.example", threshold: 0.5,
		rateHashKey: []byte("rate-key"),
	}
}

type fakeAssessmentClient struct {
	assessment *recaptchapb.Assessment
	err        error
}

func (client *fakeAssessmentClient) CreateAssessment(context.Context, *recaptchapb.CreateAssessmentRequest, ...any) (*recaptchapb.Assessment, error) {
	return client.assessment, client.err
}

type fakeLimiter struct {
	key []byte
	err error
}

func (limiter *fakeLimiter) Check(_ context.Context, key []byte, _ time.Time) error {
	limiter.key = append([]byte(nil), key...)
	return limiter.err
}

type recaptchaFakeClock struct{}

func (recaptchaFakeClock) Now() time.Time {
	return time.Date(2026, time.August, 16, 0, 0, 0, 0, time.UTC)
}
