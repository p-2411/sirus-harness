import os from 'os';
import path from 'path';

// Where Sirus keeps everything it owns on this machine: sessions, settings,
// checkpoints, attached images and the memory database. A leaf module, so
// nothing has to depend on the persistence layer just to find the path.
export function dataDirectory(): string {
  if (process.env.SIRUS_DATA_DIR) return process.env.SIRUS_DATA_DIR;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Sirus');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? os.homedir(), 'Sirus');
  }
  return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'), 'sirus');
}
