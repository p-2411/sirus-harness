import { attachClipboardImage, attachImageFile, describeImage } from '../../images';
import type { CommandSpec } from '../types';

// The same attachment ctrl+v makes, for terminals where ctrl+v is taken and
// for images that are already files.
export const imageCommandSpec: CommandSpec = {
  name: 'image',
  args: '[path]',
  description: 'attach the clipboard image or an image file',
  run: async (args, execution) => {
    const image = args.length === 0
      ? await attachClipboardImage()
      : attachImageFile(args.join(' '), execution.session.getDirectory());
    execution.attachImage(image);
    return { kind: 'success', text: `Attached ${describeImage(image)}.` };
  },
};
