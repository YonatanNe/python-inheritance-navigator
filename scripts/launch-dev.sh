#!/bin/bash

# Launch VS Code with the extension loaded for manual testing
# This keeps VS Code open so you can test the extension

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "Compiling extension..."
cd "$PROJECT_ROOT"
npm run compile

if [ $? -ne 0 ]; then
    echo "Compilation failed!"
    exit 1
fi

echo "Launching VS Code with extension loaded..."
echo "VS Code will stay open - you can test the extension manually"
echo "Close VS Code when done testing"
echo ""

code --extensionDevelopmentPath="$PROJECT_ROOT" "$PROJECT_ROOT"

