// import { useSyncExternalStore } from "react";

// export class AppState {
//   private static instance: AppState;
//   private model: string = 'gpt-5.6-luna';
//   private listeners: Set<() => void> = new Set();

//   static getAppState(): AppState {
//     if (AppState.instance) {
//       return AppState.instance;
//     }
//     return (AppState.instance = new AppState());
//   }

//   setModel(model: string): void {
//     this.model = model;
//     this.notifyListeners();
//   }

//   getModel(): string {
//     return this.model;
//   }

//   subscribe(listener: () => void): () => void {
//     this.listeners.add(listener);
//     return () => this.listeners.delete(listener);
//   }

//   private constructor() { }

//   private notifyListeners(): void {
//     for (const listener of this.listeners) {
//       listener();
//     }
//   }

// }

// export function useModel(): string {
//   const state = AppState.getAppState();
//   return useSyncExternalStore(
//     (cb) => state.subscribe(cb),   // arrow wrapper keeps `this` bound
//     () => state.getModel(),        // snapshot = the value, not the store
//   );
// }
