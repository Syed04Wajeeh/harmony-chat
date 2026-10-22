import { defineWebModule } from '../types.js';
import { Reactions, ReactionSheetSection, ReactionToolbarButton } from './Reactions.js';

export const reactions = defineWebModule({
  id: 'reactions',
  messageFooter: Reactions,
  messageToolbar: ReactionToolbarButton,
  messageSheet: ReactionSheetSection,
});
