import { pins } from './pins/index.js';
import { polls } from './polls/index.js';
import { reactions } from './reactions/index.js';
import { search } from './search/index.js';
import type { WebModule } from './types.js';

/** Every module the client knows. To add one: import it and list it here. */
export const webModules: readonly WebModule[] = [reactions, pins, search, polls];
