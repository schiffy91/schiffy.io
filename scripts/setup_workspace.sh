#!/bin/bash
# Post-create setup. Runs after the container is mounted.
# NOTE: pip dependencies are installed in Dockerfile for caching
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "Running post-create setup..."

echo "✓ Setup complete"
