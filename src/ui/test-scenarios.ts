import mockTerminalErrors from './mock-terminal-errors.json' with { type: 'json' };

export interface TestScenario {
  id: string;
  title: string;
  data: unknown;
}

// Load all 10 terminal error scenarios directly from mock-terminal-errors.json
export const testScenarios: TestScenario[] = (mockTerminalErrors as unknown as TestScenario[]);
