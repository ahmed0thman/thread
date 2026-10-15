// Preloaded into the waiter with --import: once the file named by THREAD_TEST_STEP_FILE exists, Date.now() reports a time one hour
// earlier, as a wall clock does when it is corrected. Without that variable it changes nothing, so running it alone exits 0.
import { existsSync } from 'node:fs';

const real = Date.now.bind(Date);
const file = process.env.THREAD_TEST_STEP_FILE;
if (file) Date.now = () => real() - (existsSync(file) ? 3600 * 1000 : 0);
