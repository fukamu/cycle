package actionai

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"fmt"
	"strings"

	domaincycle "github.com/matoruru/PDCAI/backend/internal/domain/cycle"
)

const omissionMarker = "…（入力の一部を省略）"

//go:embed prompts/*.txt
var promptFiles embed.FS

type ContextBuilder struct {
	counter        TokenCounter
	maxInputTokens int
}

func NewContextBuilder(counter TokenCounter, maxInputTokens int) *ContextBuilder {
	return &ContextBuilder{counter: counter, maxInputTokens: maxInputTokens}
}

func (builder *ContextBuilder) BuildGenerate(snapshot Snapshot) (BuiltContext, error) {
	instructions, err := promptFiles.ReadFile("prompts/generate-action-v1.txt")
	if err != nil {
		return BuiltContext{}, err
	}
	return builder.build(string(instructions), snapshot, false)
}

func (builder *ContextBuilder) BuildRefine(snapshot Snapshot) (BuiltContext, error) {
	instructions, err := promptFiles.ReadFile("prompts/refine-action-v1.txt")
	if err != nil {
		return BuiltContext{}, err
	}
	return builder.build(string(instructions), snapshot, true)
}

func (builder *ContextBuilder) build(instructions string, snapshot Snapshot, refine bool) (BuiltContext, error) {
	current := currentBlock(snapshot.Current, refine)
	base := instructions + "\n" + current
	count, err := builder.counter.Count(base)
	if err != nil {
		return BuiltContext{}, err
	}
	truncated := false
	if count > builder.maxInputTokens {
		current, err = builder.truncateCurrent(instructions, snapshot.Current, refine)
		if err != nil {
			return BuiltContext{}, err
		}
		truncated = true
	}

	input := current
	ids := make([]domaincycle.ID, 0, len(snapshot.Past))
	for _, past := range snapshot.Past {
		candidateBlock := pastBlock(past)
		candidate := input + candidateBlock
		count, err = builder.counter.Count(instructions + "\n" + candidate)
		if err != nil {
			return BuiltContext{}, err
		}
		if count > builder.maxInputTokens {
			break
		}
		input = candidate
		ids = append(ids, past.ID)
	}
	canonical := instructions + "\n" + input
	digest := sha256.Sum256([]byte(canonical))
	return BuiltContext{
		Instructions:     instructions,
		Input:            input,
		ContextCycleIDs:  ids,
		InputHash:        hex.EncodeToString(digest[:]),
		CurrentTruncated: truncated,
	}, nil
}

func (builder *ContextBuilder) truncateCurrent(instructions string, current domaincycle.PDCACycle, refine bool) (string, error) {
	labels := []string{"P", "D", "C"}
	values := []string{current.Plan, current.Do, current.Check}
	weights := []int{1, 1, 1}
	if refine {
		labels = append(labels, "A")
		values = append(values, current.Action)
		weights = []int{2, 2, 2, 4}
	}
	overhead := instructions + "\n[Current Cycle]\n"
	for _, label := range labels {
		overhead += label + ": \n"
	}
	overheadTokens, err := builder.counter.Count(overhead)
	if err != nil {
		return "", err
	}
	available := builder.maxInputTokens - overheadTokens
	if available < len(values) {
		available = len(values)
	}
	totalWeight := 0
	for _, weight := range weights {
		totalWeight += weight
	}
	result := make([]string, len(values))
	used := 0
	for index, value := range values {
		budget := available * weights[index] / totalWeight
		if budget < 1 {
			budget = 1
		}
		result[index], err = builder.counter.Truncate(value, budget, omissionMarker)
		if err != nil {
			return "", err
		}
		count, countErr := builder.counter.Count(result[index])
		if countErr != nil {
			return "", countErr
		}
		used += count
	}

	// Give unused quota back in the specified priority order. Refine keeps A first.
	priority := []int{0, 1, 2}
	if refine {
		priority = []int{3, 0, 1, 2}
	}
	remaining := available - used
	for _, index := range priority {
		if remaining <= 0 {
			break
		}
		currentCount, countErr := builder.counter.Count(result[index])
		if countErr != nil {
			return "", countErr
		}
		expanded, truncateErr := builder.counter.Truncate(values[index], currentCount+remaining, omissionMarker)
		if truncateErr != nil {
			return "", truncateErr
		}
		expandedCount, countErr := builder.counter.Count(expanded)
		if countErr != nil {
			return "", countErr
		}
		remaining -= expandedCount - currentCount
		result[index] = expanded
	}

	var output strings.Builder
	output.WriteString("[Current Cycle]\n")
	for index, label := range labels {
		fmt.Fprintf(&output, "%s: %s\n", label, result[index])
	}
	return output.String(), nil
}

func currentBlock(current domaincycle.PDCACycle, refine bool) string {
	var result strings.Builder
	result.WriteString("[Current Cycle]\n")
	fmt.Fprintf(&result, "P: %s\nD: %s\nC: %s\n", current.Plan, current.Do, current.Check)
	if refine {
		fmt.Fprintf(&result, "A: %s\n", current.Action)
	}
	return result.String()
}

func pastBlock(past domaincycle.PDCACycle) string {
	return fmt.Sprintf("\n[Past Completed Cycle %d]\nP: %s\nD: %s\nC: %s\nA: %s\n",
		past.SequenceNumber, past.Plan, past.Do, past.Check, past.Action)
}
