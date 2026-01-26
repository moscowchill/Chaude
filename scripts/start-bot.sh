#!/bin/bash
# Start the chapter3 Discord bot

cd "$(dirname "$0")/.."

# Check if already running
if pgrep -f "tsx src/main.ts" > /dev/null; then
    echo "⚠️  Bot appears to be already running!"
    echo "Run ./stop-bot.sh first to stop it"
    ps aux | grep "[t]sx src/main" | grep -v grep
    exit 1
fi

echo "Starting chapter3 bot..."

# Start bot in background
nohup npm run dev > logs/bot.log 2>&1 &
BOT_PID=$!

echo "Bot started with PID: $BOT_PID"
echo "Waiting for startup..."
sleep 3

# Check if it started successfully
if pgrep -f "tsx src/main.ts" > /dev/null; then
    echo "✓ Bot is running!"
    echo ""
    echo "Logs:"
    echo "  Console: tail -f logs/bot.log"
    echo "  Activations: ls -lt logs/activations/"
    echo ""
    echo "To stop: ./scripts/stop-bot.sh"
else
    echo "❌ Bot failed to start. Check logs/bot.log"
    tail -20 logs/bot.log
    exit 1
fi





