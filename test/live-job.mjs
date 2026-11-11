#!/usr/bin/env node
// A stand-in for a long job, such as a slow test suite, used by `test/live.mjs --job`.
// It does a little hashing every second for the given time, printing progress, then
// prints a token. The token is a hash of the arguments, so the cloud chat can only
// report it by running the step to the end, and test/live.mjs checks the reply for it.
//
//   node test/live-job.mjs <word> <step> <seconds>
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function jobToken(word, step) {
  return createHash('sha256').update(`${word}:${step}`).digest('hex').slice(0, 12);
}

function main([word, step, seconds]) {
  if (!word || !step || !(Number(seconds) > 0)) {
    console.error('Usage: node test/live-job.mjs <word> <step> <seconds>');
    process.exitCode = 2;
    return;
  }
  const end = Date.now() + Number(seconds) * 1000;
  let rounds = 0;
  let digest = word;
  const tick = () => {
    for (let i = 0; i < 20_000; i += 1) digest = createHash('sha256').update(digest).digest('hex');
    rounds += 1;
    if (rounds % 60 === 0) console.log(`step ${step}: ${rounds} rounds done`);
    if (Date.now() < end) setTimeout(tick, 1000);
    else console.log(`step ${step} finished after ${rounds} rounds. Token: ${jobToken(word, step)}`);
  };
  tick();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
