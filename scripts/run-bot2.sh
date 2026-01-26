#!/bin/bash
# Run second bot instance with alternative token
cd "$(dirname "$0")/.."

# Use the second token file
export DISCORD_TOKEN_FILE="./discord_token_2"

# Separate cache directory to avoid conflicts
export CACHE_PATH="./cache2"

# Run the bot
npm run dev

