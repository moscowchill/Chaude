#!/bin/bash
# Stop the chapter3 Discord bot

cd "$(dirname "$0")/.."

echo "Stopping chapter3 bot..."

# Kill all related processes
pkill -9 -f "npm.*run.*dev" 2>/dev/null && echo "  Killed npm"
pkill -9 -f "tsx src/main" 2>/dev/null && echo "  Killed tsx"
pkill -9 -f "node.*tsx.*src/main" 2>/dev/null && echo "  Killed node"
pkill -9 -f "@esbuild" 2>/dev/null && echo "  Killed esbuild"

sleep 1

# Check if anything remains
REMAINING=$(ps aux | grep -E "tsx src/main|npm.*run.*dev" | grep -v grep | wc -l)

if [ "$REMAINING" -eq 0 ]; then
    echo "✓ All bot processes stopped"
else
    echo "⚠️  Warning: $REMAINING processes may still be running:"
    ps aux | grep -E "tsx src/main|npm.*run.*dev" | grep -v grep
    echo ""
    echo "You may need to kill them manually:"
    echo "  kill -9 \$(pgrep -f 'tsx src/main')"
fi





