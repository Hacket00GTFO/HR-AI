import type { Pool } from 'pg';
import type { ServiceLogger } from '@strafor/node-common';
import type { ServiceConfig } from './config.js';
import type { EventPublisher } from './events.js';

/** Dependencies every router shares — constructed once in server/app. */
export interface ServiceDeps {
    pool: Pool;
    config: ServiceConfig;
    publisher: EventPublisher;
    log: ServiceLogger;
}
