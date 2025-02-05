#!/bin/bash

# Create release directory if it doesn't exist
mkdir -p release

# Get the package name and version from package.json
PACKAGE_NAME=$(node -p "require('./package.json').name")
PACKAGE_VERSION=$(node -p "require('./package.json').version")

# Run the vsce package command
vsce package

# Move the generated vsix file to release folder with -latest suffix
mv "${PACKAGE_NAME}-${PACKAGE_VERSION}.vsix" "${PACKAGE_NAME}-latest.vsix"

echo "Extension packaged and moved to ${PACKAGE_NAME}-latest.vsix" 