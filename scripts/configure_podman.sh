#!/bin/bash
# scripts/configure_podman.sh

# 1. Check if Podman exists
if ! command -v podman &> /dev/null; then
    # Not using Podman (or not in path), skip
    exit 0
fi

# 2. Check if we are on the host (not inside a container)
if [ -f "/.dockerenv" ] || [ -f "/run/.containerenv" ]; then
    exit 0
fi

echo "Checking Podman status..."

# 3. Get machine info
MACHINE_INFO=$(podman machine inspect 2>/dev/null)

if [ -z "$MACHINE_INFO" ]; then
    echo "Warning: Could not inspect Podman machine. Is it initialized?"
    exit 0
fi

# Parse State and Memory
STATE=$(echo "$MACHINE_INFO" | python3 -c "import sys, json; print(json.load(sys.stdin)[0]['State'])" 2>/dev/null)
CURRENT_MEM=$(echo "$MACHINE_INFO" | python3 -c "import sys, json; print(json.load(sys.stdin)[0]['Resources']['Memory'])" 2>/dev/null)

REQUIRED_MEM=24576 # ~24GB

# 4. Check memory and reconfigure if needed
if [ -n "$CURRENT_MEM" ] && [ "$CURRENT_MEM" -lt "$REQUIRED_MEM" ]; then
    echo "⚠ Podman memory ($CURRENT_MEM MB) is below target ($REQUIRED_MEM MB)."
    echo "Reconfiguring Podman machine..."
    
    if [ "$STATE" == "running" ]; then
        podman machine stop
    fi
    
    podman machine set --memory 24576 --cpus 8
    podman machine start
    echo "✓ Podman reconfigured and started."
    exit 0
fi

# 5. Ensure machine is running
if [ "$STATE" != "running" ]; then
    echo "Podman machine is not running (State: $STATE). Starting..."
    podman machine start
    echo "✓ Podman started."
else
    echo "✓ Podman is running with sufficient memory ($CURRENT_MEM MB)."
fi

# 6. Check for Docker socket (Critical for VS Code)
if [ ! -S "/var/run/docker.sock" ]; then
    echo "⚠️  /var/run/docker.sock is missing."
    
    # Find the helper executable
    HELPER_PATH=$(find /opt/homebrew/Cellar/podman -name "podman-mac-helper" 2>/dev/null | head -n 1)
    
    if [ -n "$HELPER_PATH" ]; then
        echo "Attempting to install podman-mac-helper..."
        echo "You may be prompted for your sudo password."
        
        if sudo "$HELPER_PATH" install; then
            echo "✓ podman-mac-helper installed."
            
            # Check if socket appeared
            if [ ! -S "/var/run/docker.sock" ]; then
                echo "Socket not found yet. Restarting Podman..."
                podman machine stop
                podman machine start
            fi
        else
            echo "❌ Failed to install podman-mac-helper automatically."
            echo "Please run this command manually:"
            echo "    sudo $HELPER_PATH install"
            exit 1
        fi
    else
        echo "❌ Could not find podman-mac-helper."
        echo "Please install it manually or check your Podman installation."
        exit 1
    fi
fi

# 7. Final Verification: Ensure machine is definitely running and responsive
echo "Verifying Podman status..."
if ! podman system connection list &>/dev/null; then
    echo "Podman connection failed. Restarting machine..."
    podman machine stop
    podman machine start
fi

if ! podman info &>/dev/null; then
    echo "❌ Podman is not responding even after start attempt."
    exit 1
fi

echo "✓ Podman is ready."
