// Volcano TTS configuration
export interface VolcanoTtsConfig {
  appId: string;
  token: string;
  resourceId?: string;
  voice?: string;
}

// Volcano ASR configuration
export interface VolcanoAsrConfig {
  appId: string;
  token: string;
  resourceId?: string;
}
