#!/bin/bash

# REMOVED: set -e (We want to continue if one fails, e.g. if version already exists)

# Get the directory where the script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "🚀 Starting Voiden Runner publication process from $(pwd)..."

# Track successes
E_STATUS="❌ Failed"
C_STATUS="❌ Failed"
R_STATUS="❌ Failed"

# 1. Build and Publish @voiden/executors (located at ./executors)
echo "📦 Processing @voiden/executors..."
if cd executors && npm run build && npm publish --tag beta --access public; then
  E_STATUS="✅ Success"
fi
cd "$SCRIPT_DIR"

# 2. Build and Publish @voiden/core-extensions (located at ../core-extensions)
echo "📦 Processing @voiden/core-extensions..."
if cd ../core-extensions && npm run build && npm publish --tag beta --access public; then
  C_STATUS="✅ Success"
fi
cd "$SCRIPT_DIR"

# 3. Build and Publish @voiden/runner (located at ./voiden-runner)
echo "🚀 Processing @voiden/runner..."
if cd voiden-runner && npm run build && npm publish --tag beta --access public; then
  R_STATUS="✅ Success"
fi
cd "$SCRIPT_DIR"

echo ""
echo "🏁 Publication Summary:"
echo "-----------------------"
echo "📦 @voiden/executors:       $E_STATUS"
echo "📦 @voiden/core-extensions:  $C_STATUS"
echo "🚀 @voiden/runner:           $R_STATUS"
echo "-----------------------"
echo "Note: If a package failed with '403 Forbidden', it usually means that version is already published."
