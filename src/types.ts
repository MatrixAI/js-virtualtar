type FileType = 'file' | 'directory' | 'extended';

enum EntryType {
  FILE = '0',
  DIRECTORY = '5',
  EXTENDED = 'x',
}

type MetadataKeywords = 'path';

type FileStat = {
  size?: number;
  mode?: number;
  mtime?: Date;
  uid?: number;
  gid?: number;
  uname?: string;
  gname?: string;
};

type TokenHeader = {
  type: 'header';
  fileType: FileType;
  filePath: string;
  fileMode: number;
  ownerUid: number;
  ownerGid: number;
  fileSize: number;
  fileMtime: Date;
  ownerUserName: string;
  ownerGroupName: string;
};

type TokenData = {
  type: 'data';
  data: Uint8Array;
  end: boolean;
};

type TokenEnd = {
  type: 'end';
};

type ParsedFile = {
  type: 'file';
  path: string;
  stat: FileStat;
};

type ParsedDirectory = {
  type: 'directory';
  path: string;
  stat: FileStat;
};

type ParsedExtended = {
  type: 'extended';
};

type ParsedEmpty = {
  type: 'empty';
  awaitingData: boolean;
};

enum ParserState {
  HEADER,
  DATA,
  NULL,
  ENDED,
}

enum GeneratorState {
  HEADER,
  DATA,
  NULL,
  ENDED,
}

export type {
  FileType,
  FileStat,
  TokenHeader,
  TokenData,
  TokenEnd,
  ParsedFile,
  ParsedDirectory,
  ParsedExtended,
  ParsedEmpty,
  MetadataKeywords,
};

export { EntryType, ParserState, GeneratorState };
