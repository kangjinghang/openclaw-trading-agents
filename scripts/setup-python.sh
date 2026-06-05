#!/usr/bin/env bash
# Setup Python environment for OpenClaw Trading Agents
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "=== OpenClaw Trading Agents Python Setup ==="
echo "Project root: $PROJECT_ROOT"
echo ""

# Check Python 3.11+ is available
PYTHON_CMD=""
for python in python3.11 python3.12 python3.13 python3; do
    if command -v "$python" &> /dev/null; then
        PYTHON_VERSION=$($python --version 2>&1 | awk '{print $2}')
        PYTHON_MAJOR=$(echo "$PYTHON_VERSION" | cut -d. -f1)
        PYTHON_MINOR=$(echo "$PYTHON_VERSION" | cut -d. -f2)

        if [ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -ge 11 ]; then
            PYTHON_CMD="$python"
            echo "✓ Found Python $PYTHON_VERSION ($python)"
            break
        fi
    fi
done

if [ -z "$PYTHON_CMD" ]; then
    echo "✗ Error: Python 3.11+ is required but not found"
    echo "  Please install Python 3.11 or later"
    exit 1
fi

# Create .venv if not exists
VENV_PATH="$PROJECT_ROOT/.venv"
if [ ! -d "$VENV_PATH" ]; then
    echo "Creating virtual environment at $VENV_PATH"
    "$PYTHON_CMD" -m venv "$VENV_PATH"
else
    echo "✓ Virtual environment already exists at $VENV_PATH"
fi

# Activate venv
source "$VENV_PATH/bin/activate"

# Upgrade pip
echo "Upgrading pip..."
pip install --upgrade pip -q

# Install requirements from each skill
echo ""
echo "Installing Python dependencies from skills..."
REQUIREMENTS_FILES=$(find "$PROJECT_ROOT/skills" -name "requirements.txt" 2>/dev/null || true)

if [ -z "$REQUIREMENTS_FILES" ]; then
    echo "No requirements.txt files found in skills/"
else
    while IFS= read -r req_file; do
        if [ -f "$req_file" ]; then
            echo "  Installing from $(echo "$req_file" | sed "s|$PROJECT_ROOT/||")"
            pip install -r "$req_file" -q
        fi
    done <<< "$REQUIREMENTS_FILES"
fi

echo ""
echo "=== Setup Complete ==="
echo "✓ Virtual environment: $VENV_PATH"
echo "✓ Python version: $($PYTHON_CMD --version)"
echo ""
echo "To activate the environment, run:"
echo "  source $VENV_PATH/bin/activate"
