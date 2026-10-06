import type { MbApi } from '../shared/api';

declare global {
  interface Window {
    mb: MbApi;
  }
}

export {};
