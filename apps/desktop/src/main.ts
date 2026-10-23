import './style.css';
import { mountSetup } from './setup.js';
import { mountTitleBar, needsTitleBar } from './titlebar.js';

const slot = document.getElementById('titlebar-slot');
if (slot && needsTitleBar()) mountTitleBar(slot);
void mountSetup(document);
