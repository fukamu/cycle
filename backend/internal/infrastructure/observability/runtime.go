package observability

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/instrumentation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/metric/exemplar"
	"go.opentelemetry.io/otel/sdk/metric/metricdata"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const (
	serviceName              = "fukamu-cycle-backend"
	metricScopeName          = "fukamu-cycle"
	traceQueueSize           = 2048
	traceExportBatchSize     = 512
	metricCardinalityLimit   = 2000
	traceBatchDelay          = 5 * time.Second
	traceProcessorTimeout    = 30 * time.Second
	metricExportInterval     = 60 * time.Second
	metricExportTimeout      = 30 * time.Second
	exporterRequestTimeout   = 10 * time.Second
	exporterRetryInitial     = 5 * time.Second
	exporterRetryMaximum     = 30 * time.Second
	exporterRetryElapsed     = time.Minute
	exporterMaxRequestSize   = 64 * 1024 * 1024
	exporterCleanupTimeout   = 5 * time.Second
	diagnosticFailureClass   = "telemetry_export_failed"
	diagnosticFailureMessage = "telemetry export failed"
)

var (
	errInvalidEnvironment    = errors.New("telemetry environment is invalid")
	errLocalExportConfigured = errors.New("external telemetry export is disabled for this environment")
	errProductionEndpoint    = errors.New("production telemetry endpoint is required")
	errProductionHeaders     = errors.New("production telemetry headers are required")
	errInvalidEndpoint       = errors.New("telemetry endpoint is invalid")
	errInvalidHeaders        = errors.New("telemetry headers are invalid")
	errUnsupportedOTelEnv    = errors.New("unsupported OpenTelemetry environment override is set")
	errTraceExporterCreate   = errors.New("telemetry trace exporter initialization failed")
	errMetricExporterCreate  = errors.New("telemetry metric exporter initialization failed")
	errRuntimeAlreadyActive  = errors.New("telemetry runtime is already active")
)

// Settings contains the environment-owned OTLP connection settings. Header
// values are deliberately kept opaque and are never included in errors or logs.
type Settings struct {
	Environment string
	Endpoint    string
	Headers     string
}

type parsedSettings struct {
	environment    string
	traceEndpoint  string
	metricEndpoint string
	headers        map[string]string
}

// ValidateSettings validates all environment and transport settings without
// constructing an exporter or making a network request.
func ValidateSettings(settings Settings) error {
	if _, err := parseSettings(settings); err != nil {
		return err
	}
	return validateOTelEnvironment(settings)
}

func validateOTelEnvironment(settings Settings) error {
	for _, entry := range os.Environ() {
		key, value, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "OTEL_") {
			continue
		}
		switch key {
		case "OTEL_EXPORTER_OTLP_ENDPOINT":
			if value == settings.Endpoint {
				continue
			}
		case "OTEL_EXPORTER_OTLP_HEADERS":
			if value == settings.Headers {
				continue
			}
		}
		return errUnsupportedOTelEnv
	}
	return nil
}

func parseSettings(settings Settings) (parsedSettings, error) {
	switch settings.Environment {
	case "development", "test":
		if settings.Endpoint != "" || settings.Headers != "" {
			return parsedSettings{}, errLocalExportConfigured
		}
		return parsedSettings{environment: settings.Environment}, nil
	case "production":
	default:
		return parsedSettings{}, errInvalidEnvironment
	}

	if settings.Endpoint == "" {
		return parsedSettings{}, errProductionEndpoint
	}
	if settings.Headers == "" {
		return parsedSettings{}, errProductionHeaders
	}

	endpoint, err := parseEndpoint(settings.Endpoint)
	if err != nil {
		return parsedSettings{}, err
	}
	headers, err := parseHeaders(settings.Headers)
	if err != nil {
		return parsedSettings{}, err
	}

	traceEndpoint, err := url.JoinPath(endpoint.String(), "v1/traces")
	if err != nil {
		return parsedSettings{}, errInvalidEndpoint
	}
	metricEndpoint, err := url.JoinPath(endpoint.String(), "v1/metrics")
	if err != nil {
		return parsedSettings{}, errInvalidEndpoint
	}
	return parsedSettings{
		environment:    settings.Environment,
		traceEndpoint:  traceEndpoint,
		metricEndpoint: metricEndpoint,
		headers:        headers,
	}, nil
}

func parseEndpoint(value string) (*url.URL, error) {
	if value != strings.TrimSpace(value) {
		return nil, errInvalidEndpoint
	}
	endpoint, err := url.Parse(value)
	if err != nil ||
		endpoint.Scheme != "https" ||
		!endpoint.IsAbs() ||
		endpoint.Opaque != "" ||
		endpoint.Host == "" ||
		endpoint.Hostname() == "" ||
		endpoint.User != nil ||
		endpoint.RawQuery != "" ||
		endpoint.ForceQuery ||
		endpoint.Fragment != "" ||
		endpoint.RawFragment != "" {
		return nil, errInvalidEndpoint
	}
	if hasUnsafeHeaderByte(endpoint.Path) {
		return nil, errInvalidEndpoint
	}
	port := endpoint.Port()
	if port == "" {
		if strings.HasSuffix(endpoint.Host, ":") {
			return nil, errInvalidEndpoint
		}
		return endpoint, nil
	}
	parsedPort, err := strconv.Atoi(port)
	if err != nil || parsedPort < 1 || parsedPort > 65535 || strconv.Itoa(parsedPort) != port {
		return nil, errInvalidEndpoint
	}
	return endpoint, nil
}

func parseHeaders(value string) (map[string]string, error) {
	if hasRawHeaderControl(value) {
		return nil, errInvalidHeaders
	}
	result := make(map[string]string)
	seen := make(map[string]struct{})
	for _, member := range strings.Split(value, ",") {
		if strings.Trim(member, " \t") == "" {
			return nil, errInvalidHeaders
		}
		key, encodedValue, found := strings.Cut(member, "=")
		key = strings.Trim(key, " \t")
		encodedValue = strings.Trim(encodedValue, " \t")
		if !found || key == "" || encodedValue == "" || !isHTTPToken(key) || hasRawHeaderWhitespace(encodedValue) {
			return nil, errInvalidHeaders
		}

		lowerKey := strings.ToLower(key)
		if _, duplicate := seen[lowerKey]; duplicate || isManagedHeader(lowerKey) {
			return nil, errInvalidHeaders
		}

		decodedValue, err := url.PathUnescape(encodedValue)
		if err != nil {
			return nil, errInvalidHeaders
		}
		if hasUnsafeHeaderByte(decodedValue) {
			return nil, errInvalidHeaders
		}
		decodedValue = strings.Trim(decodedValue, " ")
		if decodedValue == "" || strings.Contains(decodedValue, ";") {
			return nil, errInvalidHeaders
		}

		seen[lowerKey] = struct{}{}
		result[http.CanonicalHeaderKey(key)] = decodedValue
	}
	if len(result) == 0 {
		return nil, errInvalidHeaders
	}
	return result, nil
}

func isHTTPToken(value string) bool {
	for i := 0; i < len(value); i++ {
		character := value[i]
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') {
			continue
		}
		switch character {
		case '!', '#', '$', '%', '&', '\'', '*', '+', '-', '.', '^', '_', '`', '|', '~':
			continue
		default:
			return false
		}
	}
	return value != ""
}

func isManagedHeader(lowerKey string) bool {
	switch lowerKey {
	case "content-type", "content-length", "content-encoding", "proxy-authenticate", "proxy-authorization",
		"host", "connection", "keep-alive", "proxy-connection", "te", "transfer-encoding",
		"trailer", "upgrade", "traceparent", "tracestate", "baggage":
		return true
	default:
		return false
	}
}

func hasRawHeaderControl(value string) bool {
	for i := 0; i < len(value); i++ {
		if (value[i] < 0x20 && value[i] != '\t') || value[i] == 0x7f {
			return true
		}
	}
	return false
}

func hasRawHeaderWhitespace(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] <= 0x20 || value[i] == 0x7f {
			return true
		}
	}
	return false
}

func hasUnsafeHeaderByte(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] < 0x20 || value[i] == 0x7f {
			return true
		}
	}
	return false
}

type traceExporterFactory func(context.Context, ...otlptracehttp.Option) (sdktrace.SpanExporter, error)
type metricExporterFactory func(context.Context, ...otlpmetrichttp.Option) (sdkmetric.Exporter, error)

type setupOptions struct {
	httpClient        *http.Client
	newTraceExporter  traceExporterFactory
	newMetricExporter metricExporterFactory
}

// Runtime owns the SDK providers and their process-global installation.
type Runtime struct {
	traceProvider *sdktrace.TracerProvider
	meterProvider *sdkmetric.MeterProvider
	propagator    *propagation.TraceContext
	errorHandler  *safeErrorHandler

	previousTraceProvider trace.TracerProvider
	previousMeterProvider metric.MeterProvider
	previousPropagator    propagation.TextMapPropagator

	localTraceExporter  *countingSpanExporter
	localMetricExporter *countingMetricExporter

	shutdownOnce sync.Once
	shutdownErr  error
}

var (
	globalRuntimeMu sync.Mutex
	activeRuntime   *Runtime
)

// Setup constructs bounded trace and metric pipelines, then installs them as
// the process-global providers. Production construction does not perform an
// exporter request.
func Setup(ctx context.Context, logger *slog.Logger, settings Settings) (*Runtime, error) {
	return setupRuntime(ctx, logger, settings, setupOptions{})
}

func setupRuntime(ctx context.Context, logger *slog.Logger, settings Settings, options setupOptions) (*Runtime, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	parsed, err := parseSettings(settings)
	if err != nil {
		return nil, err
	}
	if err := validateOTelEnvironment(settings); err != nil {
		return nil, err
	}

	fixedResource := resource.NewWithAttributes(
		"",
		attribute.String("service.name", serviceName),
	)

	var (
		traceExporter  sdktrace.SpanExporter
		metricExporter sdkmetric.Exporter
		localTrace     *countingSpanExporter
		localMetric    *countingMetricExporter
	)
	if parsed.environment == "production" {
		traceFactory := options.newTraceExporter
		if traceFactory == nil {
			traceFactory = func(ctx context.Context, opts ...otlptracehttp.Option) (sdktrace.SpanExporter, error) {
				return otlptracehttp.New(ctx, opts...)
			}
		}
		metricFactory := options.newMetricExporter
		if metricFactory == nil {
			metricFactory = func(ctx context.Context, opts ...otlpmetrichttp.Option) (sdkmetric.Exporter, error) {
				return otlpmetrichttp.New(ctx, opts...)
			}
		}

		httpClient := pinnedHTTPClient(options.httpClient)
		traceOptions := []otlptracehttp.Option{
			otlptracehttp.WithEndpointURL(parsed.traceEndpoint),
			otlptracehttp.WithHeaders(cloneHeaders(parsed.headers)),
			otlptracehttp.WithCompression(otlptracehttp.NoCompression),
			otlptracehttp.WithTimeout(exporterRequestTimeout),
			otlptracehttp.WithMaxRequestSize(exporterMaxRequestSize),
			otlptracehttp.WithRetry(otlptracehttp.RetryConfig{
				Enabled:         true,
				InitialInterval: exporterRetryInitial,
				MaxInterval:     exporterRetryMaximum,
				MaxElapsedTime:  exporterRetryElapsed,
			}),
			otlptracehttp.WithHTTPClient(httpClient),
		}
		metricOptions := []otlpmetrichttp.Option{
			otlpmetrichttp.WithEndpointURL(parsed.metricEndpoint),
			otlpmetrichttp.WithHeaders(cloneHeaders(parsed.headers)),
			otlpmetrichttp.WithCompression(otlpmetrichttp.NoCompression),
			otlpmetrichttp.WithTimeout(exporterRequestTimeout),
			otlpmetrichttp.WithMaxRequestSize(exporterMaxRequestSize),
			otlpmetrichttp.WithRetry(otlpmetrichttp.RetryConfig{
				Enabled:         true,
				InitialInterval: exporterRetryInitial,
				MaxInterval:     exporterRetryMaximum,
				MaxElapsedTime:  exporterRetryElapsed,
			}),
			otlpmetrichttp.WithTemporalitySelector(sdkmetric.DefaultTemporalitySelector),
			otlpmetrichttp.WithAggregationSelector(sdkmetric.DefaultAggregationSelector),
			otlpmetrichttp.WithHTTPClient(httpClient),
		}

		traceExporter, err = traceFactory(ctx, traceOptions...)
		if err != nil {
			return nil, errTraceExporterCreate
		}
		metricExporter, err = metricFactory(ctx, metricOptions...)
		if err != nil {
			cleanupExporter(traceExporter)
			return nil, errMetricExporterCreate
		}
	} else {
		localTrace = &countingSpanExporter{}
		localMetric = &countingMetricExporter{}
		traceExporter = localTrace
		metricExporter = localMetric
	}

	traceProvider := newTraceProvider(fixedResource, traceExporter)
	meterProvider := newMeterProvider(fixedResource, metricExporter)

	runtime := &Runtime{
		traceProvider:       traceProvider,
		meterProvider:       meterProvider,
		propagator:          &propagation.TraceContext{},
		errorHandler:        &safeErrorHandler{logger: logger},
		localTraceExporter:  localTrace,
		localMetricExporter: localMetric,
	}

	globalRuntimeMu.Lock()
	if activeRuntime != nil {
		globalRuntimeMu.Unlock()
		cleanupProviders(traceProvider, meterProvider)
		return nil, errRuntimeAlreadyActive
	}
	runtime.previousTraceProvider = otel.GetTracerProvider()
	runtime.previousMeterProvider = otel.GetMeterProvider()
	runtime.previousPropagator = otel.GetTextMapPropagator()
	otel.SetTracerProvider(traceProvider)
	otel.SetMeterProvider(meterProvider)
	otel.SetTextMapPropagator(runtime.propagator)
	otel.SetErrorHandler(runtime.errorHandler)
	activeRuntime = runtime
	globalRuntimeMu.Unlock()

	return runtime, nil
}

func pinnedHTTPClient(source *http.Client) *http.Client {
	client := &http.Client{}
	if source != nil {
		*client = *source
	}
	client.Timeout = exporterRequestTimeout
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	client.Jar = nil

	var transport *http.Transport
	if source != nil {
		if existing, ok := source.Transport.(*http.Transport); ok {
			transport = existing.Clone()
		}
	}
	if transport == nil {
		transport = &http.Transport{
			Proxy: http.ProxyFromEnvironment,
			DialContext: (&net.Dialer{
				Timeout:   30 * time.Second,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   10 * time.Second,
			ExpectContinueTimeout: time.Second,
		}
	}
	if transport.TLSClientConfig == nil {
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	} else {
		transport.TLSClientConfig = transport.TLSClientConfig.Clone()
		if transport.TLSClientConfig.MinVersion == 0 {
			transport.TLSClientConfig.MinVersion = tls.VersionTLS12
		}
	}
	client.Transport = transport
	return client
}

func newTraceProvider(fixedResource *resource.Resource, exporter sdktrace.SpanExporter) *sdktrace.TracerProvider {
	processor := sdktrace.NewBatchSpanProcessor(
		&sanitizingSpanExporter{next: exporter, resource: fixedResource},
		sdktrace.WithMaxQueueSize(traceQueueSize),
		sdktrace.WithMaxExportBatchSize(traceExportBatchSize),
		sdktrace.WithBatchTimeout(traceBatchDelay),
		sdktrace.WithExportTimeout(traceProcessorTimeout),
	)
	return sdktrace.NewTracerProvider(
		sdktrace.WithResource(fixedResource),
		sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.AlwaysSample())),
		sdktrace.WithRawSpanLimits(sdktrace.SpanLimits{
			AttributeValueLengthLimit:   sdktrace.DefaultAttributeValueLengthLimit,
			AttributeCountLimit:         sdktrace.DefaultAttributeCountLimit,
			EventCountLimit:             sdktrace.DefaultEventCountLimit,
			LinkCountLimit:              sdktrace.DefaultLinkCountLimit,
			AttributePerEventCountLimit: sdktrace.DefaultAttributePerEventCountLimit,
			AttributePerLinkCountLimit:  sdktrace.DefaultAttributePerLinkCountLimit,
		}),
		sdktrace.WithSpanProcessor(processor),
	)
}

func newMeterProvider(fixedResource *resource.Resource, exporter sdkmetric.Exporter) *sdkmetric.MeterProvider {
	reader := sdkmetric.NewPeriodicReader(
		&sanitizingMetricExporter{next: exporter, resource: fixedResource},
		sdkmetric.WithInterval(metricExportInterval),
		sdkmetric.WithTimeout(metricExportTimeout),
	)
	return sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(fixedResource),
		sdkmetric.WithReader(reader),
		sdkmetric.WithExemplarFilter(exemplar.TraceBasedFilter),
		sdkmetric.WithCardinalityLimit(metricCardinalityLimit),
	)
}

func cloneHeaders(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func cleanupExporter(exporter sdktrace.SpanExporter) {
	ctx, cancel := context.WithTimeout(context.Background(), exporterCleanupTimeout)
	defer cancel()
	_ = exporter.Shutdown(ctx)
}

func cleanupProviders(traceProvider *sdktrace.TracerProvider, meterProvider *sdkmetric.MeterProvider) {
	ctx, cancel := context.WithTimeout(context.Background(), exporterCleanupTimeout)
	defer cancel()
	_ = runSignals(ctx, "shutdown", traceProvider.Shutdown, meterProvider.Shutdown)
}

func (runtime *Runtime) MeterProvider() metric.MeterProvider {
	if runtime == nil {
		return nil
	}
	return runtime.meterProvider
}

func (runtime *Runtime) TracerProvider() trace.TracerProvider {
	if runtime == nil {
		return nil
	}
	return runtime.traceProvider
}

func (runtime *Runtime) ForceFlush(ctx context.Context) error {
	if runtime == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	err := runSignals(ctx, "flush", runtime.traceProvider.ForceFlush, runtime.meterProvider.ForceFlush)
	if err != nil {
		runtime.errorHandler.Handle(err)
	}
	return err
}

func (runtime *Runtime) Shutdown(ctx context.Context) error {
	if runtime == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	runtime.shutdownOnce.Do(func() {
		runtime.shutdownErr = runSignals(ctx, "shutdown", runtime.traceProvider.Shutdown, runtime.meterProvider.Shutdown)
		if runtime.shutdownErr != nil {
			runtime.errorHandler.Handle(runtime.shutdownErr)
		}
		runtime.restoreGlobals()
	})
	return runtime.shutdownErr
}

func (runtime *Runtime) restoreGlobals() {
	globalRuntimeMu.Lock()
	defer globalRuntimeMu.Unlock()

	if otel.GetTracerProvider() == runtime.traceProvider {
		otel.SetTracerProvider(runtime.previousTraceProvider)
	}
	if otel.GetMeterProvider() == runtime.meterProvider {
		otel.SetMeterProvider(runtime.previousMeterProvider)
	}
	if current, ok := otel.GetTextMapPropagator().(*propagation.TraceContext); ok && current == runtime.propagator {
		otel.SetTextMapPropagator(runtime.previousPropagator)
	}
	if current, ok := otel.GetErrorHandler().(*safeErrorHandler); ok && current == runtime.errorHandler {
		// Never restore a raw/default handler: an exporter goroutine can report
		// a late failure after a deadline-bounded shutdown has returned.
		otel.SetErrorHandler(&safeErrorHandler{})
	}
	if activeRuntime == runtime {
		activeRuntime = nil
	}
}

type signalResult struct {
	signal string
	err    error
}

func runSignals(
	ctx context.Context,
	operation string,
	traceOperation func(context.Context) error,
	metricOperation func(context.Context) error,
) error {
	results := make(chan signalResult, 2)
	started := make(chan struct{}, 2)
	go func() {
		started <- struct{}{}
		results <- signalResult{signal: "trace", err: traceOperation(ctx)}
	}()
	go func() {
		started <- struct{}{}
		results <- signalResult{signal: "metric", err: metricOperation(ctx)}
	}()
	<-started
	<-started

	var failures []error
	for completed := 0; completed < 2; {
		select {
		case result := <-results:
			completed++
			if result.err != nil {
				failures = append(failures, errors.New("telemetry "+result.signal+" "+operation+" failed"))
			}
		case <-ctx.Done():
			failures = append(failures, errors.New("telemetry "+operation+" deadline exceeded"))
			return errors.Join(failures...)
		}
	}
	return errors.Join(failures...)
}

type safeErrorHandler struct {
	logger *slog.Logger
	count  atomic.Uint64
}

func (handler *safeErrorHandler) Handle(error) {
	count := handler.count.Add(1)
	if handler.logger == nil || (count != 1 && count&(count-1) != 0) {
		return
	}
	handler.logger.Warn(
		diagnosticFailureMessage,
		slog.String("error_class", diagnosticFailureClass),
		slog.Uint64("failure_count", count),
	)
}

type countingSpanExporter struct {
	exportCalls atomic.Uint64
	spanCount   atomic.Uint64
	shutdown    atomic.Bool
}

func (exporter *countingSpanExporter) ExportSpans(_ context.Context, spans []sdktrace.ReadOnlySpan) error {
	if exporter.shutdown.Load() {
		return errors.New("telemetry trace exporter is shut down")
	}
	exporter.exportCalls.Add(1)
	exporter.spanCount.Add(uint64(len(spans)))
	return nil
}

func (exporter *countingSpanExporter) Shutdown(context.Context) error {
	exporter.shutdown.Store(true)
	return nil
}

type countingMetricExporter struct {
	exportCalls atomic.Uint64
	metricCount atomic.Uint64
	shutdown    atomic.Bool
}

func (*countingMetricExporter) Temporality(kind sdkmetric.InstrumentKind) metricdata.Temporality {
	return sdkmetric.DefaultTemporalitySelector(kind)
}

func (*countingMetricExporter) Aggregation(kind sdkmetric.InstrumentKind) sdkmetric.Aggregation {
	return sdkmetric.DefaultAggregationSelector(kind)
}

func (exporter *countingMetricExporter) Export(_ context.Context, metrics *metricdata.ResourceMetrics) error {
	if exporter.shutdown.Load() {
		return sdkmetric.ErrExporterShutdown
	}
	exporter.exportCalls.Add(1)
	var count uint64
	for _, scopeMetrics := range metrics.ScopeMetrics {
		count += uint64(len(scopeMetrics.Metrics))
	}
	exporter.metricCount.Add(count)
	return nil
}

func (*countingMetricExporter) ForceFlush(context.Context) error {
	return nil
}

func (exporter *countingMetricExporter) Shutdown(context.Context) error {
	exporter.shutdown.Store(true)
	return nil
}

type sanitizingMetricExporter struct {
	next     sdkmetric.Exporter
	resource *resource.Resource
}

func (exporter *sanitizingMetricExporter) Temporality(kind sdkmetric.InstrumentKind) metricdata.Temporality {
	return exporter.next.Temporality(kind)
}

func (exporter *sanitizingMetricExporter) Aggregation(kind sdkmetric.InstrumentKind) sdkmetric.Aggregation {
	return exporter.next.Aggregation(kind)
}

func (exporter *sanitizingMetricExporter) Export(ctx context.Context, metrics *metricdata.ResourceMetrics) error {
	sanitized := metricdata.ResourceMetrics{Resource: exporter.resource}
	for _, scopeMetrics := range metrics.ScopeMetrics {
		if scopeMetrics.Scope.Name != metricScopeName {
			continue
		}
		safeScope := metricdata.ScopeMetrics{
			Scope: instrumentation.Scope{Name: metricScopeName},
		}
		for _, sourceMetric := range scopeMetrics.Metrics {
			safeMetric, ok := sanitizeMetric(sourceMetric)
			if ok {
				safeScope.Metrics = append(safeScope.Metrics, safeMetric)
			}
		}
		if len(safeScope.Metrics) != 0 {
			sanitized.ScopeMetrics = append(sanitized.ScopeMetrics, safeScope)
		}
	}
	return exporter.next.Export(ctx, &sanitized)
}

func sanitizeMetric(source metricdata.Metrics) (metricdata.Metrics, bool) {
	unit, ok := allowedMetricUnit(source.Name)
	if !ok {
		return metricdata.Metrics{}, false
	}
	data, ok := sanitizeMetricAggregation(source.Name, source.Data)
	if !ok {
		return metricdata.Metrics{}, false
	}
	return metricdata.Metrics{Name: source.Name, Unit: unit, Data: data}, true
}

func allowedMetricUnit(name string) (string, bool) {
	switch name {
	case "http_requests_total", "autosave_total", "revision_conflict_total",
		"goal_creation_draft_created_total", "goal_started_total", "goal_review_opened_total",
		"goal_review_continued_total", "goal_terminal_total", "goal_deleted_total",
		"goal_version_created_total", "progressing_goal_limit_rejected_total",
		"progressing_goal_limit_invariant_violation_total", "cycle_started_total",
		"cycle_completed_total", "cycle_canceled_total", "ai_generation_total",
		"ai_provider_attempt_total", "ai_cost_settlement_total",
		"ai_context_current_truncated_total", "ai_context_changed_total",
		"ai_suggestion_adopted_total", "ai_context_isolation_violation_total",
		"ai_quota_rejected_total", "ai_budget_rejected_total",
		"account_upgrade_total", "google_login_total", "account_delete_total",
		"anonymous_create_total", "rate_limit_rejected_total",
		"turnstile_verification_total", "error_code_total", "ai_budget_warning_total":
		return "", true
	case "http_request_duration_ms", "autosave_duration_ms", "ai_generation_duration_ms":
		return "ms", true
	case "ai_input_tokens_total", "ai_output_tokens_total":
		return "{token}", true
	case "ai_estimated_cost_usd_total", "ai_unattributed_cost_usd_total":
		return "USD", true
	case "ai_context_cycle_count":
		return "{cycle}", true
	case "ai_budget_usage_ratio":
		return "1", true
	default:
		return "", false
	}
}

func sanitizeMetricAggregation(name string, source metricdata.Aggregation) (metricdata.Aggregation, bool) {
	switch data := source.(type) {
	case metricdata.Gauge[int64]:
		data.DataPoints = sanitizeMetricDataPoints(name, data.DataPoints)
		return data, true
	case metricdata.Gauge[float64]:
		data.DataPoints = sanitizeMetricDataPoints(name, data.DataPoints)
		return data, true
	case metricdata.Sum[int64]:
		data.DataPoints = sanitizeMetricDataPoints(name, data.DataPoints)
		return data, true
	case metricdata.Sum[float64]:
		data.DataPoints = sanitizeMetricDataPoints(name, data.DataPoints)
		return data, true
	case metricdata.Histogram[int64]:
		data.DataPoints = sanitizeHistogramDataPoints(name, data.DataPoints)
		return data, true
	case metricdata.Histogram[float64]:
		data.DataPoints = sanitizeHistogramDataPoints(name, data.DataPoints)
		return data, true
	case metricdata.ExponentialHistogram[int64]:
		data.DataPoints = sanitizeExponentialHistogramDataPoints(name, data.DataPoints)
		return data, true
	case metricdata.ExponentialHistogram[float64]:
		data.DataPoints = sanitizeExponentialHistogramDataPoints(name, data.DataPoints)
		return data, true
	case metricdata.Summary:
		result := append([]metricdata.SummaryDataPoint(nil), data.DataPoints...)
		for index := range result {
			result[index].Attributes = sanitizeMetricAttributes(name, result[index].Attributes)
		}
		data.DataPoints = result
		return data, true
	default:
		return nil, false
	}
}

func sanitizeMetricDataPoints[N int64 | float64](name string, source []metricdata.DataPoint[N]) []metricdata.DataPoint[N] {
	result := append([]metricdata.DataPoint[N](nil), source...)
	for index := range result {
		result[index].Attributes = sanitizeMetricAttributes(name, result[index].Attributes)
		result[index].Exemplars = sanitizeMetricExemplars(result[index].Exemplars)
	}
	return result
}

func sanitizeHistogramDataPoints[N int64 | float64](name string, source []metricdata.HistogramDataPoint[N]) []metricdata.HistogramDataPoint[N] {
	result := append([]metricdata.HistogramDataPoint[N](nil), source...)
	for index := range result {
		result[index].Attributes = sanitizeMetricAttributes(name, result[index].Attributes)
		result[index].Exemplars = sanitizeMetricExemplars(result[index].Exemplars)
	}
	return result
}

func sanitizeExponentialHistogramDataPoints[N int64 | float64](name string, source []metricdata.ExponentialHistogramDataPoint[N]) []metricdata.ExponentialHistogramDataPoint[N] {
	result := append([]metricdata.ExponentialHistogramDataPoint[N](nil), source...)
	for index := range result {
		result[index].Attributes = sanitizeMetricAttributes(name, result[index].Attributes)
		result[index].Exemplars = sanitizeMetricExemplars(result[index].Exemplars)
	}
	return result
}

func sanitizeMetricExemplars[N int64 | float64](source []metricdata.Exemplar[N]) []metricdata.Exemplar[N] {
	result := append([]metricdata.Exemplar[N](nil), source...)
	for index := range result {
		result[index].FilteredAttributes = nil
	}
	return result
}

func sanitizeMetricAttributes(name string, source attribute.Set) attribute.Set {
	result := make([]attribute.KeyValue, 0, source.Len())
	for _, keyValue := range source.ToSlice() {
		key := string(keyValue.Key)
		if keyValue.Value.Type() != attribute.STRING || !allowedMetricAttribute(name, key) {
			continue
		}
		result = append(result, attribute.String(key, sanitizeMetricAttributeValue(name, key, keyValue.Value.AsString())))
	}
	return attribute.NewSet(result...)
}

func allowedMetricAttribute(name, key string) bool {
	switch name {
	case "http_requests_total":
		return key == "route" || key == "status_class"
	case "http_request_duration_ms":
		return key == "route"
	case "autosave_total":
		return key == "resource_type" || key == "result"
	case "autosave_duration_ms", "revision_conflict_total":
		return key == "resource_type"
	case "goal_review_continued_total":
		return key == "version_changed"
	case "goal_terminal_total":
		return key == "outcome" || key == "source_state"
	case "goal_deleted_total":
		return key == "source_state" || key == "result"
	case "cycle_canceled_total":
		return key == "reason"
	case "ai_generation_total":
		return key == "operation_type" || key == "result" || key == "model" || key == "prompt_version"
	case "ai_generation_duration_ms":
		return key == "operation_type" || key == "model"
	case "ai_provider_attempt_total":
		return key == "operation_type" || key == "result"
	case "ai_input_tokens_total", "ai_output_tokens_total", "ai_estimated_cost_usd_total":
		return key == "model"
	case "ai_cost_settlement_total":
		return key == "path" || key == "result"
	case "ai_context_cycle_count", "ai_context_current_truncated_total", "ai_context_changed_total":
		return key == "operation_type"
	case "ai_suggestion_adopted_total":
		return key == "source_type"
	case "account_upgrade_total", "google_login_total", "account_delete_total",
		"anonymous_create_total", "turnstile_verification_total":
		return key == "result"
	case "rate_limit_rejected_total":
		return key == "scope"
	case "error_code_total":
		return key == "code"
	case "ai_budget_warning_total":
		return key == "threshold"
	default:
		return false
	}
}

func sanitizeMetricAttributeValue(name, key, value string) string {
	switch key {
	case "route":
		if isAllowedHTTPRoute(value) {
			return value
		}
		return "unmatched"
	case "status_class":
		if oneOf(value, "1xx", "2xx", "3xx", "4xx", "5xx") {
			return value
		}
	case "resource_type":
		if oneOf(value, "creation_draft", "review_draft", "cycle_frame") {
			return value
		}
	case "result":
		if allowedMetricResult(name, value) {
			return value
		}
	case "operation_type":
		if oneOf(value, "goal_refine", "action_generate", "action_refine") {
			return value
		}
	case "model":
		if oneOf(value, "gpt-5.6-luna", "gpt-5.6-terra") {
			return value
		}
	case "prompt_version":
		if oneOf(value,
			"goal-refine-v1", "action-generate-v1", "action-refine-v1",
			"goal-refine-v2", "action-generate-v2", "action-refine-v2",
		) {
			return value
		}
	case "version_changed":
		if oneOf(value, "true", "false") {
			return value
		}
	case "outcome":
		if oneOf(value, "achieved", "ended") {
			return value
		}
	case "source_state":
		if value == "" {
			return "unknown"
		}
		if oneOf(value, "active_cycle", "goal_review", "achieved", "ended", "unknown") {
			return value
		}
	case "reason":
		if oneOf(value, "goal_achieved", "goal_ended") {
			return value
		}
	case "path":
		if oneOf(value, "normal", "late", "account_delete") {
			return value
		}
	case "source_type":
		if oneOf(value, "creation", "review") {
			return value
		}
	case "scope":
		if oneOf(value, "ai", "anonymous", "auth", "session") {
			return value
		}
	case "code":
		if isAllowedMetricErrorCode(value) {
			return value
		}
		return "OTHER"
	case "threshold":
		threshold, err := strconv.ParseFloat(value, 64)
		if err == nil && threshold > 0 && threshold < 1 && strconv.FormatFloat(threshold, 'f', -1, 64) == value {
			return value
		}
	}
	return "other"
}

func allowedMetricResult(name, value string) bool {
	switch name {
	case "autosave_total":
		return oneOf(value, "success", "failure", "conflict")
	case "goal_deleted_total", "ai_cost_settlement_total":
		return oneOf(value, "success", "failure", "idempotent")
	case "ai_generation_total":
		return oneOf(value, "success", "failure")
	case "ai_provider_attempt_total":
		return oneOf(value, "success", "failure", "invalid_response", "timeout", "unavailable", "rejected")
	case "anonymous_create_total":
		return oneOf(value, "success", "failure", "idempotent")
	case "account_upgrade_total", "google_login_total", "account_delete_total":
		return oneOf(value, "success", "failure")
	case "turnstile_verification_total":
		return oneOf(value, "success", "blocked", "unavailable")
	default:
		return false
	}
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

func isAllowedMetricErrorCode(value string) bool {
	switch value {
	case "ACCOUNT_DELETE_CONFIRMATION_REQUIRED", "ACCOUNT_DELETE_FAILED", "ACCOUNT_UPGRADE_FAILED",
		"ACTION_GENERATE_INPUT_INCOMPLETE", "ACTION_REFINE_INPUT_INCOMPLETE", "ACTION_REPLACEMENT_CONFIRMATION_REQUIRED",
		"AI_INVALID_RESPONSE", "AI_OPERATION_IN_PROGRESS", "AI_PROVIDER_TIMEOUT", "AI_PROVIDER_UNAVAILABLE",
		"AI_RATE_LIMIT_EXCEEDED", "AI_SERVICE_BUDGET_EXCEEDED", "AI_SUGGESTION_NOT_FOUND", "AI_USER_ROLLING_LIMIT_EXCEEDED",
		"ANONYMOUS_CREATION_BLOCKED", "ANTI_ABUSE_SERVICE_UNAVAILABLE", "CSRF_INVALID",
		"CYCLE_COMPLETION_FAILED", "CYCLE_COMPLETION_INPUT_INCOMPLETE", "CYCLE_NOT_ACTIVE", "CYCLE_NOT_FOUND", "CYCLE_REVISION_CONFLICT",
		"FRAME_SAVE_FAILED", "FRAME_TEXT_TOO_LONG", "GOAL_ACTIVE_LIMIT_EXCEEDED", "GOAL_ALREADY_TERMINAL",
		"GOAL_CREATION_DRAFT_ALREADY_EXISTS", "GOAL_DELETE_CONFIRMATION_REQUIRED", "GOAL_DELETE_CONFLICT", "GOAL_DELETE_FAILED",
		"GOAL_DRAFT_DELETE_FAILED", "GOAL_DRAFT_NOT_FOUND", "GOAL_DRAFT_REVISION_CONFLICT", "GOAL_DRAFT_SAVE_FAILED", "GOAL_DRAFT_TYPE_MISMATCH",
		"GOAL_NOT_FOUND", "GOAL_REFINE_CONTEXT_STALE", "GOAL_REFINE_INPUT_EMPTY", "GOAL_REFINE_RESULT_ALREADY_ADOPTED",
		"GOAL_REVIEW_CONTINUE_FAILED", "GOAL_REVIEW_DISCARD_CONFIRMATION_REQUIRED", "GOAL_REVIEW_DRAFT_REVISION_CONFLICT",
		"GOAL_REVIEW_DRAFT_SAVE_FAILED", "GOAL_REVIEW_INVARIANT_BROKEN", "GOAL_REVIEW_NOT_ACTIVE", "GOAL_START_FAILED",
		"GOAL_STATE_CONFLICT", "GOAL_TERMINATION_FAILED", "GOAL_TEXT_REQUIRED", "GOAL_TEXT_TOO_LONG", "GOAL_VERSION_CONFLICT",
		"GOOGLE_ACCOUNT_NOT_LINKED", "GOOGLE_IDENTITY_ALREADY_LINKED", "GOOGLE_IDENTITY_VERIFICATION_UNAVAILABLE", "GOOGLE_ID_TOKEN_INVALID",
		"GOOGLE_LOGIN_FAILED", "IDEMPOTENCY_KEY_REUSED", "INTERNAL_ERROR", "INVALID_CURSOR", "INVALID_GOAL_OUTCOME",
		"SESSION_EXPIRED", "SESSION_IDENTITY_CHANGED", "SESSION_MISSING", "VALIDATION_ERROR":
		return true
	default:
		return false
	}
}

func (exporter *sanitizingMetricExporter) ForceFlush(ctx context.Context) error {
	return exporter.next.ForceFlush(ctx)
}

func (exporter *sanitizingMetricExporter) Shutdown(ctx context.Context) error {
	return exporter.next.Shutdown(ctx)
}

type sanitizingSpanExporter struct {
	next     sdktrace.SpanExporter
	resource *resource.Resource
}

func (exporter *sanitizingSpanExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	sanitized := make([]sdktrace.ReadOnlySpan, len(spans))
	for index, span := range spans {
		sanitized[index] = sanitizeSpan(span, exporter.resource)
	}
	return exporter.next.ExportSpans(ctx, sanitized)
}

func (exporter *sanitizingSpanExporter) Shutdown(ctx context.Context) error {
	return exporter.next.Shutdown(ctx)
}

type sanitizedReadOnlySpan struct {
	sdktrace.ReadOnlySpan

	name              string
	spanContext       trace.SpanContext
	parent            trace.SpanContext
	attributes        []attribute.KeyValue
	links             []sdktrace.Link
	status            sdktrace.Status
	scope             instrumentation.Scope
	resource          *resource.Resource
	droppedAttributes int
	droppedEvents     int
}

func sanitizeSpan(span sdktrace.ReadOnlySpan, fixedResource *resource.Resource) sdktrace.ReadOnlySpan {
	class := classifySpan(span)
	attributes := sanitizeAttributes(class, span.Attributes())
	links := sanitizeLinks(span.Links())
	return &sanitizedReadOnlySpan{
		ReadOnlySpan:      span,
		name:              sanitizedSpanName(class, span.Name()),
		spanContext:       withoutTraceState(span.SpanContext()),
		parent:            withoutTraceState(span.Parent()),
		attributes:        attributes,
		links:             links,
		status:            sanitizeStatus(class, span.Status()),
		scope:             instrumentation.Scope{Name: sanitizedScopeName(class)},
		resource:          fixedResource,
		droppedAttributes: span.DroppedAttributes() + len(span.Attributes()) - len(attributes),
		droppedEvents:     span.DroppedEvents() + len(span.Events()),
	}
}

func (span *sanitizedReadOnlySpan) Name() string {
	return span.name
}

func (span *sanitizedReadOnlySpan) SpanContext() trace.SpanContext {
	return span.spanContext
}

func (span *sanitizedReadOnlySpan) Parent() trace.SpanContext {
	return span.parent
}

func (span *sanitizedReadOnlySpan) Attributes() []attribute.KeyValue {
	return append([]attribute.KeyValue(nil), span.attributes...)
}

func (span *sanitizedReadOnlySpan) Links() []sdktrace.Link {
	return append([]sdktrace.Link(nil), span.links...)
}

func (*sanitizedReadOnlySpan) Events() []sdktrace.Event {
	return nil
}

func (span *sanitizedReadOnlySpan) Status() sdktrace.Status {
	return span.status
}

func (span *sanitizedReadOnlySpan) InstrumentationScope() instrumentation.Scope {
	return span.scope
}

func (span *sanitizedReadOnlySpan) InstrumentationLibrary() instrumentation.Library {
	return span.scope
}

func (span *sanitizedReadOnlySpan) Resource() *resource.Resource {
	return span.resource
}

func (span *sanitizedReadOnlySpan) DroppedAttributes() int {
	return span.droppedAttributes
}

func (span *sanitizedReadOnlySpan) DroppedEvents() int {
	return span.droppedEvents
}

func withoutTraceState(spanContext trace.SpanContext) trace.SpanContext {
	return trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    spanContext.TraceID(),
		SpanID:     spanContext.SpanID(),
		TraceFlags: spanContext.TraceFlags(),
		Remote:     spanContext.IsRemote(),
	})
}

func sanitizeLinks(links []sdktrace.Link) []sdktrace.Link {
	result := make([]sdktrace.Link, len(links))
	for index, link := range links {
		result[index] = sdktrace.Link{
			SpanContext:           withoutTraceState(link.SpanContext),
			DroppedAttributeCount: link.DroppedAttributeCount + len(link.Attributes),
		}
	}
	return result
}

type spanClass uint8

const (
	spanClassApplication spanClass = iota
	spanClassHTTP
	spanClassPostgres
	spanClassGoogleIdentity
	spanClassTurnstile
	spanClassOpenAI
)

func classifySpan(span sdktrace.ReadOnlySpan) spanClass {
	switch span.InstrumentationScope().Name {
	case "fukamu-cycle/http":
		return spanClassHTTP
	case "fukamu-cycle/postgres":
		return spanClassPostgres
	case "fukamu-cycle/google-identity":
		if span.Name() == "google.identity.verify" {
			return spanClassGoogleIdentity
		}
	case "fukamu-cycle/turnstile":
		if span.Name() == "turnstile.siteverify" {
			return spanClassTurnstile
		}
	case "fukamu-cycle/openai":
		if span.Name() == "openai.responses.create" {
			return spanClassOpenAI
		}
	}
	return spanClassApplication
}

func sanitizedSpanName(class spanClass, original string) string {
	switch class {
	case spanClassHTTP:
		return "http.request"
	case spanClassPostgres:
		if isAllowedPostgresSpanName(original) {
			return original
		}
		return "postgres.other"
	case spanClassGoogleIdentity, spanClassTurnstile, spanClassOpenAI:
		return original
	default:
		return "application.operation"
	}
}

func sanitizedScopeName(class spanClass) string {
	switch class {
	case spanClassHTTP:
		return "fukamu-cycle/http"
	case spanClassPostgres:
		return "fukamu-cycle/postgres"
	case spanClassGoogleIdentity:
		return "fukamu-cycle/google-identity"
	case spanClassTurnstile:
		return "fukamu-cycle/turnstile"
	case spanClassOpenAI:
		return "fukamu-cycle/openai"
	default:
		return "fukamu-cycle/application"
	}
}

func isAllowedPostgresSpanName(name string) bool {
	if !strings.HasPrefix(name, "postgres.") {
		return false
	}
	return isAllowedDatabaseOperation(strings.TrimPrefix(name, "postgres."))
}

func sanitizeAttributes(class spanClass, source []attribute.KeyValue) []attribute.KeyValue {
	result := make([]attribute.KeyValue, 0, len(source))
	for _, keyValue := range source {
		key := string(keyValue.Key)
		if safe, ok := sanitizeCorrelationAttribute(class, keyValue); ok {
			result = append(result, safe)
			continue
		}
		switch class {
		case spanClassHTTP:
			switch key {
			case "http.request.method":
				if keyValue.Value.Type() == attribute.STRING {
					method := keyValue.Value.AsString()
					if !isAllowedHTTPMethod(method) {
						method = "OTHER"
					}
					result = append(result, attribute.String(key, method))
				}
			case "http.route":
				if keyValue.Value.Type() == attribute.STRING {
					route := keyValue.Value.AsString()
					if !isAllowedHTTPRoute(route) {
						route = "unmatched"
					}
					result = append(result, attribute.String(key, route))
				}
			case "http.response.status_code":
				if keyValue.Value.Type() == attribute.INT64 {
					status := keyValue.Value.AsInt64()
					if status >= 100 && status <= 599 {
						result = append(result, attribute.Int64(key, status))
					}
				}
			}
		case spanClassPostgres:
			switch key {
			case "db.system.name":
				if keyValue.Value.Type() == attribute.STRING && keyValue.Value.AsString() == "postgresql" {
					result = append(result, attribute.String(key, "postgresql"))
				}
			case "db.operation.name":
				if keyValue.Value.Type() == attribute.STRING {
					operation := keyValue.Value.AsString()
					if !isAllowedDatabaseOperation(operation) {
						operation = "other"
					}
					result = append(result, attribute.String(key, operation))
				}
			}
		}
	}
	return result
}

func sanitizeCorrelationAttribute(class spanClass, keyValue attribute.KeyValue) (attribute.KeyValue, bool) {
	if keyValue.Value.Type() != attribute.STRING {
		return attribute.KeyValue{}, false
	}
	key := string(keyValue.Key)
	value := keyValue.Value.AsString()
	switch key {
	case "fukamu.request_id":
		if class != spanClassHTTP && class != spanClassPostgres && class != spanClassOpenAI {
			return attribute.KeyValue{}, false
		}
		if isCanonicalCorrelationUUIDv7(value) {
			return attribute.String(key, value), true
		}
	case "fukamu.ai_generation_id":
		if (class == spanClassPostgres || class == spanClassOpenAI) && isCanonicalCorrelationUUIDv7(value) {
			return attribute.String(key, value), true
		}
	case "fukamu.ai_operation_type":
		if class == spanClassPostgres || class == spanClassOpenAI {
			switch value {
			case "goal_refine", "action_generate", "action_refine":
				return attribute.String(key, value), true
			}
		}
	}
	return attribute.KeyValue{}, false
}

func isCanonicalCorrelationUUIDv7(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' ||
		value[14] != '7' || !strings.ContainsRune("89ab", rune(value[19])) {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	return true
}

func isAllowedHTTPMethod(method string) bool {
	switch method {
	case "CONNECT", "DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT", "TRACE", "OTHER":
		return true
	default:
		return false
	}
}

func isAllowedDatabaseOperation(operation string) bool {
	switch operation {
	case "begin", "commit", "delete", "insert", "other", "query", "rollback", "select", "update", "with":
		return true
	default:
		return false
	}
}

func isAllowedHTTPRoute(route string) bool {
	switch route {
	case "unmatched", "/*", "/healthz", "/readyz",
		"/api/v1/session/anonymous", "/api/v1/session", "/api/v1/home",
		"/api/v1/goal-drafts", "/api/v1/goal-drafts/{draftId}",
		"/api/v1/goal-drafts/{draftId}/refinements",
		"/api/v1/goal-drafts/{draftId}/refinements/{generationId}/adopt",
		"/api/v1/goal-drafts/{draftId}/start",
		"/api/v1/goals", "/api/v1/goals/{goalId}",
		"/api/v1/goals/{goalId}/termination",
		"/api/v1/goals/{goalId}/review",
		"/api/v1/goals/{goalId}/review/refinements",
		"/api/v1/goals/{goalId}/review/refinements/{generationId}/adopt",
		"/api/v1/goals/{goalId}/review/continue",
		"/api/v1/goals/{goalId}/cycles",
		"/api/v1/goals/{goalId}/cycles/{cycleId}",
		"/api/v1/goals/{goalId}/cycles/{cycleId}/frames/{frame}",
		"/api/v1/goals/{goalId}/cycles/{cycleId}/actions/generate",
		"/api/v1/goals/{goalId}/cycles/{cycleId}/actions/refine",
		"/api/v1/goals/{goalId}/cycles/{cycleId}/complete",
		"/api/v1/auth/google/upgrade", "/api/v1/auth/google/login",
		"/api/v1/account":
		return true
	default:
		return false
	}
}

func sanitizeStatus(class spanClass, status sdktrace.Status) sdktrace.Status {
	if status.Code != codes.Error {
		return sdktrace.Status{Code: status.Code}
	}
	switch class {
	case spanClassHTTP:
		return sdktrace.Status{Code: codes.Error, Description: "HTTP request failed"}
	case spanClassPostgres:
		return sdktrace.Status{Code: codes.Error, Description: "database operation failed"}
	case spanClassGoogleIdentity:
		return sdktrace.Status{Code: codes.Error, Description: "identity verification failed"}
	case spanClassTurnstile:
		return sdktrace.Status{Code: codes.Error, Description: "siteverify request failed"}
	case spanClassOpenAI:
		return sdktrace.Status{Code: codes.Error, Description: "provider request failed"}
	default:
		return sdktrace.Status{Code: codes.Error, Description: "operation failed"}
	}
}
