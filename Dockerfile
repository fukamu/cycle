# syntax=docker/dockerfile:1.7

FROM golang:1.26.6-alpine AS backend-build
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN GOENV=off GOTOOLCHAIN=local GOWORK=off GOFLAGS=-mod=readonly go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux GOENV=off GOTOOLCHAIN=local GOWORK=off GOFLAGS=-mod=readonly \
    go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=backend-build /out/server /app/server
ENV HTTP_ADDRESS=:8080
EXPOSE 8080
USER 65532:65532
CMD ["/app/server"]
