import { fileURLToPath } from 'node:url';
// Configure the renderer before importing sharp: Pango chooses its backend
// when libvips is loaded, not when the first text command arrives.
process.env.PANGOCAIRO_BACKEND ||= 'fc';
process.env.FONTCONFIG_FILE ||= fileURLToPath(new URL('../assets/fonts/fonts.conf',import.meta.url));
