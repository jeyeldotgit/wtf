import { InvestigationData } from './types/index.js';

export interface TestScenario {
  id: string;
  title: string;
  data: InvestigationData;
}

export const testScenarios: TestScenario[] = [
  {
    id: 'ts-type-mismatch',
    title: '1. TypeScript Type Error (TS2322)',
    data: {
      state: 'diagnosis_ready',
      failure: {
        command: 'pnpm run build',
        exitCode: 1,
        timestamp: new Date().toISOString(),
        cwd: '/home/jeyel/Documents/wtf',
        errorSummary: "TypeScript error TS2322: Type 'string' is not assignable to type 'number'.",
        rawLogLines: [
          "src/handlers/calc.ts:14:5 - error TS2322: Type 'string' is not assignable to type 'number'.",
          "14     const total: number = req.body.amount;",
          "                             ~~~~~~~~~~~~~~~~",
          "Found 1 error in src/handlers/calc.ts:14",
        ],
      },
      fix: {
        filePath: 'src/handlers/calc.ts',
        description: 'Parse string input from request body to integer using Number(req.body.amount)',
        conceptExplanation: [
          'HTTP request bodies parsed from JSON or URL queries often arrive as strings.',
          'TypeScript catches type mismatches at compile time to prevent runtime NaN and calculation errors.',
        ],
        whyFixWorks: 'Explicitly parses req.body.amount with Number(...) before assigning to the number type.',
        confidence: 'high',
        diff: `--- a/src/handlers/calc.ts
+++ b/src/handlers/calc.ts
@@ -11,7 +11,7 @@
 export function handleCalculation(req: Request) {
-    const total: number = req.body.amount;
+    const total: number = Number(req.body.amount);
     return { total };
 }`,
      },
      verification: {
        command: 'pnpm run build',
        description: 'Run TypeScript compiler build to verify type check succeeds.',
      },
    },
  },
  {
    id: 'runtime-null-error',
    title: '2. Runtime TypeError (Undefined access)',
    data: {
      state: 'diagnosis_ready',
      failure: {
        command: 'npm test',
        exitCode: 1,
        timestamp: new Date().toISOString(),
        cwd: '/home/jeyel/Documents/wtf',
        errorSummary: "TypeError: Cannot read properties of undefined (reading 'map')",
        rawLogLines: [
          "FAIL test/user-list.test.ts",
          "  ✕ renders users properly (14 ms)",
          "  TypeError: Cannot read properties of undefined (reading 'map')",
          "    at renderUsers (src/components/UserList.ts:8:22)",
          "    at Object.<anonymous> (test/user-list.test.ts:12:15)",
        ],
      },
      fix: {
        filePath: 'src/components/UserList.ts',
        description: 'Add optional chaining and default fallback array to prevent crashes when users list is undefined',
        conceptExplanation: [
          'In JavaScript, calling .map() on undefined or null causes an unhandled runtime exception.',
          'Using optional chaining (?.) and a fallback empty array (?? []) ensures safe iteration even during loading states.',
        ],
        whyFixWorks: 'Guards against undefined by using (users ?? []).map(...) so the function always returns a valid list.',
        confidence: 'high',
        diff: `--- a/src/components/UserList.ts
+++ b/src/components/UserList.ts
@@ -6,5 +6,5 @@
 export function renderUsers(data?: { users?: string[] }) {
-    return data.users.map(u => u.trim());
+    return (data?.users ?? []).map(u => u.trim());
 }`,
      },
      verification: {
        command: 'npm test',
        description: 'Re-run test suite to confirm the undefined guard passes all tests.',
      },
    },
  },
  {
    id: 'missing-module-import',
    title: '3. Missing Dependency (ERR_MODULE_NOT_FOUND)',
    data: {
      state: 'diagnosis_ready',
      failure: {
        command: 'node dist/server.js',
        exitCode: 1,
        timestamp: new Date().toISOString(),
        cwd: '/home/jeyel/Documents/wtf',
        errorSummary: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'cors' imported from dist/server.js",
        rawLogLines: [
          "node:internal/modules/esm/resolve:855",
          "  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);",
          "  ^",
          "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'cors' imported from /app/dist/server.js",
        ],
      },
      fix: {
        filePath: 'package.json',
        description: 'Add "cors" and "@types/cors" to dependencies in package.json',
        conceptExplanation: [
          'Node.js throws ERR_MODULE_NOT_FOUND when code imports an external library that has not been installed into node_modules.',
          'Adding it to package.json ensures reproducible installs across team members and CI pipelines.',
        ],
        whyFixWorks: 'Declares the missing cors package in dependencies so the package manager knows to install it.',
        confidence: 'high',
        diff: `--- a/package.json
+++ b/package.json
@@ -18,6 +18,7 @@
   "dependencies": {
+    "cors": "^2.8.5",
     "dotenv": "^16.4.5"
   }`,
      },
      verification: {
        command: 'pnpm install && node dist/server.js',
        description: 'Install dependencies and launch the server to ensure cors imports cleanly.',
      },
    },
  },
];
