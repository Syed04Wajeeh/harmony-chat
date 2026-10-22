import { randomInt } from 'node:crypto';
import { defineModule } from '../types.js';

export const coinflip = defineModule({
  id: 'coinflip',
  name: 'Coin flip',
  description: 'Flip a coin with /coinflip.',
  optional: true,

  register(ctx) {
    ctx.commands.register({
      name: 'coinflip',
      description: 'Flip a coin',
      options: [{ name: 'private', description: 'Only show the result to you', type: 'boolean' }],
      handler: ({ user, options }) => ({
        content: `${user.displayName} flipped ${randomInt(2) === 0 ? 'heads' : 'tails'}.`,
        ephemeral: options['private'] === true,
      }),
    });
  },
});
