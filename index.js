// Entry point for hosting panels, which usually start a file named index.js.
import { existsSync } from 'node:fs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Toxtickety needs Node.js 22.13 or newer, but this server runs ${process.version}.`);
  console.error('Choose a newer Node.js version in your hosting panel, then start the server again.');
  process.exit(1);
}

if (!existsSync(new URL('./dist/index.js', import.meta.url))) {
  console.error('The compiled bot is missing. Run "npm run build", or upload the release zip.');
  process.exit(1);
}

// Node 22 labels its built-in SQLite as experimental. Hide only that one notice.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('SQLite is an experimental feature')) return;
  emitWarning(warning, ...rest);
};

await import('./dist/index.js');
