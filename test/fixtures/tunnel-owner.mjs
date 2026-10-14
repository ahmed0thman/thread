// An owner of a tunnel that a test kills with SIGKILL: starts a board with the fake cloudflared, opens the tunnel, prints a line
// and waits. Run with no arguments by `node --test` it exits at once.
import { startBoardServer, boardToken } from '../../server/http.mjs';

if (process.env.THREAD_CLOUDFLARED_BIN && process.env.THREAD_PROJECT_DIR) {
  const b = await startBoardServer(process.env.THREAD_PROJECT_DIR, { port: 0, token: boardToken() });
  await b.tunnel.start();
  process.stdout.write('open\n');
  setInterval(() => {}, 1 << 30);
}
