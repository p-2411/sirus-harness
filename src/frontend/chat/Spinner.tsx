import { useEffect, useState } from 'react';
import { Text } from 'ink';
import { theme } from '../styles/theme';

export function Spinner() {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setFrame(prev => (prev + 1) % frames.length), 90);
    return () => clearInterval(timer);
  }, []);
  return <Text color={theme.accentSoft}>{frames[frame]}</Text>;
}
