// RabbitMQ (amqplib) metrics helpers.
// Counters for published/consumed messages + consume duration histogram.
//
// Usage:
//   const { createAmqpMetrics } = require('@strafor/node-common/amqpMetrics');
//   const amqp = createAmqpMetrics({ metrics });
//   // On publish:
//   amqp.incPublished({ exchange, routing_key });
//   // On consume (ack/nack/requeue):
//   amqp.incConsumed({ queue, outcome });
//   amqp.observeConsumeDuration({ queue }, durationSec);

/**
 * Create AMQP metric helpers bound to a metrics bundle.
 * @param {{ metrics: object }} opts
 */
function createAmqpMetrics(opts = {}) {
    const metrics = opts.metrics;
    if (!metrics) return null;

    const published = metrics.counter('amqp_messages_published_total', 'Total messages published to RabbitMQ', [
        'exchange',
        'routing_key'
    ]);

    const consumed = metrics.counter('amqp_messages_consumed_total', 'Total messages consumed from RabbitMQ', [
        'queue',
        'outcome'
    ]);

    const consumeDuration = metrics.histogram(
        'amqp_consume_duration_seconds',
        'RabbitMQ message consume duration in seconds',
        ['queue']
    );

    return {
        incPublished(labels = {}) {
            published.inc(labels);
        },
        incConsumed(labels = {}) {
            consumed.inc(labels);
        },
        observeConsumeDuration(labels, value) {
            consumeDuration.observe(labels, value);
        }
    };
}

module.exports = { createAmqpMetrics };
