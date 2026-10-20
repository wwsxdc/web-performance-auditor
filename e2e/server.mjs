import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const fixturePath = fileURLToPath(new URL('./fixture.html', import.meta.url));

export async function startFixtureServer() {
  const template = await readFile(fixturePath, 'utf8');
  let port = 0;

  const server = createServer((request, response) => {
    if (request.url?.startsWith('/blocked.js')) {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end('window.__blockedLoaded = true;');
      return;
    }

    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(template.replaceAll('__PORT__', String(port)));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;

  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
