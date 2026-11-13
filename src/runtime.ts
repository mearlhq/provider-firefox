import { createProviderServer } from '@mearl/provider';
import { createFirefoxProvider } from './provider.js';

const firefox = createFirefoxProvider(browsers => server.updateBrowsers(browsers));
const server = createProviderServer({ definition: firefox.definition });
await server.start();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await firefox.stop();
    await server.stop();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
