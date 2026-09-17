#!/bin/sh
set -eu
# Each container has one daemon and a fresh PID namespace. A PID file from a
# previous container is not a valid lock here (and disk exhaustion may truncate it).
# Safe only with the controller's single-writer contract and normal pod deletion;
# this does not provide fencing for a failed or partitioned Kubernetes node.
rm -f "${PASEO_HOME:-${HOME:-/home/paseo}/.paseo}/paseo.pid"
exec /usr/local/bin/paseo-docker-entrypoint "$@"
