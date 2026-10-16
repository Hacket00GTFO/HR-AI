"""Domain-event bus integration (RabbitMQ topic exchange `domain.events`).

Consumers: strafor.vacancy.published/updated, strafor.application.submitted,
strafor.resume.parsed → embeddings refresh / match precompute (enqueued to
Celery when available).

Publishers: strafor.matching.score_computed, strafor.matching.embedding_updated.

Everything tolerates a missing broker: consumers never start, publishes no-op.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone

from .config import get_settings

logger = logging.getLogger(__name__)

EXCHANGE = 'domain.events'
QUEUE = 'ai-matching.events'

CONSUMED_KEYS = [
    'strafor.vacancy.published',
    'strafor.vacancy.updated',
    'strafor.application.submitted',
    'strafor.resume.parsed',
]

_connection = None


async def publish(event_type: str, payload: dict, correlation_id: str | None = None) -> None:
    """Best-effort event publish; silently drops when the broker is absent."""
    url = get_settings().rabbitmq_url
    if not url:
        return
    try:
        import aio_pika

        conn = await aio_pika.connect_robust(url, timeout=5)
        try:
            channel = await conn.channel()
            exchange = await channel.declare_exchange(EXCHANGE, 'topic', durable=True)
            envelope = {
                'type': event_type,
                'version': 1,
                'occurredAt': datetime.now(timezone.utc).isoformat(),
                'correlationId': correlation_id or str(uuid.uuid4()),
                'payload': payload,
            }
            await exchange.publish(
                aio_pika.Message(body=json.dumps(envelope).encode(), content_type='application/json'),
                routing_key=event_type,
            )
        finally:
            await conn.close()
    except Exception as exc:
        logger.debug('event publish %s skipped: %s', event_type, exc)


async def publish_score_computed(candidate_id, vacancy_id, score, source, correlation_id=None) -> None:
    await publish('strafor.matching.score_computed', {
        'candidateId': int(candidate_id) if candidate_id is not None else None,
        'vacancyId': int(vacancy_id) if vacancy_id is not None else None,
        'score': round(float(score) * 100, 2),
        'modelVersion': get_settings().model_version,
        'source': source,
    }, correlation_id)


async def publish_eval_run_completed(result: dict, persisted: bool, correlation_id=None) -> None:
    """strafor.matching.eval_run_completed — emitted by POST /v1/eval/run."""
    await publish('strafor.matching.eval_run_completed', {
        'dataset': result.get('dataset'),
        'datasetVersion': result.get('dataset_version'),
        'scorer': result.get('scorer'),
        'metrics': result.get('metrics') or {},
        'modelVersion': result.get('model_version'),
        'promptVersion': result.get('prompt_version'),
        'persisted': bool(persisted),
    }, correlation_id)


async def publish_embedding_updated(entity: str, owner_id: int, correlation_id=None) -> None:
    await publish('strafor.matching.embedding_updated', {
        'entity': entity,
        'ownerId': owner_id,
        'modelVersion': get_settings().embedding_version,
    }, correlation_id)


async def _handle_event(body: bytes) -> None:
    try:
        envelope = json.loads(body)
        etype = envelope.get('type', '')
        payload = envelope.get('payload') or {}
    except Exception:
        return
    try:
        from .worker import celery_app
        if etype in ('strafor.vacancy.published', 'strafor.vacancy.updated'):
            celery_app.send_task('ai_matching.index_entity',
                                 args=['vacancy', payload.get('vacancyId'), payload])
        elif etype in ('strafor.application.submitted', 'strafor.resume.parsed'):
            celery_app.send_task('ai_matching.index_entity',
                                 args=['candidate', payload.get('candidateId'), payload])
    except Exception as exc:
        logger.debug('event %s dispatch failed: %s', etype, exc)


async def consume_forever(stop: asyncio.Event) -> None:
    """Connect robustly and consume until `stop` is set. Retries forever —
    the service must boot and score even with no broker."""
    url = get_settings().rabbitmq_url
    if not url:
        logger.info('RABBITMQ_URL unset — event consumer disabled')
        return
    import aio_pika

    while not stop.is_set():
        try:
            conn = await aio_pika.connect_robust(url, timeout=5)
            channel = await conn.channel()
            await channel.set_qos(prefetch_count=10)
            exchange = await channel.declare_exchange(EXCHANGE, 'topic', durable=True)
            queue = await channel.declare_queue(QUEUE, durable=True)
            for key in CONSUMED_KEYS:
                await queue.bind(exchange, routing_key=key)
            logger.info('event consumer bound to %s', EXCHANGE)
            async with queue.iterator() as it:
                async for message in it:
                    if stop.is_set():
                        break
                    async with message.process(ignore_processed=True):
                        await _handle_event(message.body)
            await conn.close()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning('event consumer reconnecting (%s)', exc)
            await asyncio.sleep(5)
