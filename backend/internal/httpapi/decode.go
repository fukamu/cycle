package httpapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

const defaultBodyLimit = 64 << 10

var errRequestValidation = errors.New("request validation failed")

func decodeJSON(writer http.ResponseWriter, request *http.Request, destination any, limit int64) error {
	request.Body = http.MaxBytesReader(writer, request.Body, limit)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("request body must contain one JSON object")
		}
		return err
	}
	return nil
}

func (server *api) decodeAndValidateJSON(writer http.ResponseWriter, request *http.Request, destination any, limit int64) error {
	if err := decodeJSON(writer, request, destination, limit); err != nil {
		return fmt.Errorf("%w: %v", errRequestValidation, err)
	}
	if err := server.validate.Struct(destination); err != nil {
		return fmt.Errorf("%w: %v", errRequestValidation, err)
	}
	return nil
}
