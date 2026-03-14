declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.css' {}

interface GbaKitConfig {
  serverBaseUrl: string;
  hasRom: boolean;
}

interface Window {
  __GBAKIT_CONFIG__?: GbaKitConfig;
}
