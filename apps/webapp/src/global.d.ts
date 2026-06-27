declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.css' {}

interface GbaKitConfig {
  serverBaseUrl: string;
  hasRom: boolean;
  /** A sidecar `-g` ELF is configured and served at /api/loadElf for auto-load. */
  hasElf?: boolean;
}

interface Window {
  __GBAKIT_CONFIG__?: GbaKitConfig;
}
