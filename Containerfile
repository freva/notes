# Built by /etc/containers/systemd/notes.build on lemonade; `sps update` rebuilds it.

# Only the editor bundle needs node; none of it ends up in the image.
FROM docker.io/library/node:22-alpine AS web
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
COPY . .
RUN corepack pnpm install --frozen-lockfile && corepack pnpm build

FROM docker.io/library/golang:alpine AS server
WORKDIR /src
COPY . .
COPY --from=web /src/public/editor.bundle.js public/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /notes .

FROM scratch
COPY --from=server /notes /notes
ENV NOTES_DIR=/data
USER 1000:1000
EXPOSE 3000
ENTRYPOINT ["/notes"]
