#!/bin/sh

# Docker Entrypoint Script for Secure-Frp-Proxy
# This script handles permission issues when running with mounted volumes

set -e

echo "=== Secure-Frp-Proxy Container Starting ==="

# Function to setup permissions
setup_permissions() {
    echo "Setting up file permissions..."
    
    # Create directories if they don't exist
    mkdir -p /app/config /app/log /app/frpc
    
    # Ensure production.json exists
    if [ ! -f /app/config/production.json ]; then
        echo "Creating production.json from default.json..."
        cp /app/config/default.json /app/config/production.json 2>/dev/null || true
    fi
    
    # Set ownership
    echo "Setting ownership to nodejs user..."
    chown -R nodejs:nodejs /app/config /app/log /app/frpc
    
    # Set permissions
    echo "Setting file permissions..."
    chmod -R 664 /app/config/*.json 2>/dev/null || true
    chmod 775 /app/config /app/log /app/frpc
    
    # Verify permissions
    echo "Verifying permissions..."
    ls -la /app/config/
    
    echo "Permission setup completed."
}

# Setup permissions first
setup_permissions

# Start application as root (application will handle user switching internally)
echo "Starting application..."
exec npm start 