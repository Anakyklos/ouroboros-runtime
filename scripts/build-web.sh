#!/bin/bash

# 🐍 Ouroboros Web UI Build Script
# Builds the web UI for production and prepares it for daemon serving

set -e

echo "🐍 Building Ouroboros Web UI..."

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
WEB_DIR="$PROJECT_ROOT/web"
DIST_DIR="$WEB_DIR/dist"
DAEMON_STATIC_DIR="$PROJECT_ROOT/cli/src/daemon/static"

echo "📁 Project root: $PROJECT_ROOT"
echo "📁 Web directory: $WEB_DIR"

# Check if web directory exists
if [ ! -d "$WEB_DIR" ]; then
    echo -e "${RED}❌ Web directory not found at $WEB_DIR${NC}"
    exit 1
fi

# Navigate to web directory
cd "$WEB_DIR"

# Install dependencies if needed
if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules/.package-lock.json" ]; then
    echo -e "${YELLOW}📦 Installing dependencies...${NC}"
    bun install
fi

# Build for production
echo -e "${YELLOW}🔨 Building for production...${NC}"
bun run build

# Check if build succeeded
if [ ! -d "$DIST_DIR" ]; then
    echo -e "${RED}❌ Build failed - dist directory not created${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Build completed successfully!${NC}"
echo "📦 Output: $DIST_DIR"

# Optional: Copy to daemon static directory
if [ -d "$DAEMON_STATIC_DIR" ]; then
    echo -e "${YELLOW}📋 Copying to daemon static directory...${NC}"
    rm -rf "$DAEMON_STATIC_DIR"/*
    cp -r "$DIST_DIR"/* "$DAEMON_STATIC_DIR"
    echo -e "${GREEN}✅ Copied to $DAEMON_STATIC_DIR${NC}"
fi

# Print build info
echo ""
echo -e "${GREEN}🐍 Ouroboros Web UI Build Complete${NC}"
echo "=========================================="
echo "Build output: $DIST_DIR"
echo "Files: $(find "$DIST_DIR" -type f | wc -l)"
echo "Size: $(du -sh "$DIST_DIR" | cut -f1)"
echo ""
echo "To start the daemon with Web UI:"
echo "  bun run daemon"
echo ""
