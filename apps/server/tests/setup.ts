import { afterAll } from 'vitest';
import { closeTestDb } from './db-utils.ts';

afterAll(closeTestDb);
