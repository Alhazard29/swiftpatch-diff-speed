// Swiftpatch driver: reads /input/cases.json, answers every case with solve.js (run(input) for one case; runFile for
// the whole file at once, the same answers without building the texts as strings), and writes /output/answers.json
// (a JSON array, one answer per case, in order). MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and
// /output outside the grader.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// The grader gives the run one CPU and counts every thread's time. With one CPU, compiling hot code on a second
// thread only delays the fast code, so it is compiled where it is needed. Set before solve.js is loaded.
setFlagsFromString('--no-concurrent-recompilation');

type Solver = { run: (input: unknown) => unknown; runFile: (bytes: Uint8Array) => Uint8Array | null };
const { run, runFile } = (await import(new URL('./solve.js', import.meta.url).href)) as Solver;

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const bytes = readFileSync(join(INPUT_DIR, 'cases.json'));

// runFile is run() for every case of the file, in order, working on the file's bytes: the texts are never turned
// into JavaScript strings and the answers are written as the bytes of answers.json. It declines (null) any file it
// would not read exactly as JSON.parse does; that file is parsed here and every case answered with run().
let answersJson: Uint8Array | string | null = runFile(bytes);
if (answersJson === null) {
  const cases = JSON.parse(bytes.toString('utf8')) as { id: string; input: unknown }[];
  const answers: unknown[] = [];
  for (const c of cases) answers.push(run(c.input));
  answersJson = JSON.stringify(answers);
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), answersJson);
