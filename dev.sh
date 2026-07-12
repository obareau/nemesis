#!/bin/bash
# Start both frontend and backend in parallel

set -e

echo "⚖️  Nemesis — Development Mode"
echo "================================\n"

# Vérify Chromaprint
if ! command -v fpcalc &> /dev/null; then
    echo "⚠️  fpcalc not found. Install with: sudo apt install chromaprint-tools"
    echo "   (Fingerprinting will fail silently without it)\n"
fi

echo "Starting processes (Ctrl+C to stop both)...\n"

# Trap Ctrl+C to kill both processes
trap "kill $FRONTEND_PID $BACKEND_PID 2>/dev/null; exit" EXIT INT

# Start frontend
npm run dev &
FRONTEND_PID=$!
echo "✓ Frontend (Vite) started on http://localhost:5174"

# Start backend after a delay
sleep 2
npm run server &
BACKEND_PID=$!
echo "✓ Backend (Express) started on http://localhost:5693\n"

echo "🟢 Ready! Open http://localhost:5174 in your browser.\n"

# Wait for both
wait
