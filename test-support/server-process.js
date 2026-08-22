const { app } = require('../server');

const server = app.listen(0, '127.0.0.1', () => {
  if (process.send) process.send({ port: server.address().port });
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
