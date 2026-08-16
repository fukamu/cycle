# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS frontend-build
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
ARG VITE_GOOGLE_WEB_CLIENT_ID=""
ARG VITE_RECAPTCHA_SITE_KEY=""
ENV VITE_GOOGLE_WEB_CLIENT_ID=$VITE_GOOGLE_WEB_CLIENT_ID
ENV VITE_RECAPTCHA_SITE_KEY=$VITE_RECAPTCHA_SITE_KEY
RUN npm run build

FROM golang:1.26.6-alpine AS backend-build
WORKDIR /src/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=backend-build /out/server /app/server
COPY --from=backend-build /out/migrate /app/migrate
COPY --from=backend-build /src/backend/migrations /app/migrations
COPY --from=frontend-build /src/frontend/dist /app/public
ENV HTTP_ADDRESS=:8080
ENV STATIC_DIR=/app/public
ENV MIGRATIONS_DIR=/app/migrations
EXPOSE 8080
CMD ["/app/server"]
