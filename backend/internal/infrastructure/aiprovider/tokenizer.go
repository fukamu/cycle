package aiprovider

import (
	"errors"

	"github.com/tiktoken-go/tokenizer"
)

type TokenCounter struct {
	codec tokenizer.Codec
}

func NewTokenCounter(encoding string) (*TokenCounter, error) {
	codec, err := tokenizer.Get(tokenizer.Encoding(encoding))
	if err != nil {
		return nil, err
	}
	return &TokenCounter{codec: codec}, nil
}

func (counter *TokenCounter) Count(value string) (int, error) {
	return counter.codec.Count(value)
}

func (counter *TokenCounter) Truncate(value string, maxTokens int, marker string) (string, error) {
	if maxTokens < 0 {
		return "", errors.New("token limit cannot be negative")
	}
	count, err := counter.Count(value)
	if err != nil {
		return "", err
	}
	if count <= maxTokens {
		return value, nil
	}
	markerCount, err := counter.Count(marker)
	if err != nil {
		return "", err
	}
	if markerCount > maxTokens {
		return "", nil
	}
	runes := []rune(value)
	low, high := 0, len(runes)
	for low < high {
		middle := (low + high + 1) / 2
		candidate := string(runes[:middle]) + marker
		candidateCount, countErr := counter.Count(candidate)
		if countErr != nil {
			return "", countErr
		}
		if candidateCount <= maxTokens {
			low = middle
		} else {
			high = middle - 1
		}
	}
	return string(runes[:low]) + marker, nil
}
