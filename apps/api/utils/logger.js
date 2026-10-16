// Pino JSON logger for the monolith.
// Replaces the previous custom console logger so Promtail can parse JSON.
// Maintains backwards-compatible API: logger.info(msg), logger.info(obj, msg),
// logger.error('Error:', err.message), etc.
// Redaction of PII/secrets is handled by pino's redact paths (see node-common).

const { createLogger } = require('@strafor/node-common');

const pino = createLogger({ serviceName: 'api' });

// Bridge: accept the old variadic API and forward to pino.
// - logger.info('message')                    -> pino.info('message')
// - logger.info('msg', extra, ...)             -> pino.info({ extra, ... }, 'msg')
// - logger.info({ obj }, 'msg')                -> pino.info({ obj }, 'msg')
// - logger.error('Error:', err.message)        -> pino.error({ detail: err.message }, 'Error:')
function bridge(level) {
    return (...args) => {
        if (args.length === 0) return pino[level]('');
        // If first arg is an object, treat it as pino's merge object
        if (typeof args[0] === 'object' && args[0] !== null && !(args[0] instanceof Error)) {
            const obj = args[0];
            const msg = args.slice(1).map(String).join(' ') || '';
            return pino[level](obj, msg);
        }
        // If any arg is an Error, extract it as a structured field
        const errors = args.filter((a) => a instanceof Error);
        if (errors.length > 0) {
            const msg = args
                .filter((a) => !(a instanceof Error))
                .map(String)
                .join(' ');
            return pino[level]({ err: errors[0] }, msg);
        }
        // Plain string args — join them
        const msg = args.map(String).join(' ');
        return pino[level](msg);
    };
}

module.exports = {
    debug: bridge('debug'),
    info: bridge('info'),
    warn: bridge('warn'),
    error: bridge('error'),
    // Underlying pino instance for advanced use (child loggers, etc.)
    _pino: pino
};
