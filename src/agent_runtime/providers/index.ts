import { boundRuntimes } from '../runtime/runtime';
import { VENDOR_INFO, VENDORS, isKnownModel, modelIds, type Vendor } from './catalog';
import { createProvider, type Provider } from './provider';
import { onProviderSourceChange } from './sources';

// The two providers, and the handful of questions that span them. The
// catalog (`catalog.ts`), the credential list (`sources.ts`) and one
// vendor's composition (`provider.ts`) are imported directly by their
// consumers; only the registry lives here.

const providers: Record<Vendor, Provider> = {
  claude: createProvider({ vendor: VENDOR_INFO.claude }),
  gpt: createProvider({ vendor: VENDOR_INFO.gpt }),
};

export function providerFor(vendor: Vendor): Provider {
  return providers[vendor];
}

export function allProviders(): Provider[] {
  return VENDORS.map(vendor => providers[vendor]);
}

// Every model this process can actually run: the catalog's, plus anything
// the test suite bound a scripted runtime to.
export function servesModel(model: string): boolean {
  return isKnownModel(model) || model in boundRuntimes;
}

export function servableModelIds(): string[] {
  return [...modelIds(), ...Object.keys(boundRuntimes)];
}

export const onProviderChange = onProviderSourceChange;
