import { Box } from 'ink';
import type { ReactNode } from 'react';

// Draws a pop-up over the conversation above this spot instead of pushing
// it up: the anchor takes no rows and the content hangs from its bottom edge.
// A background colour Ink does not recognise fills the rows with plain
// spaces, so the text underneath does not show through the gaps.
export function Overlay({ children }: { children: ReactNode }) {
  return (
    <Box height={0} flexShrink={0} position="relative">
      <Box position="absolute" bottom={0} width="100%" flexDirection="column" backgroundColor="blank">
        {children}
      </Box>
    </Box>
  );
}
