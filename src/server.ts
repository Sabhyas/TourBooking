import { readConfig } from './config.js';
import { Repository } from './db.js';
import { createApplication } from './app.js';
import { parseArgs } from 'node:util';

process.umask(0o077);
const { values } = parseArgs({ options: { host: { type: 'string' }, port: { type: 'string' }, strictPort: { type: 'boolean' } } });
const config = readConfig({ ...process.env, ...(values.host ? { HOST: values.host } : {}), ...(values.port ? { PORT: values.port } : {}) });
const repo = new Repository(config.DB_PATH, config.PAYMENT_PROVIDER);
const { app, service } = createApplication({ config, repo });
const server = app.listen(config.PORT, config.HOST, () => {
  console.log(`MTA tour booking: http://${config.HOST}:${config.PORT}`);
  console.log(`Payments: ${config.PAYMENT_PROVIDER}; owner email: ${config.EMAIL_TRANSPORT}`);
  if (config.PAYMENT_PROVIDER === 'demo') console.log('DEMO: no real bank payment. Email preview stays in the local database.');
});
const tick = () => void service.tick().catch(() => console.error('Background worker failed. Stored jobs will be retried.'));
const timer = setInterval(tick, 2000);
timer.unref();
tick();

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close(() => process.exit(0));
  // A pending notification has a durable lease and can be retried after restart.
  setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
