// Test helper, run as a separate process: prints the board token of THREAD_DATA_DIR.
// `node --test` also runs this file directly; without a test data dir it does nothing.
if (process.env.THREAD_DATA_DIR) {
  const { boardToken } = await import('../server/http.mjs');
  process.stdout.write(boardToken());
}
