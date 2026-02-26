#!/usr/bin/env node
/**
 * Startup wrapper that handles signals gracefully to prevent npm error logs
 * This script runs the actual server and ensures clean shutdown
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Spawn the actual server
const server = spawn('node', ['server.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  shell: false
});

// Handle signals gracefully
function handleSignal(signal) {
  console.log(`\n📡 Received ${signal}, forwarding to server process...`);
  if (server && !server.killed) {
    server.kill(signal);
  }
}

process.on('SIGTERM', () => {
  handleSignal('SIGTERM');
  // Give the server time to shutdown gracefully
  setTimeout(() => {
    process.exit(0);
  }, 5000);
});

process.on('SIGINT', () => {
  handleSignal('SIGINT');
  // Give the server time to shutdown gracefully
  setTimeout(() => {
    process.exit(0);
  }, 5000);
});

// Forward server exit code
server.on('exit', (code, signal) => {
  if (signal) {
    console.log(`Server terminated by signal: ${signal}`);
  } else {
    console.log(`Server exited with code: ${code}`);
  }
  process.exit(code || 0);
});

server.on('error', (error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

