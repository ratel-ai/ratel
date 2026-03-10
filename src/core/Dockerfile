FROM rust:1.85-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY agentified-lib/Cargo.toml agentified-lib/Cargo.toml
COPY agentified-server/Cargo.toml agentified-server/Cargo.toml
# Cache deps layer
RUN mkdir -p agentified-lib/src agentified-server/src \
    && echo 'fn main() {}' > agentified-server/src/main.rs \
    && touch agentified-lib/src/lib.rs \
    && cargo build --release \
    && rm -rf agentified-lib/src agentified-server/src
COPY agentified-lib/ agentified-lib/
COPY agentified-server/ agentified-server/
RUN touch agentified-lib/src/lib.rs agentified-server/src/main.rs \
    && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/agentified-core /usr/local/bin/agentified-core
ENV AGENTIFIED_PORT=9119
EXPOSE 9119
CMD ["agentified-core"]
