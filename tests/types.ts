import type { FileStat } from '@/types';

type VirtualFile = {
  type: 'file';
  path: string;
  stat: FileStat;
  content: string;
};

type VirtualDirectory = {
  type: 'directory';
  path: string;
  stat: FileStat;
  children: Array<VirtualFile | VirtualDirectory>;
};

type VirtualMetadata = {
  type: 'extended';
  size: number;
};

export type { VirtualFile, VirtualDirectory, VirtualMetadata };
