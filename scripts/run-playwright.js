const { spawn } = require('node:child_process');
const net = require('node:net');

const probe = net.createServer();

probe.once('error', (error) => {
  console.error('Unable to select a port for the Pulse test server:', error);
  process.exitCode = 1;
});

probe.listen(0, '127.0.0.1', () => {
  const { port } = probe.address();

  probe.close((error) => {
    if (error) {
      console.error('Unable to release the selected Pulse test port:', error);
      process.exitCode = 1;
      return;
    }

    const runner = spawn(process.execPath, [
      require.resolve('@playwright/test/cli'),
      'test',
      'tests/pulse-orders.spec.ts',
      ...process.argv.slice(2),
    ], {
      stdio: 'inherit',
      env: { ...process.env, PULSE_TEST_PORT: String(port) },
    });

    runner.once('error', (spawnError) => {
      console.error('Unable to start the Pulse Playwright tests:', spawnError);
      process.exitCode = 1;
    });

    runner.once('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  });
});
