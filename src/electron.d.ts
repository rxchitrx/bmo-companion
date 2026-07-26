import type { CompanionApi } from "./types";

declare global {
  interface Window {
    companion: CompanionApi;
  }
}

export {};
