import type { HarmonyModule } from './types.js';
import { coinflip } from './coinflip/index.js';
import { pins } from './pins/index.js';
import { polls } from './polls/index.js';
import { reactions } from './reactions/index.js';
import { search } from './search/index.js';
import { uploads } from './uploads/index.js';

/** Every module this build ships. To add one: import it and list it here. */
export const modules: readonly HarmonyModule[] = [
  uploads,
  reactions,
  pins,
  search,
  polls,
  coinflip,
];
