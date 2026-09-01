# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM golang:1.27.0-alpine@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS backend-build
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN GOENV=off GOTOOLCHAIN=local GOWORK=off GOFLAGS=-mod=readonly go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux GOENV=off GOTOOLCHAIN=local GOWORK=off GOFLAGS=-mod=readonly \
    go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
WORKDIR /app
COPY --from=backend-build /out/server /app/server
ENV HTTP_ADDRESS=:8080
EXPOSE 8080
USER 65532:65532
CMD ["/app/server"]
