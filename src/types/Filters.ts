export interface EQBand {
  band: number;
  gain: number;
}

export interface KaraokeFilterData {
  level?: number;
  monoLevel?: number;
  filterBand?: number;
  filterWidth?: number;
}

export interface TimescaleFilterData {
  speed?: number;
  pitch?: number;
  rate?: number;
}

export interface TremoloFilterData {
  frequency?: number;
  depth?: number;
}

export interface VibratoFilterData {
  frequency?: number;
  depth?: number;
}

export interface RotationFilterData {
  rotationHz?: number;
}

export interface DistortionFilterData {
  sinOffset?: number;
  sinScale?: number;
  cosOffset?: number;
  cosScale?: number;
  tanOffset?: number;
  tanScale?: number;
  offset?: number;
  scale?: number;
}

export interface ChannelMixFilterData {
  leftToLeft?: number;
  leftToRight?: number;
  rightToLeft?: number;
  rightToRight?: number;
}

export interface LowPassFilterData {
  smoothing?: number;
}

export type AudioOutputs = "mono" | "stereo" | "left" | "right";

export interface EchoPluginFilter {
  delay?: number;
  decay?: number;
}

export interface ReverbPluginFilter {
  delays?: number[];
  gains?: number[];
}

export interface NormalizationPluginFilter {
  maxAmplitude?: number;
  adaptive?: boolean;
}

export interface HighPassPluginFilter {
  cutoffFrequency?: number;
  boostFactor?: number;
}

export interface LavaDspxPluginFilters {
  "low-pass"?: {
    cutoffFrequency?: number;
    boostFactor?: number;
  };
  "high-pass"?: HighPassPluginFilter;
  normalization?: NormalizationPluginFilter;
  echo?: EchoPluginFilter;
  reverb?: ReverbPluginFilter;
}

export interface LavalinkFilterData {
  volume?: number;
  equalizer?: EQBand[];
  karaoke?: KaraokeFilterData | null;
  timescale?: TimescaleFilterData | null;
  tremolo?: TremoloFilterData | null;
  vibrato?: VibratoFilterData | null;
  rotation?: RotationFilterData | null;
  distortion?: DistortionFilterData | null;
  channelMix?: ChannelMixFilterData | null;
  lowPass?: LowPassFilterData | null;
  pluginFilters?: LavaDspxPluginFilters & Record<string, unknown>;
}

export interface FilterData extends LavalinkFilterData {
  audioOutput?: AudioOutputs;
}

export interface PlayerFiltersState {
  volume: boolean;
  vaporwave: boolean;
  custom: boolean;
  nightcore: boolean;
  slowmode: boolean;
  rotation: boolean;
  karaoke: boolean;
  tremolo: boolean;
  vibrato: boolean;
  lowPass: boolean;
  distortion: boolean;
  audioOutput: AudioOutputs;
  lavadspx: {
    lowPass: boolean;
    highPass: boolean;
    normalization: boolean;
    echo: boolean;
    reverb: boolean;
  };
}
