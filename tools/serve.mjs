// Zero-dependency static dev server. Usage: `npm start`.
//   PORT  port to listen on (default 5173)
//   SM_HOST  address to listen on (default 127.0.0.1: this computer only). SM_HOST=0.0.0.0 also lets
//            other devices on your network open it, for example a phone on the same Wi-Fi. (Not the
//            generic HOST variable: some shells and toolchains set that to something else.)
// Exists because ES modules need correct MIME types, which some stock servers get wrong on Windows.
import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const folder = resolve(fileURLToPath(new URL('..', import.meta.url)));
// The folder's name on disk, so that it compares cleanly with the on-disk names of the files served
// below. Null on the rare drive that cannot report one; the on-disk check is then skipped.
const realRoot = await realpath(folder).catch(() => null);
const root = realRoot ?? folder;
const port = Number(process.env.PORT) || 5173;
const host = process.env.SM_HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const outsideRoot = (filePath) => filePath !== root && !filePath.startsWith(root + sep);

// Nothing whose name starts with a dot is part of the site. .git holds the whole history of the repo
// (and sometimes credentials); .claude, .gitignore and the like are tooling.
const hidden = (filePath) => relative(root, filePath).split(sep).some((segment) => segment.startsWith('.'));

const notFound = (res) => res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let filePath = normalize(join(root, urlPath));
    if (outsideRoot(filePath)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (hidden(filePath)) {
      notFound(res);
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (info && info.isDirectory()) filePath = join(filePath, 'index.html');
    // A file can be reached under a name other than its own (a Windows short name such as GIT~1, a
    // link), so the two checks above are repeated on the name it has on disk.
    const onDisk = realRoot ? await realpath(filePath).catch(() => filePath) : filePath;
    if (outsideRoot(onDisk) || hidden(onDisk)) {
      notFound(res);
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    notFound(res);
  }
});

server.on('error', (error) => {
  console.error(`SecureMeasure dev server could not listen on ${host}:${port} (${error.code || error.message}).`);
  console.error('Check the SM_HOST and PORT environment variables, or whether another program is using that port.');
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const loopback = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const everyAddress = host === '0.0.0.0' || host === '::';
  const urlHost = loopback || everyAddress ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  console.log(`SecureMeasure dev server: http://${urlHost}:${port}/`);
  if (loopback) {
    console.log('Only this computer can open it. To try it from a phone on the same network, start it with SM_HOST=0.0.0.0.');
  } else {
    console.log(`Listening on ${host}: other devices on your network can open it too, at this computer's network address.`);
    console.log('Files and folders whose names start with a dot (such as .git) are never served.');
  }
});
