#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { App } from './ui/index.js';

const app = render(
  React.createElement(App, {
    onExit: () => {
      process.exit(0);
    },
  })
);

await app.waitUntilExit();
