FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

ARG TEMPORAL_CLI_VERSION=1.9.1
RUN apt-get update && apt-get install -y -o Acquire::Retries=3 --no-install-recommends ca-certificates curl \
  && curl -fsSL "https://github.com/temporalio/cli/releases/download/v${TEMPORAL_CLI_VERSION}/temporal_cli_${TEMPORAL_CLI_VERSION}_linux_amd64.tar.gz" -o /tmp/temporal.tar.gz \
  && echo "09a0326a51db84d02735e53542b9ebd8c4758daf47482a9ab0abce15844e60d5  /tmp/temporal.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/temporal.tar.gz -C /usr/local/bin temporal \
  && rm -rf /var/lib/apt/lists/* /tmp/temporal.tar.gz

WORKDIR /spike
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY *.cjs ./
