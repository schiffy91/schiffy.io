FROM mcr.microsoft.com/devcontainers/javascript-node:18

# Install ImageMagick and Python
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends imagemagick python3 python3-pip

# Install Less globally so it's available in the path and cached
RUN npm install -g less
