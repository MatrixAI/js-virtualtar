import type { Stats } from 'fs';

const EntryTypes = {
  FILE: '0',
  DIRECTORY: '5',
} as const;

type EntryType = (typeof EntryTypes)[keyof typeof EntryTypes];

type DirectoryContent = {
  path: string;
  stat: Stats;
  type: EntryType;
};

type HeaderOptions = {
  fileNameEncoding: 'ascii' | 'utf8';
  blockSize: number;
};

// An actual type for `fs` doesn't exist
type ReadFileOptions = {
  fs: any;
  blockSize: number;
};

// An actual type for `fs` doesn't exist
type WalkDirectoryOptions = {
  fs: any;
  blockSize: number;
};

// An actual type for `fs` doesn't exist
type TarOptions = {
  fs: any;
  blockSize: number;
  fileNameEncoding: 'ascii' | 'utf8';
};

export type {
  EntryType,
  DirectoryContent,
  HeaderOptions,
  ReadFileOptions,
  WalkDirectoryOptions,
  TarOptions,
};

export { EntryTypes };
