import { AudioOutputsData, DebugEvents } from "../constants";
import type {
  AudioOutputs,
  ChannelMixFilterData,
  DistortionFilterData,
  EchoPluginFilter,
  EQBand,
  FilterData,
  HighPassPluginFilter,
  KaraokeFilterData,
  LavalinkFilterData,
  LowPassFilterData,
  NormalizationPluginFilter,
  PlayerFiltersState,
  ReverbPluginFilter,
  RotationFilterData,
  TimescaleFilterData,
  TremoloFilterData,
  VibratoFilterData,
} from "../types";
import type { Player } from "./Player";

/**
 * Real-time Lavalink v4 audio filter, equalizer, timescale, and plugin-filter controller.
 */
export class FilterManager {
  public readonly player: Player;
  public equalizerBands: EQBand[] = [];
  public filterUpdatedState = false;
  public filters: PlayerFiltersState = {
    volume: false,
    vaporwave: false,
    custom: false,
    nightcore: false,
    slowmode: false,
    rotation: false,
    karaoke: false,
    tremolo: false,
    vibrato: false,
    lowPass: false,
    distortion: false,
    audioOutput: "stereo",
    lavadspx: {
      lowPass: false,
      highPass: false,
      normalization: false,
      echo: false,
      reverb: false,
    },
  };

  public data: FilterData = {
    volume: 1,
    equalizer: [],
    karaoke: null,
    timescale: null,
    tremolo: null,
    vibrato: null,
    rotation: null,
    distortion: null,
    channelMix: null,
    lowPass: null,
    pluginFilters: {},
    audioOutput: "stereo",
  };

  /**
   * Helpers for the `lavadspx-plugin` Lavalink v4 DSP filters.
   */
  public readonly lavalinkLavaDspxPlugin = {
    toggleLowPass: async (cutoffFrequency = 80, boostFactor = 1.0): Promise<FilterManager> => {
      this.data.pluginFilters ??= {};
      if (this.filters.lavadspx.lowPass) {
        delete this.data.pluginFilters["low-pass"];
        this.filters.lavadspx.lowPass = false;
      } else {
        this.data.pluginFilters["low-pass"] = { cutoffFrequency, boostFactor };
        this.filters.lavadspx.lowPass = true;
      }
      await this.applyPlayerFilters();
      return this;
    },
    toggleHighPass: async (
      options: HighPassPluginFilter = { cutoffFrequency: 80, boostFactor: 1.0 }
    ): Promise<FilterManager> => {
      this.data.pluginFilters ??= {};
      if (this.filters.lavadspx.highPass) {
        delete this.data.pluginFilters["high-pass"];
        this.filters.lavadspx.highPass = false;
      } else {
        this.data.pluginFilters["high-pass"] = options;
        this.filters.lavadspx.highPass = true;
      }
      await this.applyPlayerFilters();
      return this;
    },
    toggleNormalization: async (
      options: NormalizationPluginFilter = { maxAmplitude: 0.75, adaptive: true }
    ): Promise<FilterManager> => {
      this.data.pluginFilters ??= {};
      if (this.filters.lavadspx.normalization) {
        delete this.data.pluginFilters.normalization;
        this.filters.lavadspx.normalization = false;
      } else {
        this.data.pluginFilters.normalization = options;
        this.filters.lavadspx.normalization = true;
      }
      await this.applyPlayerFilters();
      return this;
    },
    toggleEcho: async (
      options: EchoPluginFilter = { delay: 0.5, decay: 0.5 }
    ): Promise<FilterManager> => {
      this.data.pluginFilters ??= {};
      if (this.filters.lavadspx.echo) {
        delete this.data.pluginFilters.echo;
        this.filters.lavadspx.echo = false;
      } else {
        this.data.pluginFilters.echo = options;
        this.filters.lavadspx.echo = true;
      }
      await this.applyPlayerFilters();
      return this;
    },
    toggleReverb: async (
      options: ReverbPluginFilter = {
        delays: [0.037, 0.042, 0.048, 0.053],
        gains: [0.84, 0.83, 0.82, 0.81],
      }
    ): Promise<FilterManager> => {
      this.data.pluginFilters ??= {};
      if (this.filters.lavadspx.reverb) {
        delete this.data.pluginFilters.reverb;
        this.filters.lavadspx.reverb = false;
      } else {
        this.data.pluginFilters.reverb = options;
        this.filters.lavadspx.reverb = true;
      }
      await this.applyPlayerFilters();
      return this;
    },
  };

  constructor(player: Player) {
    this.player = player;
  }

  /**
   * Builds a clean Lavalink v4 `filters` payload omitting inactive/empty fields.
   */
  public toLavalinkFilters(): LavalinkFilterData {
    const payload: LavalinkFilterData = {};

    if (typeof this.data.volume === "number" && this.data.volume !== 1) {
      payload.volume = this.data.volume;
    }
    if (this.equalizerBands.length > 0) {
      payload.equalizer = [...this.equalizerBands];
    }
    if (this.data.karaoke) payload.karaoke = { ...this.data.karaoke };
    if (this.data.timescale) payload.timescale = { ...this.data.timescale };
    if (this.data.tremolo) payload.tremolo = { ...this.data.tremolo };
    if (this.data.vibrato) payload.vibrato = { ...this.data.vibrato };
    if (this.data.rotation) payload.rotation = { ...this.data.rotation };
    if (this.data.distortion) payload.distortion = { ...this.data.distortion };
    if (this.data.channelMix) payload.channelMix = { ...this.data.channelMix };
    if (this.data.lowPass) payload.lowPass = { ...this.data.lowPass };
    if (this.data.pluginFilters && Object.keys(this.data.pluginFilters).length > 0) {
      payload.pluginFilters = { ...this.data.pluginFilters };
    }

    return payload;
  }

  /**
   * Sends the current filter configuration to Lavalink v4 via REST (`PATCH /v4/sessions/.../players/...`).
   */
  public async applyPlayerFilters(): Promise<FilterManager> {
    this.data.equalizer = [...this.equalizerBands];
    this.checkFiltersState();
    this.filterUpdatedState = true;

    if (!this.player.node.connected || !this.player.node.sessionId) {
      return this;
    }

    const filtersPayload = this.toLavalinkFilters();

    await this.player.node.updatePlayer({
      guildId: this.player.guildId,
      playerOptions: {
        filters: filtersPayload,
      },
    });

    const maxFixDuration =
      this.player.LavalinkManager.options.advancedOptions?.maxFilterFixDuration ?? 600_000;

    if (
      this.player.options.instaUpdateFiltersFix === true &&
      this.player.playing &&
      this.player.queue.current &&
      !this.player.queue.current.info.isStream &&
      this.player.queue.current.info.isSeekable &&
      this.player.queue.current.info.duration <= maxFixDuration
    ) {
      await this.player.seek(this.player.position);
    }

    return this;
  }

  /**
   * Synchronizes boolean flags in `this.filters` with `this.data`.
   */
  public checkFiltersState(): FilterManager {
    this.filters.volume = typeof this.data.volume === "number" && this.data.volume !== 1;
    this.filters.rotation = Boolean(this.data.rotation && this.data.rotation.rotationHz);
    this.filters.karaoke = Boolean(this.data.karaoke);
    this.filters.tremolo = Boolean(this.data.tremolo);
    this.filters.vibrato = Boolean(this.data.vibrato);
    this.filters.lowPass = Boolean(this.data.lowPass);
    this.filters.distortion = Boolean(this.data.distortion);
    this.filters.audioOutput = this.data.audioOutput ?? "stereo";

    const ts = this.data.timescale;
    if (!ts || ((ts.speed ?? 1) === 1 && (ts.pitch ?? 1) === 1 && (ts.rate ?? 1) === 1)) {
      this.filters.nightcore = false;
      this.filters.vaporwave = false;
      this.filters.slowmode = false;
      this.filters.custom = false;
    } else if (!this.filters.nightcore && !this.filters.vaporwave && !this.filters.slowmode) {
      this.filters.custom = true;
    } else {
      this.filters.custom = false;
    }

    this.filters.lavadspx = {
      lowPass: Boolean(this.data.pluginFilters?.["low-pass"]),
      highPass: Boolean(this.data.pluginFilters?.["high-pass"]),
      normalization: Boolean(this.data.pluginFilters?.normalization),
      echo: Boolean(this.data.pluginFilters?.echo),
      reverb: Boolean(this.data.pluginFilters?.reverb),
    };

    return this;
  }

  /**
   * Resets all filters and equalizer bands back to default and updates Lavalink.
   */
  public async resetFilters(): Promise<FilterManager> {
    this.equalizerBands = [];
    this.data = {
      volume: 1,
      equalizer: [],
      karaoke: null,
      timescale: null,
      tremolo: null,
      vibrato: null,
      rotation: null,
      distortion: null,
      channelMix: null,
      lowPass: null,
      pluginFilters: {},
      audioOutput: "stereo",
    };
    this.filters.nightcore = false;
    this.filters.vaporwave = false;
    this.filters.slowmode = false;
    this.filters.custom = false;

    await this.applyPlayerFilters();
    return this;
  }

  /** Alias for `resetFilters()`. */
  public async clearFilters(): Promise<FilterManager> {
    return this.resetFilters();
  }

  /**
   * Sets filter-level volume multiplier (`0.0` to `5.0`, where `1.0` is 100%).
   */
  public async setVolume(volume: number): Promise<FilterManager> {
    if (typeof volume !== "number" || Number.isNaN(volume) || volume < 0 || volume > 5) {
      throw new RangeError("Filter volume must be a number between 0.0 and 5.0.");
    }
    this.data.volume = volume;
    this.player.LavalinkManager._debug(DebugEvents.PlayerVolumeAsFilter, {
      state: "log",
      message: `Set filter volume to ${volume} for guild ${this.player.guildId}`,
      functionLayer: "FilterManager > setVolume()",
    });
    await this.applyPlayerFilters();
    return this;
  }

  /**
   * Sets output channel routing (`"mono" | "stereo" | "left" | "right"`).
   */
  public async setAudioOutput(type: AudioOutputs): Promise<FilterManager> {
    if (!AudioOutputsData[type]) {
      throw new RangeError(`Invalid audio output type "${type}". Expected mono, stereo, left, or right.`);
    }
    this.data.audioOutput = type;
    this.data.channelMix = type === "stereo" ? null : { ...AudioOutputsData[type] };
    await this.applyPlayerFilters();
    return this;
  }

  /**
   * Applies one or more 15-band equalizer bands (`band: 0..14`, `gain: -0.25..1.0`).
   */
  public async setEQ(bands: EQBand | EQBand[]): Promise<FilterManager> {
    const list = Array.isArray(bands) ? bands : [bands];
    for (const item of list) {
      if (typeof item.band !== "number" || item.band < 0 || item.band > 14) {
        throw new RangeError(`Equalizer band index must be between 0 and 14 (received ${item.band}).`);
      }
      if (typeof item.gain !== "number" || item.gain < -0.25 || item.gain > 1.0) {
        throw new RangeError(`Equalizer gain must be between -0.25 and 1.0 (received ${item.gain}).`);
      }
      const existingIdx = this.equalizerBands.findIndex((b) => b.band === item.band);
      if (existingIdx !== -1) {
        this.equalizerBands[existingIdx] = { band: item.band, gain: item.gain };
      } else {
        this.equalizerBands.push({ band: item.band, gain: item.gain });
      }
    }
    this.equalizerBands.sort((a, b) => a.band - b.band);
    await this.applyPlayerFilters();
    return this;
  }

  /** Alias for `setEQ()`. */
  public async setEqualizer(bands: EQBand | EQBand[]): Promise<FilterManager> {
    return this.setEQ(bands);
  }

  /**
   * Clears all equalizer bands.
   */
  public async clearEQ(): Promise<FilterManager> {
    this.equalizerBands = [];
    await this.applyPlayerFilters();
    return this;
  }

  public async setSpeed(speed = 1): Promise<FilterManager> {
    if (speed <= 0) throw new RangeError("Timescale speed must be greater than 0.");
    this.filters.nightcore = false;
    this.filters.vaporwave = false;
    this.filters.slowmode = false;
    this.data.timescale = { ...(this.data.timescale || {}), speed };
    await this.applyPlayerFilters();
    return this;
  }

  public async setPitch(pitch = 1): Promise<FilterManager> {
    if (pitch <= 0) throw new RangeError("Timescale pitch must be greater than 0.");
    this.filters.nightcore = false;
    this.filters.vaporwave = false;
    this.filters.slowmode = false;
    this.data.timescale = { ...(this.data.timescale || {}), pitch };
    await this.applyPlayerFilters();
    return this;
  }

  public async setRate(rate = 1): Promise<FilterManager> {
    if (rate <= 0) throw new RangeError("Timescale rate must be greater than 0.");
    this.filters.nightcore = false;
    this.filters.vaporwave = false;
    this.filters.slowmode = false;
    this.data.timescale = { ...(this.data.timescale || {}), rate };
    await this.applyPlayerFilters();
    return this;
  }

  public async setTimescale(timescale: TimescaleFilterData | null): Promise<FilterManager> {
    this.filters.nightcore = false;
    this.filters.vaporwave = false;
    this.filters.slowmode = false;
    this.data.timescale = timescale ? { ...timescale } : null;
    await this.applyPlayerFilters();
    return this;
  }

  public async toggleNightcore(speed = 1.289999523162842, pitch = 1.289999523162842, rate = 0.9365999523162842): Promise<boolean> {
    const enable = !this.filters.nightcore;
    this.filters.vaporwave = false;
    this.filters.slowmode = false;
    this.filters.custom = false;
    this.filters.nightcore = enable;
    this.data.timescale = enable ? { speed, pitch, rate } : null;
    await this.applyPlayerFilters();
    return this.filters.nightcore;
  }

  public async toggleVaporwave(speed = 0.8500000238418579, pitch = 0.800000011920929, rate = 1): Promise<boolean> {
    const enable = !this.filters.vaporwave;
    this.filters.nightcore = false;
    this.filters.slowmode = false;
    this.filters.custom = false;
    this.filters.vaporwave = enable;
    this.data.timescale = enable ? { speed, pitch, rate } : null;
    await this.applyPlayerFilters();
    return this.filters.vaporwave;
  }

  public async toggleSlowmode(speed = 0.75, pitch = 1.0, rate = 0.85): Promise<boolean> {
    const enable = !this.filters.slowmode;
    this.filters.nightcore = false;
    this.filters.vaporwave = false;
    this.filters.custom = false;
    this.filters.slowmode = enable;
    this.data.timescale = enable ? { speed, pitch, rate } : null;
    await this.applyPlayerFilters();
    return this.filters.slowmode;
  }

  public async toggleRotation(rotationHz = 0.2): Promise<boolean> {
    const enable = !this.filters.rotation;
    this.data.rotation = enable ? { rotationHz } : null;
    await this.applyPlayerFilters();
    return this.filters.rotation;
  }

  /** Alias for `toggleRotation()` (8D surround pan effect). */
  public async toggle8D(rotationHz = 0.2): Promise<boolean> {
    return this.toggleRotation(rotationHz);
  }

  public async setRotation(rotation: RotationFilterData | null): Promise<FilterManager> {
    this.data.rotation = rotation ? { ...rotation } : null;
    await this.applyPlayerFilters();
    return this;
  }

  public async toggleVibrato(frequency = 10, depth = 1): Promise<boolean> {
    const enable = !this.filters.vibrato;
    this.data.vibrato = enable ? { frequency, depth } : null;
    await this.applyPlayerFilters();
    return this.filters.vibrato;
  }

  public async setVibrato(vibrato: VibratoFilterData | null): Promise<FilterManager> {
    this.data.vibrato = vibrato ? { ...vibrato } : null;
    await this.applyPlayerFilters();
    return this;
  }

  public async toggleTremolo(frequency = 4, depth = 0.8): Promise<boolean> {
    const enable = !this.filters.tremolo;
    this.data.tremolo = enable ? { frequency, depth } : null;
    await this.applyPlayerFilters();
    return this.filters.tremolo;
  }

  public async setTremolo(tremolo: TremoloFilterData | null): Promise<FilterManager> {
    this.data.tremolo = tremolo ? { ...tremolo } : null;
    await this.applyPlayerFilters();
    return this;
  }

  public async toggleLowPass(smoothing = 20): Promise<boolean> {
    const enable = !this.filters.lowPass;
    this.data.lowPass = enable ? { smoothing } : null;
    await this.applyPlayerFilters();
    return this.filters.lowPass;
  }

  public async setLowPass(lowPass: LowPassFilterData | null): Promise<FilterManager> {
    this.data.lowPass = lowPass ? { ...lowPass } : null;
    await this.applyPlayerFilters();
    return this;
  }

  public async toggleKaraoke(
    level = 1,
    monoLevel = 1,
    filterBand = 220,
    filterWidth = 100
  ): Promise<boolean> {
    const enable = !this.filters.karaoke;
    this.data.karaoke = enable ? { level, monoLevel, filterBand, filterWidth } : null;
    await this.applyPlayerFilters();
    return this.filters.karaoke;
  }

  public async setKaraoke(karaoke: KaraokeFilterData | null): Promise<FilterManager> {
    this.data.karaoke = karaoke ? { ...karaoke } : null;
    await this.applyPlayerFilters();
    return this;
  }

  public async toggleDistortion(
    distortion: DistortionFilterData = {
      sinOffset: 0,
      sinScale: 1,
      cosOffset: 0,
      cosScale: 1,
      tanOffset: 0,
      tanScale: 1,
      offset: 0,
      scale: 1.2,
    }
  ): Promise<boolean> {
    const enable = !this.filters.distortion;
    this.data.distortion = enable ? { ...distortion } : null;
    await this.applyPlayerFilters();
    return this.filters.distortion;
  }

  public async setDistortion(distortion: DistortionFilterData | null): Promise<FilterManager> {
    this.data.distortion = distortion ? { ...distortion } : null;
    await this.applyPlayerFilters();
    return this;
  }

  public async setChannelMix(mix: ChannelMixFilterData | null): Promise<FilterManager> {
    this.data.channelMix = mix ? { ...mix } : null;
    await this.applyPlayerFilters();
    return this;
  }

  /**
   * Sets or removes an arbitrary Lavalink v4 plugin filter entry under `filters.pluginFilters`.
   */
  public async setCustomFilter(pluginName: string, filterData: unknown | null): Promise<FilterManager> {
    this.data.pluginFilters ??= {};
    if (filterData === null || filterData === undefined) {
      delete this.data.pluginFilters[pluginName];
    } else {
      this.data.pluginFilters[pluginName] = filterData;
    }
    await this.applyPlayerFilters();
    return this;
  }
}

export { FilterManager as MocylinkFilterManager };
