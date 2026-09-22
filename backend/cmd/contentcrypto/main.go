package main

import (
	"context"
	"encoding/json"
	"flag"
	"io"
	"os"
	"time"

	"github.com/google/uuid"

	"github.com/fukamu/cycle/backend/internal/config"
	"github.com/fukamu/cycle/backend/internal/infrastructure/contentcrypto"
	"github.com/fukamu/cycle/backend/internal/infrastructure/postgres"
	"github.com/fukamu/cycle/backend/internal/infrastructure/safelog"
)

type commandOptions struct {
	status, activateWrites, backfill, verify, strict bool
	execute                                          bool
	batchSize                                        int
	rotateUser                                       string
}

type commandResult struct {
	Action     string                             `json:"action"`
	Mode       string                             `json:"mode,omitempty"`
	Generation int64                              `json:"generation,omitempty"`
	LegacyRows int64                              `json:"legacyRows,omitempty"`
	RunningAI  int64                              `json:"runningAI,omitempty"`
	Processed  int64                              `json:"processed,omitempty"`
	Conflicts  int64                              `json:"conflicts,omitempty"`
	Fields     int64                              `json:"fields,omitempty"`
	Version    int32                              `json:"version,omitempty"`
	Storage    []postgres.ContentStorageInventory `json:"storage,omitempty"`
	Keys       []postgres.ContentDEKInventory     `json:"keys,omitempty"`
	Jobs       []postgres.ContentJobInventory     `json:"jobs,omitempty"`
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(arguments []string) int {
	logger := safelog.NewJSON(os.Stderr)
	flags := flag.NewFlagSet("contentcrypto", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	options := commandOptions{}
	flags.BoolVar(&options.status, "status", false, "show durable encryption state")
	flags.BoolVar(&options.activateWrites, "activate-writes", false, "switch legacy to encrypting")
	flags.BoolVar(&options.backfill, "backfill", false, "encrypt all remaining legacy rows")
	flags.BoolVar(&options.verify, "verify", false, "authenticate and decrypt every encrypted field")
	flags.BoolVar(&options.strict, "strict", false, "switch encrypting to strict")
	flags.StringVar(&options.rotateUser, "rotate-user-dek", "", "create and activate a new DEK version for one User UUID")
	flags.BoolVar(&options.execute, "execute", false, "authorize the selected state-changing operation")
	flags.IntVar(&options.batchSize, "batch-size", 200, "bounded batch size (1..1000)")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return 2
	}
	selected := 0
	for _, enabled := range []bool{options.status, options.activateWrites, options.backfill, options.verify, options.strict} {
		if enabled {
			selected++
		}
	}
	if options.rotateUser != "" {
		selected++
	}
	if selected != 1 || options.batchSize < 1 || options.batchSize > 1000 {
		logger.Error("content encryption command failed", "error_class", "content_encryption_arguments_invalid")
		return 2
	}
	if (options.activateWrites || options.backfill || options.strict || options.rotateUser != "") && !options.execute {
		logger.Error("content encryption command failed", "error_class", "content_encryption_confirmation_required")
		return 2
	}
	if options.rotateUser != "" {
		if _, parseErr := uuid.Parse(options.rotateUser); parseErr != nil {
			logger.Error("content encryption command failed", "error_class", "content_encryption_user_invalid")
			return 2
		}
	}
	settings, err := config.Load(os.LookupEnv)
	if err != nil {
		logger.Error("content encryption command failed", "error_class", "content_encryption_configuration_invalid")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	pool, err := postgres.Open(ctx, settings.Database)
	if err != nil {
		logger.Error("content encryption command failed", "error_class", "content_encryption_database_unavailable")
		return 1
	}
	defer pool.Close()
	keyManagement, err := contentcrypto.NewConfiguredKeyManagement(ctx, settings.ContentEncryption)
	if err != nil {
		logger.Error("content encryption command failed", "error_class", "content_encryption_key_service_unavailable")
		return 1
	}
	service := contentcrypto.NewService(postgres.NewContentKeyRepository(pool), keyManagement)
	defer service.Close()
	operator := postgres.NewContentEncryptionOperator(pool, service)
	encoder := json.NewEncoder(os.Stdout)

	switch {
	case options.status:
		state, stateErr := operator.State(ctx)
		if stateErr != nil {
			logger.Error("content encryption command failed", "error_class", "content_encryption_status_failed")
			return 1
		}
		storage, keys, jobs, inventoryErr := operator.Inventory(ctx)
		if inventoryErr != nil {
			logger.Error("content encryption command failed", "error_class", "content_encryption_status_failed")
			return 1
		}
		err = encoder.Encode(commandResult{
			Action: "status", Mode: state.Mode, Generation: state.Generation,
			LegacyRows: state.LegacyRows, RunningAI: state.RunningAI,
			Storage: storage, Keys: keys, Jobs: jobs,
		})
	case options.activateWrites:
		if err = operator.ActivateWrites(ctx, time.Now().UTC()); err != nil {
			logger.Error("content encryption command failed", "error_class", "content_encryption_activation_failed")
			return 1
		}
		err = encoder.Encode(commandResult{Action: "activate_writes"})
	case options.backfill:
		jobID, jobErr := startJob(ctx, operator, "backfill", "encrypt_legacy_rows")
		if jobErr != nil {
			logger.Error("content encryption command failed", "error_class", "content_encryption_job_start_failed")
			return 1
		}
		var processed, conflicts int64
		for {
			batch, batchErr := operator.BackfillBatch(ctx, options.batchSize)
			if batchErr != nil {
				failJob(ctx, operator, jobID, "backfill_failed")
				logger.Error("content encryption command failed", "error_class", "content_encryption_backfill_failed")
				return 1
			}
			if progressErr := operator.RecordJobProgress(
				ctx, jobID, "encrypt_legacy_rows", batch.Processed, batch.Conflicts, 0, time.Now().UTC(),
			); progressErr != nil {
				failJob(ctx, operator, jobID, "progress_failed")
				logger.Error("content encryption command failed", "error_class", "content_encryption_job_progress_failed")
				return 1
			}
			processed += batch.Processed
			conflicts += batch.Conflicts
			if batch.Processed+batch.Conflicts == 0 {
				break
			}
		}
		if err = operator.FinishJob(ctx, jobID, "completed", "completed", time.Now().UTC()); err != nil {
			logger.Error("content encryption command failed", "error_class", "content_encryption_job_finish_failed")
			return 1
		}
		err = encoder.Encode(commandResult{Action: "backfill", Processed: processed, Conflicts: conflicts})
	case options.verify:
		jobID, jobErr := startJob(ctx, operator, "verify", "authenticate_encrypted_fields")
		if jobErr != nil {
			logger.Error("content encryption command failed", "error_class", "content_encryption_job_start_failed")
			return 1
		}
		verified, verifyErr := operator.Verify(ctx, options.batchSize)
		if verifyErr != nil {
			failJob(ctx, operator, jobID, "verification_failed")
			logger.Error("content encryption command failed", "error_class", "content_encryption_verification_failed")
			return 1
		}
		if err = operator.RecordJobProgress(
			ctx, jobID, "authenticate_encrypted_fields", verified, 0, 0, time.Now().UTC(),
		); err != nil {
			failJob(ctx, operator, jobID, "progress_failed")
			logger.Error("content encryption command failed", "error_class", "content_encryption_job_progress_failed")
			return 1
		}
		if err = operator.FinishJob(ctx, jobID, "completed", "completed", time.Now().UTC()); err != nil {
			logger.Error("content encryption command failed", "error_class", "content_encryption_job_finish_failed")
			return 1
		}
		err = encoder.Encode(commandResult{Action: "verify", Fields: verified})
	case options.strict:
		if err = operator.EnableStrict(ctx, time.Now().UTC()); err != nil {
			logger.Error("content encryption command failed", "error_class", "content_encryption_strict_activation_failed")
			return 1
		}
		err = encoder.Encode(commandResult{Action: "strict"})
	case options.rotateUser != "":
		jobID, jobErr := startJob(ctx, operator, "dek_rotation", "generate_and_promote")
		if jobErr != nil {
			logger.Error("content encryption command failed", "error_class", "content_encryption_job_start_failed")
			return 1
		}
		version, rotateErr := service.RotateUserKey(ctx, options.rotateUser)
		if rotateErr != nil {
			failJob(ctx, operator, jobID, "rotation_failed")
			logger.Error("content encryption command failed", "error_class", "content_encryption_dek_rotation_failed")
			return 1
		}
		if err = operator.RecordJobProgress(ctx, jobID, "promoted", 1, 0, 0, time.Now().UTC()); err != nil {
			failJob(ctx, operator, jobID, "progress_failed")
			logger.Error("content encryption command failed", "error_class", "content_encryption_job_progress_failed")
			return 1
		}
		if err = operator.FinishJob(ctx, jobID, "completed", "completed", time.Now().UTC()); err != nil {
			logger.Error("content encryption command failed", "error_class", "content_encryption_job_finish_failed")
			return 1
		}
		err = encoder.Encode(commandResult{Action: "rotate_user_dek", Version: version})
	}
	if err != nil {
		logger.Error("content encryption command failed", "error_class", "content_encryption_output_failed")
		return 1
	}
	return 0
}

func startJob(
	ctx context.Context,
	operator *postgres.ContentEncryptionOperator,
	operation, phase string,
) (string, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return "", err
	}
	jobID := id.String()
	if err = operator.StartJob(ctx, jobID, operation, phase, time.Now().UTC()); err != nil {
		return "", err
	}
	return jobID, nil
}

func failJob(ctx context.Context, operator *postgres.ContentEncryptionOperator, jobID, phase string) {
	_ = operator.RecordJobProgress(ctx, jobID, phase, 0, 0, 1, time.Now().UTC())
	_ = operator.FinishJob(ctx, jobID, "failed", phase, time.Now().UTC())
}
