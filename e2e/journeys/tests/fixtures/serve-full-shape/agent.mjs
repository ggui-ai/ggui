// Minimal supervised agent for the teardown pin: stays alive, exits on SIGTERM.
process.stderr.write(`[agent] up pid=${process.pid}\n`);
const keep = setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  clearInterval(keep);
  process.exit(0);
});
