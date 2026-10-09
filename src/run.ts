#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { RunSession } from './session/run-session.js';
import { App } from './ui/index.js';

const session = new RunSession();
let unmountApp: () => void = () => {};
let exiting = false;
const exit = () => {
  if (exiting) return;
  exiting = true;
  void session.close().finally(() => unmountApp());
};

const app = render(React.createElement(App, { session, onExit: exit }));
unmountApp = () => app.unmount();
process.once('SIGINT', exit);

await app.waitUntilExit();
await session.close();
