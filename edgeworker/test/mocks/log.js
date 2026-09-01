// Mock of the Akamai EdgeWorkers 'log' module. Captures lines for assertions.
const lines = [];

function capture(level) {
  return (...args) => lines.push({ level, message: args.join(' ') });
}

export const logger = {
  error: capture('error'),
  warn: capture('warn'),
  info: capture('info'),
  debug: capture('debug'),
  log: capture('log'),
};

export function __getLogs() {
  return lines;
}

export function __clearLogs() {
  lines.length = 0;
}
