import { attachClipboardImage, attachImageFile, describeImage } from '../../images';
import type { CommandSpec } from '../types';

// The same attachment ctrl+v makes, for terminals where ctrl+v is taken and
// for images that are already files.
export const imageCommandSpec: CommandSpec = {
  name: 'image',
  args: '[path]',
  description: 'attach the clipboard image or an image file',
  // Only a caller with a message being composed has somewhere to put it.
  run: async (args, context) => {
    const attachImage = context.attachImage;
    if (!attachImage) throw new Error('/image is not available here.');
    const image = args.length === 0
      ? await attachClipboardImage()
      : attachImageFile(args.join(' '), context.session.getDirectory());
    attachImage(image);
    return { kind: 'success', text: `Attached ${describeImage(image)}.` };
  },
};
