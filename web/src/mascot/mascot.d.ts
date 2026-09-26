// Types for the mascot module (copied from slides/world/mascot/mascot.js, owned by the world agent).
export type MascotClip = 'idle' | 'walk' | 'dance' | 'think' | 'cheer' | 'wave';
export type Mascot = {
  root: import('three').Object3D;
  names: MascotClip[];
  current: MascotClip;
  play(name: MascotClip, opts?: { loop?: boolean; fade?: number }): void;
  update(dt: number): void;
  dispose(): void;
};
export function createMascot(THREE: typeof import('three'), opts?: { smoke?: boolean; shadows?: boolean; scale?: number }): Mascot;
