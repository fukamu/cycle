package postgres

import (
	"errors"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"
)

const completeCleanupDatabaseURL = "postgresql://url-user:url-password@db.example:6543/url-db?sslmode=disable&connect_timeout=2"

func TestValidateCleanupDatabaseURLRequiresOneExplicitTargetAndRejectsOverrides(t *testing.T) {
	t.Parallel()
	for _, databaseURL := range []string{
		"postgres://url-user@db.example/url-db",
		"postgres://url-user@[2001:db8::1]:5432/url-db",
		completeCleanupDatabaseURL,
		"postgres://cert-user@db.example:5432/cert-db?sslmode=verify-full&sslcert=%2Fcerts%2Fclient.crt&sslkey=%2Fcerts%2Fclient.key&sslrootcert=system",
	} {
		if err := ValidateCleanupDatabaseURL(databaseURL); err != nil {
			t.Fatalf("valid DATABASE_URL rejected: %v", err)
		}
	}

	invalid := []string{
		"",
		"postgres://",
		"mysql://url-user@db.example:5432/url-db",
		"postgres://db.example:5432/url-db",
		"postgres://url-user@:5432/url-db",
		"postgres://url-user@db.example:5432",
		"postgres://url-user@db.example:5432/",
		"postgres://url-user@db.example:5432/url-db/another-segment",
		"postgres://url-user@db.example:0/url-db",
		"postgres://url-user@db.example:70000/url-db",
		"postgres://url-user@first.example:5432,second.example:5432/url-db",
		"postgres://url-user@db.example:123:5432/url-db",
		"postgres://url-user@[db.example:123]:5432/url-db",
		"postgres://url-user@db.example:5432/url-db#fragment",
		"postgres://url-user@db.example:5432/url-db?sslmode=disable&sslmode=require",
		"postgres://url-user@db.example:5432/url-db?sslmode=require;connect_timeout=2",
		"postgres://url-user@db.example:5432/url-db?sslmode=%zz",
	}
	for _, key := range []string{
		"host", "port", "database", "dbname", "user", "password", "service", "servicefile", "passfile",
		"pool_max_conns", "pool_min_conns", "pool_min_idle_conns", "search_path",
	} {
		invalid = append(invalid, "postgres://url-user@db.example:5432/url-db?"+key+"=override-canary")
	}
	for _, databaseURL := range invalid {
		databaseURL := databaseURL
		t.Run(databaseURL, func(t *testing.T) {
			t.Parallel()
			err := ValidateCleanupDatabaseURL(databaseURL)
			if !errors.Is(err, ErrCleanupDatabaseConfiguration) {
				t.Fatalf("error = %v, want fixed configuration error", err)
			}
			if databaseURL != "" && strings.Contains(err.Error(), databaseURL) || strings.Contains(err.Error(), "override-canary") {
				t.Fatalf("configuration error exposed DATABASE_URL: %v", err)
			}
		})
	}
}

func TestNormalizeCleanupDatabaseURLSuppressesImplicitCredentialsAndPreservesExplicitTLS(t *testing.T) {
	t.Parallel()
	normalized, err := normalizeCleanupDatabaseURL(
		"postgres://cert-user@db.example/cert-db?sslmode=verify-full&sslcert=%2Fcerts%2Fclient.crt&sslkey=%2Fcerts%2Fclient.key&sslrootcert=system&sslpassword=cert-password",
	)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(normalized)
	if err != nil {
		t.Fatal(err)
	}
	password, passwordPresent := parsed.User.Password()
	if parsed.Hostname() != "db.example" || parsed.Port() != "5432" || parsed.User.Username() != "cert-user" ||
		!passwordPresent || password != "" || parsed.Path != "/cert-db" {
		t.Fatalf("normalized target = host:%q port:%q user:%q password-present:%v path:%q",
			parsed.Hostname(), parsed.Port(), parsed.User.Username(), passwordPresent, parsed.Path)
	}
	query := parsed.Query()
	wantTLS := map[string]string{
		"sslmode": "verify-full", "sslcert": "/certs/client.crt", "sslkey": "/certs/client.key",
		"sslrootcert": "system", "sslpassword": "cert-password",
	}
	for key, want := range wantTLS {
		if got := query.Get(key); got != want {
			t.Fatalf("normalized %s = %q, want %q", key, got, want)
		}
	}
	if !query.Has("passfile") || query.Get("passfile") != "" {
		t.Fatalf("normalized passfile = %q/present:%v, want explicit empty", query.Get("passfile"), query.Has("passfile"))
	}
}

func TestCleanupPoolConfigSuppressesImplicitCredentialAndTLSFiles(t *testing.T) {
	t.Parallel()
	normalized, err := normalizeCleanupDatabaseURL("postgres://cert-user@db.example/cert-db")
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(normalized)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	for _, key := range []string{"passfile", "sslcert", "sslkey", "sslrootcert", "sslpassword"} {
		if !query.Has(key) || query.Get(key) != "" {
			t.Fatalf("normalized %s = %q/present:%v, want explicit empty", key, query.Get(key), query.Has(key))
		}
	}
	if query.Get("sslmode") != "prefer" {
		t.Fatalf("normalized sslmode = %q, want fixed pgx default", query.Get("sslmode"))
	}

	config, err := cleanupPoolConfig("postgres://cert-user@db.example/cert-db?sslmode=disable", emptyCleanupEnvironment)
	if err != nil {
		t.Fatal(err)
	}
	if config.ConnConfig.Password != "" || config.ConnConfig.TLSConfig != nil || len(config.ConnConfig.Fallbacks) != 0 {
		t.Fatalf("implicit credential/TLS state = password-present:%v tls:%v fallbacks:%d",
			config.ConnConfig.Password != "", config.ConnConfig.TLSConfig != nil, len(config.ConnConfig.Fallbacks))
	}
}

func TestCleanupPoolConfigUsesOnlyCanonicalTargetAndFixedRuntimeParams(t *testing.T) {
	t.Parallel()
	config, err := cleanupPoolConfig(completeCleanupDatabaseURL, emptyCleanupEnvironment)
	if err != nil {
		t.Fatal(err)
	}
	if config.ConnConfig.Host != "db.example" || config.ConnConfig.Port != 6543 ||
		config.ConnConfig.Database != "url-db" || config.ConnConfig.User != "url-user" ||
		config.ConnConfig.Password != "url-password" || config.ConnConfig.TLSConfig != nil ||
		len(config.ConnConfig.Fallbacks) != 0 || config.ConnConfig.ConnectTimeout != 2*time.Second {
		t.Fatalf("pool target/config = host:%q port:%d db:%q user:%q tls:%v fallbacks:%d timeout:%s",
			config.ConnConfig.Host, config.ConnConfig.Port, config.ConnConfig.Database, config.ConnConfig.User,
			config.ConnConfig.TLSConfig != nil, len(config.ConnConfig.Fallbacks), config.ConnConfig.ConnectTimeout)
	}
	if config.MaxConns != 1 || config.MinConns != 0 || config.MinIdleConns != 0 {
		t.Fatalf("pool bounds = max:%d min:%d min-idle:%d", config.MaxConns, config.MinConns, config.MinIdleConns)
	}
	wantRuntime := map[string]string{
		"application_name": "fukamu_cleanup",
		"search_path":      "pg_catalog,public",
		"timezone":         "UTC",
	}
	if !reflect.DeepEqual(config.ConnConfig.RuntimeParams, wantRuntime) {
		t.Fatalf("runtime params = %#v, want %#v", config.ConnConfig.RuntimeParams, wantRuntime)
	}
}

func TestCleanupPoolConfigRejectsEveryPGXRecognizedAmbientVariable(t *testing.T) {
	t.Parallel()
	wantNames := []string{
		"PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGPASSFILE", "PGAPPNAME",
		"PGCONNECT_TIMEOUT", "PGSSLMODE", "PGSSLKEY", "PGSSLCERT", "PGSSLSNI", "PGSSLROOTCERT",
		"PGSSLPASSWORD", "PGSSLNEGOTIATION", "PGTARGETSESSIONATTRS", "PGSERVICE", "PGSERVICEFILE",
		"PGTZ", "PGOPTIONS", "PGMINPROTOCOLVERSION", "PGMAXPROTOCOLVERSION", "PGCHANNELBINDING", "PGREQUIREAUTH",
	}
	if !reflect.DeepEqual(cleanupPostgresEnvironmentVariables, wantNames) {
		t.Fatalf("PG* fail-closed list = %#v, want pinned pgx v5.10 list %#v", cleanupPostgresEnvironmentVariables, wantNames)
	}
	const canary = "AMBIENT_PG_VALUE_CANARY"
	for _, name := range wantNames {
		name := name
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			config, err := cleanupPoolConfig(completeCleanupDatabaseURL, func(key string) (string, bool) {
				if key == name {
					return canary, true
				}
				return "", false
			})
			if config != nil || !errors.Is(err, ErrCleanupDatabaseConfiguration) {
				t.Fatalf("config/error = %#v/%v, want fixed rejection", config, err)
			}
			if strings.Contains(err.Error(), name) || strings.Contains(err.Error(), canary) {
				t.Fatalf("ambient rejection exposed name/value: %v", err)
			}
		})
	}
}

func TestCleanupPoolConfigNeverReturnsRawParserError(t *testing.T) {
	t.Parallel()
	const canary = "RAW_DATABASE_URL_CANARY"
	config, err := cleanupPoolConfig(
		"postgres://url-user:"+canary+"@db.example:5432/url-db?sslmode=invalid-mode",
		emptyCleanupEnvironment,
	)
	if config != nil || !errors.Is(err, ErrCleanupDatabaseConfiguration) {
		t.Fatalf("config/error = %#v/%v", config, err)
	}
	if strings.Contains(err.Error(), canary) || strings.Contains(err.Error(), "invalid-mode") {
		t.Fatalf("parser error exposed DATABASE_URL: %v", err)
	}
}

func emptyCleanupEnvironment(string) (string, bool) {
	return "", false
}
