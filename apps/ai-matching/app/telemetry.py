"""OpenTelemetry tracing + JSON logging setup for ai-matching."""
from __future__ import annotations

import logging
import os
import sys

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor
from opentelemetry.instrumentation.redis import RedisInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.semconv.resource import ResourceAttributes

_tracing_initialized = False


def setup_tracing(service_name: str = "ai-matching") -> None:
    """Initialize OpenTelemetry tracing. Idempotent."""
    global _tracing_initialized
    if _tracing_initialized:
        return
    _tracing_initialized = True

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
    if not endpoint:
        return  # Tracing disabled when no endpoint configured

    resource = Resource.create({
        ResourceAttributes.SERVICE_NAME: service_name,
        ResourceAttributes.SERVICE_VERSION: "1.0.0",
    })

    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    # Auto-instrument
    HTTPXClientInstrumentor().instrument()
    PsycopgInstrumentor().instrument()
    RedisInstrumentor().instrument()


def setup_json_logging(service_name: str = "ai-matching") -> None:
    """Configure JSON logging with trace_id correlation."""
    from pythonjsonlogger import jsonlogger

    class TraceContextFilter(logging.Filter):
        def filter(self, record):
            span = trace.get_current_span()
            if span and span.is_recording():
                ctx = span.get_span_context()
                record.trace_id = format(ctx.trace_id, "032x")
                record.span_id = format(ctx.span_id, "016x")
            else:
                record.trace_id = ""
                record.span_id = ""
            record.service = service_name
            return True

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(jsonlogger.JsonFormatter(
        "%(asctime)s %(levelname)s %(service)s %(trace_id)s %(span_id)s %(name)s %(message)s",
        rename_fields={"asctime": "time", "levelname": "level"},
    ))
    handler.addFilter(TraceContextFilter())

    root = logging.getLogger()
    root.handlers = [handler]
    root.setLevel(os.environ.get("LOG_LEVEL", "INFO"))
