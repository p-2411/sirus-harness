import type { Runtime, RuntimeOptions } from './runtime';

// Placeholder until the ACP client lands: the runtime contract compiles and
// scripted runtimes run, but a real vendor cannot be started yet.
export async function startAcpRuntime(options: RuntimeOptions): Promise<Runtime> {
  throw new Error(`No ACP runtime for ${options.vendor} yet`);
}
