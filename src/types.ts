import type { Stats } from 'fs';

const TarTypes = {
  FILE: '0',
  DIRECTORY: '5',
} as const;

type TarType = (typeof TarTypes)[keyof typeof TarTypes];

type DirectoryContent = {
  path: string;
  stat: Stats;
  type: TarType;
};

export type { TarType, DirectoryContent };
export { TarTypes };
