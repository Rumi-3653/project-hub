'use strict';
// Read-only bridge to the test launcher; no process listing is fabricated.
const socket = require('node:net').createConnection(process.env.HUB_TEST_PROCESS_SOCKET);
let output = '';
socket.setTimeout(1900, () => socket.destroy(Error('test_process_timeout')));
socket.on('connect', () => socket.write(JSON.stringify(process.argv.slice(2)) + '\n'));
socket.on('data', chunk => { output += chunk; if (output.length > 12 * 1024 * 1024) socket.destroy(Error('test_process_response_too_large')); });
socket.on('end', () => {
  try { const result = JSON.parse(output); if (result.error) process.stderr.write(result.error); else process.stdout.write(result.stdout); process.exitCode = result.status; }
  catch (error) { console.error(error.message); process.exitCode = 1; }
});
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
