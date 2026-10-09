#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App, testScenarios } from './ui/index.js';

// Support --scenario=1 or -s 2 CLI flags for testing
const args = process.argv.slice(2);
let initialScenario = 0;

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--scenario=')) {
    const val = parseInt(args[i].split('=')[1], 10);
    if (!isNaN(val) && val >= 1 && val <= testScenarios.length) {
      initialScenario = val - 1;
    }
  } else if ((args[i] === '-s' || args[i] === '--scenario') && args[i + 1]) {
    const val = parseInt(args[i + 1], 10);
    if (!isNaN(val) && val >= 1 && val <= testScenarios.length) {
      initialScenario = val - 1;
    }
  }
}

const app = render(
  React.createElement(App, {
    initialScenarioIndex: initialScenario,
    onExit: () => {
      process.exit(0);
    },
  })
);

await app.waitUntilExit();
